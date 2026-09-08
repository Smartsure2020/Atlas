/**
 * Atlas Phase 5A — deterministic email → submission correlation
 * ----------------------------------------------------------------------------
 * Implements the ordered first-match-wins rules described in the checkpoint
 * spec. The module is intentionally pure: every lookup is delegated through
 * the `CorrelationLookups` interface so tests can drive it with in-memory
 * fixtures without a live database.
 *
 *   Rule 1  mailbox + graph_message_id → duplicate
 *   Rule 2  internet_message_id        → duplicate (cross-mailbox)
 *   Rule 3  conversation_id → exactly one open submission → attach
 *   Rule 4  conversation_id → >1 open submissions          → needs_review
 *   Rule 5  reply-header (In-Reply-To / References)
 *           unambiguous open  → attach
 *           ambiguous         → needs_review
 *   Rule 6  no signal → create new submission
 *
 * DO NOT ADD:
 *   * fuzzy subject match
 *   * normalised Re:/FW: subject match
 *   * sender address alone
 *   * broker/client name similarity
 *   * email-domain similarity
 *   * LLM judgment
 *
 * Wrong attachment is more serious than duplicate operational work.
 */

/** Terminal stages excluded from the "open submission" universe. */
const TERMINAL_STAGES = new Set(["bound", "declined", "lost"]);

export interface OpenSubmissionRef {
  id: string;
  pipeline_stage: string | null;
}

/** Small side-effect-free interface for the lookups the rules need. */
export interface CorrelationLookups {
  /** Rule 1: has this (mailbox, graph_message_id) already been ingested? */
  findByGraphMessageId(
    mailbox: string,
    graphMessageId: string,
  ): Promise<{ id: string; submission_id: string } | null>;

  /** Rule 2: has any mailbox ever seen this RFC 5322 Message-Id? */
  findByInternetMessageId(
    internetMessageId: string,
  ): Promise<{ id: string; submission_id: string } | null>;

  /**
   * Rule 3/4: submissions that share this conversation_id. The caller filters
   * for open/closed status; every candidate is returned with pipeline_stage so
   * this module can classify OPEN vs TERMINAL without leaking terminal cases.
   */
  findSubmissionsByConversationId(conversationId: string): Promise<OpenSubmissionRef[]>;

  /**
   * Rule 5: given a set of parent Message-Ids (from In-Reply-To + References),
   * return the intake messages we already have that carry any of them, along
   * with their submission's current pipeline_stage.
   */
  findByParentMessageIds(
    messageIds: string[],
  ): Promise<Array<{ submission_id: string; pipeline_stage: string | null }>>;
}

export type CorrelationRule =
  | "duplicate_graph_message_id"
  | "duplicate_internet_message_id"
  | "conversation_single_open"
  | "conversation_multiple_open_needs_review"
  | "reply_header_single_open"
  | "reply_header_ambiguous_needs_review"
  | "new_submission";

export type CorrelationOutcome =
  | { kind: "duplicate"; rule: "duplicate_graph_message_id" | "duplicate_internet_message_id"; existingIntakeId: string; submissionId: string }
  | { kind: "attach"; rule: "conversation_single_open" | "reply_header_single_open"; submissionId: string }
  | { kind: "needs_review"; rule: "conversation_multiple_open_needs_review" | "reply_header_ambiguous_needs_review"; candidateSubmissionIds: string[] }
  | { kind: "new_submission"; rule: "new_submission" };

export interface CorrelationInput {
  mailbox: string;
  graphMessageId: string;
  internetMessageId: string | null;
  conversationId: string | null;
  /** Optional parent chain from In-Reply-To + References; case-preserved. */
  parentMessageIds: string[];
}

function isOpen(ref: OpenSubmissionRef): boolean {
  const stage = ref.pipeline_stage;
  if (stage == null) return false;
  return !TERMINAL_STAGES.has(stage);
}

/** Deduplicate while preserving insertion order. */
function unique<T>(values: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Apply the ordered correlation rules. First-match-wins semantics — the
 * caller must not attempt any later rule after a match is returned.
 */
export async function correlate(
  input: CorrelationInput,
  lookups: CorrelationLookups,
): Promise<CorrelationOutcome> {
  // Rule 1 — per-mailbox duplicate suppression.
  const gDup = await lookups.findByGraphMessageId(input.mailbox, input.graphMessageId);
  if (gDup) {
    return {
      kind: "duplicate",
      rule: "duplicate_graph_message_id",
      existingIntakeId: gDup.id,
      submissionId: gDup.submission_id,
    };
  }

  // Rule 2 — cross-mailbox duplicate suppression by Message-Id.
  if (input.internetMessageId) {
    const iDup = await lookups.findByInternetMessageId(input.internetMessageId);
    if (iDup) {
      return {
        kind: "duplicate",
        rule: "duplicate_internet_message_id",
        existingIntakeId: iDup.id,
        submissionId: iDup.submission_id,
      };
    }
  }

  // Rule 3 / 4 — conversation match. Terminal submissions are ignored: a
  // conversation that ended (bound / declined / lost) must not adopt a new
  // reply as though the case were still open.
  if (input.conversationId) {
    const convo = await lookups.findSubmissionsByConversationId(input.conversationId);
    const openCandidates = unique(convo.filter(isOpen).map((s) => s.id));
    if (openCandidates.length === 1) {
      return {
        kind: "attach",
        rule: "conversation_single_open",
        submissionId: openCandidates[0],
      };
    }
    if (openCandidates.length > 1) {
      return {
        kind: "needs_review",
        rule: "conversation_multiple_open_needs_review",
        candidateSubmissionIds: openCandidates,
      };
    }
  }

  // Rule 5 — reply-header parent chain.
  if (input.parentMessageIds.length > 0) {
    const parents = await lookups.findByParentMessageIds(input.parentMessageIds);
    const openIds = unique(
      parents
        .filter((row): row is { submission_id: string; pipeline_stage: string | null } =>
          Boolean(row?.submission_id),
        )
        .filter((row) => isOpen({ id: row.submission_id, pipeline_stage: row.pipeline_stage }))
        .map((row) => row.submission_id),
    );
    if (openIds.length === 1) {
      return {
        kind: "attach",
        rule: "reply_header_single_open",
        submissionId: openIds[0],
      };
    }
    if (openIds.length > 1) {
      return {
        kind: "needs_review",
        rule: "reply_header_ambiguous_needs_review",
        candidateSubmissionIds: openIds,
      };
    }
  }

  // Rule 6 — nothing correlated. A brand-new email submission.
  return { kind: "new_submission", rule: "new_submission" };
}

/**
 * Public re-export used by the orchestrator to keep the terminal-stage
 * predicate in one place. Also useful for tests that assert the invariant.
 */
export function isTerminalPipelineStage(stage: string | null | undefined): boolean {
  return stage != null && TERMINAL_STAGES.has(stage);
}
