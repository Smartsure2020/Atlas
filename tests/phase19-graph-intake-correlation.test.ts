/**
 * Phase 19 (Phase 5A) — Deterministic correlation rules
 * ---------------------------------------------------------------------------
 * Table-driven checks against the pure `correlate()` function. Each test
 * builds a small in-memory lookups fixture and asserts first-match-wins
 * behaviour of the six rules described in the checkpoint spec.
 */

import {
  correlate,
  isTerminalPipelineStage,
  type CorrelationLookups,
  type OpenSubmissionRef,
} from "../worker/src/graph-intake-correlation.js";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
function eq<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface FixtureIntakeRow {
  id: string;
  submission_id: string;
  mailbox: string | null;
  graph_message_id: string | null;
  internet_message_id: string | null;
  conversation_id: string | null;
}
interface FixtureSubmission {
  id: string;
  pipeline_stage: string | null;
}

function buildLookups(input: {
  intake?: FixtureIntakeRow[];
  submissions?: FixtureSubmission[];
}): CorrelationLookups {
  const intake = input.intake ?? [];
  const submissions = new Map((input.submissions ?? []).map((s) => [s.id, s.pipeline_stage] as const));
  return {
    async findByGraphMessageId(mailbox, graphMessageId) {
      const hit = intake.find(
        (r) => r.mailbox === mailbox && r.graph_message_id === graphMessageId,
      );
      return hit ? { id: hit.id, submission_id: hit.submission_id } : null;
    },
    async findByInternetMessageId(internetMessageId) {
      const hit = intake.find((r) => r.internet_message_id === internetMessageId);
      return hit ? { id: hit.id, submission_id: hit.submission_id } : null;
    },
    async findSubmissionsByConversationId(conversationId) {
      const seen = new Set<string>();
      const out: OpenSubmissionRef[] = [];
      for (const row of intake) {
        if (row.conversation_id !== conversationId) continue;
        if (seen.has(row.submission_id)) continue;
        seen.add(row.submission_id);
        out.push({ id: row.submission_id, pipeline_stage: submissions.get(row.submission_id) ?? null });
      }
      return out;
    },
    async findByParentMessageIds(messageIds) {
      const set = new Set(messageIds);
      const seen = new Set<string>();
      const out: Array<{ submission_id: string; pipeline_stage: string | null }> = [];
      for (const row of intake) {
        if (!row.internet_message_id || !set.has(row.internet_message_id)) continue;
        if (seen.has(row.submission_id)) continue;
        seen.add(row.submission_id);
        out.push({ submission_id: row.submission_id, pipeline_stage: submissions.get(row.submission_id) ?? null });
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Rule 1 — same mailbox + same Graph id
// ---------------------------------------------------------------------------

test("Rule 1: same mailbox + same graph_message_id => duplicate", async () => {
  const lookups = buildLookups({
    intake: [
      { id: "i-1", submission_id: "s-1", mailbox: "intake@atlas", graph_message_id: "g-1", internet_message_id: "im-1", conversation_id: "c-1" },
    ],
    submissions: [{ id: "s-1", pipeline_stage: "new" }],
  });
  const outcome = await correlate(
    { mailbox: "intake@atlas", graphMessageId: "g-1", internetMessageId: null, conversationId: null, parentMessageIds: [] },
    lookups,
  );
  eq(outcome.kind, "duplicate", "kind");
  if (outcome.kind === "duplicate") eq(outcome.rule, "duplicate_graph_message_id", "rule");
});

// ---------------------------------------------------------------------------
// Rule 2 — cross-mailbox internetMessageId
// ---------------------------------------------------------------------------

test("Rule 2: same internet_message_id => duplicate (cross-mailbox)", async () => {
  const lookups = buildLookups({
    intake: [
      { id: "i-1", submission_id: "s-1", mailbox: "intake-a@atlas", graph_message_id: "g-a", internet_message_id: "im-1", conversation_id: null },
    ],
    submissions: [{ id: "s-1", pipeline_stage: "new" }],
  });
  const outcome = await correlate(
    { mailbox: "intake-b@atlas", graphMessageId: "g-b", internetMessageId: "im-1", conversationId: null, parentMessageIds: [] },
    lookups,
  );
  eq(outcome.kind, "duplicate", "kind");
  if (outcome.kind === "duplicate") eq(outcome.rule, "duplicate_internet_message_id", "rule");
});

// ---------------------------------------------------------------------------
// Rule 3 — one open conversation match
// ---------------------------------------------------------------------------

test("Rule 3: single open conversation match => attach", async () => {
  const lookups = buildLookups({
    intake: [
      { id: "i-1", submission_id: "s-1", mailbox: "mbx", graph_message_id: "g-old", internet_message_id: "im-old", conversation_id: "c-abc" },
    ],
    submissions: [{ id: "s-1", pipeline_stage: "in_progress" }],
  });
  const outcome = await correlate(
    { mailbox: "mbx", graphMessageId: "g-new", internetMessageId: "im-new", conversationId: "c-abc", parentMessageIds: [] },
    lookups,
  );
  eq(outcome.kind, "attach", "kind");
  if (outcome.kind === "attach") {
    eq(outcome.rule, "conversation_single_open", "rule");
    eq(outcome.submissionId, "s-1", "submission");
  }
});

// ---------------------------------------------------------------------------
// Rule 3.5 — one TERMINAL conversation match => do NOT attach as open
// ---------------------------------------------------------------------------

test("Terminal conversation match does not attach as open", async () => {
  for (const terminal of ["bound", "declined", "lost"] as const) {
    const lookups = buildLookups({
      intake: [
        { id: "i-1", submission_id: "s-1", mailbox: "mbx", graph_message_id: "g-old", internet_message_id: "im-old", conversation_id: "c-t" },
      ],
      submissions: [{ id: "s-1", pipeline_stage: terminal }],
    });
    const outcome = await correlate(
      { mailbox: "mbx", graphMessageId: "g-new", internetMessageId: "im-new", conversationId: "c-t", parentMessageIds: [] },
      lookups,
    );
    eq(outcome.kind, "new_submission", `terminal ${terminal}`);
  }
});

// ---------------------------------------------------------------------------
// Rule 4 — multiple open conversation matches => needs_review
// ---------------------------------------------------------------------------

test("Rule 4: multiple open conversation matches => needs_review", async () => {
  const lookups = buildLookups({
    intake: [
      { id: "i-a", submission_id: "s-a", mailbox: "mbx", graph_message_id: "g-a", internet_message_id: "im-a", conversation_id: "c-multi" },
      { id: "i-b", submission_id: "s-b", mailbox: "mbx", graph_message_id: "g-b", internet_message_id: "im-b", conversation_id: "c-multi" },
    ],
    submissions: [
      { id: "s-a", pipeline_stage: "in_progress" },
      { id: "s-b", pipeline_stage: "quoted" },
    ],
  });
  const outcome = await correlate(
    { mailbox: "mbx", graphMessageId: "g-new", internetMessageId: "im-new", conversationId: "c-multi", parentMessageIds: [] },
    lookups,
  );
  eq(outcome.kind, "needs_review", "kind");
  if (outcome.kind === "needs_review") {
    eq(outcome.rule, "conversation_multiple_open_needs_review", "rule");
    assert(outcome.candidateSubmissionIds.includes("s-a"), "s-a in candidates");
    assert(outcome.candidateSubmissionIds.includes("s-b"), "s-b in candidates");
  }
});

// ---------------------------------------------------------------------------
// Rule 5 — reply header unambiguous
// ---------------------------------------------------------------------------

test("Rule 5: reply-header unambiguous open match => attach", async () => {
  const lookups = buildLookups({
    intake: [
      { id: "i-1", submission_id: "s-1", mailbox: "mbx", graph_message_id: "g-1", internet_message_id: "parent-1", conversation_id: null },
    ],
    submissions: [{ id: "s-1", pipeline_stage: "assigned" }],
  });
  const outcome = await correlate(
    { mailbox: "mbx", graphMessageId: "g-new", internetMessageId: "im-new", conversationId: null, parentMessageIds: ["parent-1"] },
    lookups,
  );
  eq(outcome.kind, "attach", "kind");
  if (outcome.kind === "attach") eq(outcome.rule, "reply_header_single_open", "rule");
});

test("Rule 5: reply-header ambiguous open => needs_review", async () => {
  const lookups = buildLookups({
    intake: [
      { id: "i-1", submission_id: "s-1", mailbox: "mbx", graph_message_id: "g-1", internet_message_id: "parent-1", conversation_id: null },
      { id: "i-2", submission_id: "s-2", mailbox: "mbx", graph_message_id: "g-2", internet_message_id: "parent-2", conversation_id: null },
    ],
    submissions: [
      { id: "s-1", pipeline_stage: "in_progress" },
      { id: "s-2", pipeline_stage: "quoted" },
    ],
  });
  const outcome = await correlate(
    { mailbox: "mbx", graphMessageId: "g-new", internetMessageId: "im-new", conversationId: null, parentMessageIds: ["parent-1", "parent-2"] },
    lookups,
  );
  eq(outcome.kind, "needs_review", "kind");
  if (outcome.kind === "needs_review") eq(outcome.rule, "reply_header_ambiguous_needs_review", "rule");
});

// ---------------------------------------------------------------------------
// Rule 6 — no signal
// ---------------------------------------------------------------------------

test("Rule 6: no correlation signal => new_submission", async () => {
  const lookups = buildLookups({ intake: [], submissions: [] });
  const outcome = await correlate(
    { mailbox: "mbx", graphMessageId: "g-x", internetMessageId: "im-x", conversationId: "c-x", parentMessageIds: [] },
    lookups,
  );
  eq(outcome.kind, "new_submission", "kind");
});

// ---------------------------------------------------------------------------
// Forbidden correlations
// ---------------------------------------------------------------------------

test("Sender-only similarity is NOT correlated", async () => {
  // Lookups return nothing for any deterministic query — the sender is
  // simply not part of the correlation contract. The result must be a
  // brand-new submission regardless of any hypothetical sender overlap.
  const lookups = buildLookups({ intake: [], submissions: [] });
  const outcome = await correlate(
    { mailbox: "mbx", graphMessageId: "g-x", internetMessageId: "im-x", conversationId: null, parentMessageIds: [] },
    lookups,
  );
  eq(outcome.kind, "new_submission", "kind");
});

test("Subject similarity is NOT correlated", async () => {
  const lookups = buildLookups({ intake: [], submissions: [] });
  const outcome = await correlate(
    { mailbox: "mbx", graphMessageId: "g-x", internetMessageId: "im-x", conversationId: null, parentMessageIds: [] },
    lookups,
  );
  eq(outcome.kind, "new_submission", "kind");
});

// ---------------------------------------------------------------------------
// isTerminalPipelineStage helper
// ---------------------------------------------------------------------------

test("terminal helper: bound/declined/lost only", () => {
  eq(isTerminalPipelineStage("bound"), true, "bound");
  eq(isTerminalPipelineStage("declined"), true, "declined");
  eq(isTerminalPipelineStage("lost"), true, "lost");
  for (const s of ["new", "triaged", "assigned", "in_progress", "quoted"]) {
    eq(isTerminalPipelineStage(s), false, `open ${s}`);
  }
  eq(isTerminalPipelineStage(null), false, "null");
  eq(isTerminalPipelineStage(undefined), false, "undefined");
});

// ---------------------------------------------------------------------------
// First-match-wins ordering
// ---------------------------------------------------------------------------

test("Rule 1 wins over conflicting conversation match", async () => {
  const lookups = buildLookups({
    intake: [
      { id: "i-1", submission_id: "s-1", mailbox: "mbx", graph_message_id: "g-1", internet_message_id: "im-1", conversation_id: "c-1" },
      { id: "i-2", submission_id: "s-2", mailbox: "mbx", graph_message_id: "g-2", internet_message_id: "im-2", conversation_id: "c-1" },
    ],
    submissions: [
      { id: "s-1", pipeline_stage: "in_progress" },
      { id: "s-2", pipeline_stage: "quoted" },
    ],
  });
  // Even though this graph id would ambiguously conversation-match two open
  // submissions, Rule 1 short-circuits.
  const outcome = await correlate(
    { mailbox: "mbx", graphMessageId: "g-1", internetMessageId: null, conversationId: "c-1", parentMessageIds: [] },
    lookups,
  );
  eq(outcome.kind, "duplicate", "kind");
  if (outcome.kind === "duplicate") eq(outcome.rule, "duplicate_graph_message_id", "rule");
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ ${t.name}: ${(e as Error).message}`);
      failed++;
    }
  }
  console.log(`\nPhase 19 correlation: ${passed} passed, ${failed} failed out of ${tests.length}`);
  if (failed > 0 && typeof process !== "undefined") process.exitCode = 1;
})();
