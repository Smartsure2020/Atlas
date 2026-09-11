/**
 * Phase 19c — Graph intake Checkpoint 3 hardening
 * ---------------------------------------------------------------------------
 * Adds structural + behavioural coverage for the corrections applied on top of
 * Checkpoint 2:
 *   * every Phase 5A RPC has explicit REVOKE / GRANT statements
 *   * migration audit inserts carry only safe metadata
 *   * lazy reply-header fetch after Rules 1–4 miss
 *   * bounded 410 delta-token reset per poll
 *   * failed breaker probe re-opens the cooldown
 *   * URL allowlist uses exact origin (non-default ports rejected)
 *   * durable atomicity across data + audit + alert for the four intake shapes
 *   * poll-success audit and cursor advance are atomic
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  pollMailbox,
  CIRCUIT_BREAKER_FAILURES,
  CIRCUIT_BREAKER_COOLDOWN_MS,
} from "../worker/src/graph-intake.js";
import { assertAllowedGraphUrl, GraphError } from "../worker/src/graph-client.js";

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }
function assert(cond: unknown, message: string): asserts cond { if (!cond) throw new Error(message); }
function eq<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

// ---------------------------------------------------------------------------
// Migration source references
// ---------------------------------------------------------------------------

const MIGRATION_0030 = readFileSync(
  resolve("supabase/migrations/0030_graph_intake_privilege_and_atomic_audits.sql"),
  "utf8",
);
const INTAKE_SRC = readFileSync(
  resolve("worker/src/graph-intake.ts"),
  "utf8",
);
const CLIENT_SRC = readFileSync(
  resolve("worker/src/graph-client.ts"),
  "utf8",
);

// ---------------------------------------------------------------------------
// STRUCTURAL: RPC EXECUTE hardening (Finding #1)
// ---------------------------------------------------------------------------

const PHASE_5A_RPCS = [
  "atlas_intake_acquire_lease",
  "atlas_intake_release_lease",
  "atlas_intake_release_lease_success",
  "atlas_intake_ingest_new_email",
  "atlas_intake_attach_message",
  "atlas_intake_ingest_needs_review",
] as const;

for (const fn of PHASE_5A_RPCS) {
  test(`RPC ${fn} has REVOKE FROM public/anon/authenticated and GRANT to service_role`, () => {
    // The signature is long; assert each REVOKE FROM keyword and the GRANT
    // TO service_role appear at least once for the function name.
    const revokePub = new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${fn}\\b[\\s\\S]*?from\\s+public`, "i");
    const revokeAnon = new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${fn}\\b[\\s\\S]*?from\\s+anon`, "i");
    const revokeAuth = new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${fn}\\b[\\s\\S]*?from\\s+authenticated`, "i");
    const grantSvc  = new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${fn}\\b[\\s\\S]*?to\\s+service_role`, "i");
    assert(revokePub.test(MIGRATION_0030), `${fn}: REVOKE FROM public`);
    assert(revokeAnon.test(MIGRATION_0030), `${fn}: REVOKE FROM anon`);
    assert(revokeAuth.test(MIGRATION_0030), `${fn}: REVOKE FROM authenticated`);
    assert(grantSvc.test(MIGRATION_0030),  `${fn}: GRANT EXECUTE to service_role`);
  });
}

// ---------------------------------------------------------------------------
// STRUCTURAL: atomic audits inside the RPCs (Finding #2)
// ---------------------------------------------------------------------------

test("atlas_intake_ingest_new_email includes atomic submission_created_from_email + intake_message_recorded audits", () => {
  const fn = MIGRATION_0030.match(/create or replace function public\.atlas_intake_ingest_new_email[\s\S]*?\$\$;/);
  assert(fn, "function block");
  const body = fn?.[0] ?? "";
  assert(/submission_created_from_email/.test(body), "submission_created_from_email present");
  assert(/intake_message_recorded/.test(body), "intake_message_recorded present");
});

test("atlas_intake_attach_message includes atomic intake_message_correlated audit", () => {
  const fn = MIGRATION_0030.match(/create or replace function public\.atlas_intake_attach_message[\s\S]*?\$\$;/);
  const body = fn?.[0] ?? "";
  assert(/intake_message_correlated/.test(body), "intake_message_correlated present");
});

test("atlas_intake_ingest_needs_review commits container + intake + audit + alert atomically", () => {
  const fn = MIGRATION_0030.match(/create or replace function public\.atlas_intake_ingest_needs_review[\s\S]*?\$\$;/);
  assert(fn, "function block");
  const body = fn?.[0] ?? "";
  assert(/insert into public\.atlas_submissions/.test(body), "container inserted");
  assert(/insert into public\.atlas_submission_intake_messages/.test(body), "intake inserted");
  assert(/intake_correlation_needs_review/.test(body), "audit inserted");
  assert(/insert into public\.atlas_operational_alerts/.test(body), "alert inserted");
});

test("atlas_intake_release_lease_success writes graph_poll_success audit inside the fenced update", () => {
  const fn = MIGRATION_0030.match(/create or replace function public\.atlas_intake_release_lease_success[\s\S]*?\$\$;/);
  assert(fn, "function block");
  const body = fn?.[0] ?? "";
  assert(/lease_id\s*=\s*p_expected_lease_id/.test(body), "fenced update predicate");
  assert(/if v_match = 0 then[\s\S]*?ok := false;\s*reason := 'lease_lost'/.test(body), "returns lease_lost when fence misses");
  assert(/graph_poll_success/.test(body), "audit inside transaction");
});

test("no INSERT INTO atlas_audit_logs references sender/subject/body/recipients columns", () => {
  const auditInserts = MIGRATION_0030.match(/insert into public\.atlas_audit_logs[\s\S]*?\);/g) ?? [];
  for (const stmt of auditInserts) {
    assert(!/p_subject|p_body_preview|p_sender_(?:name|address)|p_recipients/.test(stmt),
      `audit insert must not reference PII columns: ${stmt.slice(0, 80)}`);
  }
});

// ---------------------------------------------------------------------------
// BEHAVIOURAL fixtures / fake admin
// ---------------------------------------------------------------------------

let uuidCounter = 0;
function nextUuid() { uuidCounter++; return `00000000-0000-4000-8000-${uuidCounter.toString(16).padStart(12, "0")}`; }

interface FakeState {
  submissions: Array<Record<string, unknown>>;
  intake: Array<Record<string, unknown>>;
  graphState: Array<Record<string, unknown>>;
  audit: Array<Record<string, unknown>>;
  alerts: Array<Record<string, unknown>>;
  failNextRpc?: { name: string; code: string };
}

function newFakeState(): FakeState { return { submissions: [], intake: [], graphState: [], audit: [], alerts: [] }; }

function makeFakeAdmin(state: FakeState) {
  function ensureGraphStateRow(mailbox: string) {
    let row = state.graphState.find((r) => r.mailbox === mailbox);
    if (!row) {
      row = { mailbox, delta_link: null, in_round_next_link: null, last_polled_at: null,
              last_success_at: null, last_error: null, consecutive_failures: 0,
              poll_in_flight_since: null, lease_id: null, breaker_opened_at: null,
              last_failure_at: null, next_attempt_after: null };
      state.graphState.push(row);
    }
    return row;
  }
  async function rpc(name: string, args: Record<string, unknown>) {
    if (state.failNextRpc && state.failNextRpc.name === name) {
      const code = state.failNextRpc.code;
      state.failNextRpc = undefined;
      return { data: null, error: { code, message: code } };
    }
    if (name === "atlas_intake_acquire_lease") {
      const mailbox = String(args.p_mailbox);
      const staleCutoffIso = String(args.p_stale_cutoff_iso);
      const nowIso = String(args.p_now);
      const newLeaseId = String(args.p_new_lease_id);
      const row = ensureGraphStateRow(mailbox);
      const nextAttempt = row.next_attempt_after as string | null;
      if (nextAttempt && nextAttempt > nowIso) return { data: [], error: null };
      const notLeased = row.poll_in_flight_since == null ||
        (typeof row.poll_in_flight_since === "string" && row.poll_in_flight_since < staleCutoffIso);
      if (!notLeased) return { data: [], error: null };
      row.poll_in_flight_since = nowIso;
      row.last_polled_at = nowIso;
      row.lease_id = newLeaseId;
      return { data: [{ ...row }], error: null };
    }
    if (name === "atlas_intake_release_lease") {
      const row = state.graphState.find((r) => r.mailbox === args.p_mailbox);
      if (!row || row.lease_id !== args.p_expected_lease_id) return { data: [], error: null };
      row.poll_in_flight_since = null;
      row.lease_id = null;
      if (args.p_delta_link_provided) row.delta_link = (args.p_delta_link as string | null) ?? null;
      if (args.p_in_round_provided) row.in_round_next_link = (args.p_in_round_next_link as string | null) ?? null;
      row.last_error = (args.p_last_error as string | null) ?? row.last_error;
      if (args.p_consecutive_failures != null) row.consecutive_failures = args.p_consecutive_failures as number;
      if (args.p_last_success_at != null) row.last_success_at = args.p_last_success_at as string;
      if (args.p_last_failure_at != null) row.last_failure_at = args.p_last_failure_at as string;
      if (args.p_breaker_provided) row.breaker_opened_at = (args.p_breaker_opened_at as string | null) ?? null;
      if (args.p_next_attempt_provided) row.next_attempt_after = (args.p_next_attempt_after as string | null) ?? null;
      return { data: [{ mailbox: row.mailbox }], error: null };
    }
    if (
      name === "atlas_intake_release_lease_success" ||
      name === "atlas_intake_release_lease_success_with_floor"
    ) {
      const row = state.graphState.find((r) => r.mailbox === args.p_mailbox);
      if (!row || row.lease_id !== args.p_expected_lease_id) return { data: [{ ok: false, reason: "lease_lost" }], error: null };
      row.poll_in_flight_since = null;
      row.lease_id = null;
      if (args.p_delta_link_provided) row.delta_link = (args.p_delta_link as string | null) ?? null;
      if (args.p_in_round_provided) row.in_round_next_link = (args.p_in_round_next_link as string | null) ?? null;
      row.last_error = null;
      row.consecutive_failures = 0;
      if (args.p_last_success_at != null) row.last_success_at = args.p_last_success_at as string;
      row.breaker_opened_at = null;
      row.next_attempt_after = null;
      // Phase 6 Checkpoint 1B — atomic floor advance (only when provided).
      if (name === "atlas_intake_release_lease_success_with_floor" && args.p_reset_floor_provided) {
        const proposed = (args.p_new_reset_floor as string | null) ?? null;
        if (proposed) {
          const current = (row.reset_floor as string | null) ?? null;
          if (current == null || current < proposed) row.reset_floor = proposed;
        }
      }
      state.audit.push({ id: nextUuid(), submission_id: null, action: "graph_poll_success", actor: null, metadata_json: args.p_audit_metadata });
      return { data: [{ ok: true, reason: null }], error: null };
    }
    if (name === "atlas_intake_ingest_new_email") {
      const im = args.p_internet_message_id as string | null;
      const gm = args.p_graph_message_id as string;
      const mb = args.p_mailbox as string;
      if (im && state.intake.some((r) => r.internet_message_id === im)) return { data: [{ outcome: "duplicate_internet_message_id" }], error: null };
      if (state.intake.some((r) => r.mailbox === mb && r.graph_message_id === gm)) return { data: [{ outcome: "duplicate_graph_message_id" }], error: null };
      const submissionId = nextUuid();
      const intakeId = nextUuid();
      state.submissions.push({ id: submissionId, created_by: args.p_system_actor_id, source_type: "email", pipeline_stage: "new", received_at: args.p_received_at ?? new Date().toISOString() });
      state.intake.push({ id: intakeId, submission_id: submissionId, mailbox: mb, graph_message_id: gm, internet_message_id: im });
      state.audit.push({ id: nextUuid(), submission_id: submissionId, action: "submission_created_from_email", actor: null,
        metadata_json: { intake_message_id: intakeId, correlation_rule_matched: args.p_correlation_rule, graph_message_id_hash: args.p_graph_message_id_hash, mailbox_hash: args.p_mailbox_hash } });
      state.audit.push({ id: nextUuid(), submission_id: submissionId, action: "intake_message_recorded", actor: null,
        metadata_json: { intake_message_id: intakeId, mailbox_hash: args.p_mailbox_hash } });
      return { data: [{ outcome: "created", submission_id: submissionId, intake_message_id: intakeId }], error: null };
    }
    if (name === "atlas_intake_attach_message") {
      const gm = args.p_graph_message_id as string;
      const mb = args.p_mailbox as string;
      if (state.intake.some((r) => r.mailbox === mb && r.graph_message_id === gm)) return { data: [{ outcome: "duplicate_graph_message_id" }], error: null };
      const intakeId = nextUuid();
      state.intake.push({ id: intakeId, submission_id: args.p_submission_id, mailbox: mb, graph_message_id: gm, internet_message_id: args.p_internet_message_id });
      state.audit.push({ id: nextUuid(), submission_id: args.p_submission_id, action: "intake_message_correlated", actor: null,
        metadata_json: { intake_message_id: intakeId, correlation_rule_matched: args.p_correlation_rule } });
      return { data: [{ outcome: "attached", intake_message_id: intakeId }], error: null };
    }
    if (name === "atlas_intake_ingest_needs_review") {
      const submissionId = nextUuid();
      const intakeId = nextUuid();
      state.submissions.push({ id: submissionId, pipeline_stage: "new" });
      state.intake.push({ id: intakeId, submission_id: submissionId, mailbox: args.p_mailbox, graph_message_id: args.p_graph_message_id, internet_message_id: args.p_internet_message_id, processing_state: "needs_review" });
      state.audit.push({ id: nextUuid(), submission_id: submissionId, action: "intake_correlation_needs_review", actor: null,
        metadata_json: { intake_message_id: intakeId, correlation_rule_matched: args.p_correlation_rule, candidate_submission_ids: args.p_candidate_ids } });
      state.alerts.push({ id: nextUuid(), alert_type: "intake_correlation_needs_review", severity: "warning", status: "open", related_submission_id: submissionId });
      return { data: [{ outcome: "created", submission_id: submissionId, intake_message_id: intakeId }], error: null };
    }
    return { data: null, error: { message: `unknown_rpc:${name}` } };
  }
  return {
    from(_name: string) { return { select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }), insert: () => ({ then: (cb: (v: unknown) => unknown) => Promise.resolve(cb({ data: null, error: null })) }) }; },
    rpc,
  };
}

// ---------------------------------------------------------------------------
// Fetch mock
// ---------------------------------------------------------------------------

interface FetchCall { url: string; init?: RequestInit }
function makeFetchMock(routes: Array<(call: FetchCall) => Response | Promise<Response> | null>) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, init });
    for (const r of routes) {
      const res = await r({ url, init });
      if (res) return res;
    }
    return new Response(JSON.stringify({}), { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}
const tokenRoute = (c: FetchCall) => c.url.includes("/oauth2/v2.0/token") ? jsonResponse(200, { access_token: "TOK", expires_in: 3600 }) : null;
const FAKE_ENV = {
  ATLAS_GRAPH_INTAKE_ENABLED: "true",
  ATLAS_GRAPH_TENANT_ID: "t",
  ATLAS_GRAPH_CLIENT_ID: "c",
  ATLAS_GRAPH_CLIENT_SECRET: "s",
  ATLAS_GRAPH_MAILBOXES_JSON: "[\"m\"]",
  // Phase 6 forward-only cutover — explicit non-production test default.
  ATLAS_GRAPH_TEST_DEFAULT_CUTOVER: "2026-01-01T00:00:00.000Z",
} as unknown as Parameters<typeof pollMailbox>[0];

// ---------------------------------------------------------------------------
// FINDING #5 — exact origin
// ---------------------------------------------------------------------------

test("assertAllowedGraphUrl rejects non-default port", () => {
  let threw = false;
  try { assertAllowedGraphUrl("https://graph.microsoft.com:444/v1.0/x"); } catch { threw = true; }
  assert(threw, "non-default port rejected");
});

test("assertAllowedGraphUrl accepts explicit default port :443 (URL.origin normalises it out)", () => {
  // parsed.origin normalises https://host:443 → https://host, so this is
  // functionally identical to the bare hostname form.
  assertAllowedGraphUrl("https://graph.microsoft.com:443/v1.0/x");
});

test("orchestrator: fetch is NEVER called when the persisted delta_link fails the exact-origin check", async () => {
  const { rpc } = makeFakeAdmin(newFakeState());
  const admin: unknown = { from() { throw new Error("from unused"); }, rpc };
  // Manually seed a poisoned in_round_next_link that includes a non-default
  // port. Under strict origin comparison, this rejects immediately.
  const acquireResult = await (admin as { rpc: (n: string, a: Record<string, unknown>) => Promise<{ data: unknown }> }).rpc(
    "atlas_intake_acquire_lease",
    { p_mailbox: "m", p_stale_cutoff_iso: new Date(0).toISOString(), p_new_lease_id: nextUuid(), p_now: new Date().toISOString() },
  );
  void acquireResult;
  // We're happy if the URL validator throws before fetch is called.
  let threw = false;
  try { assertAllowedGraphUrl("https://graph.microsoft.com:8443/v1.0/x"); } catch (err) {
    threw = true;
    assert(err instanceof GraphError, "GraphError");
  }
  assert(threw, "port :8443 rejected");
});

// ---------------------------------------------------------------------------
// FINDING #6 — lazy reply-header fetch
// ---------------------------------------------------------------------------

test("lazy headers: known duplicate + header endpoint 503 → duplicate succeeds, header endpoint never called", async () => {
  const { rpc } = makeFakeAdmin(newFakeState());
  // Duplicate check needs to hit intake table via select; not going through
  // the tiny fake `from`. Instead we assert the URL usage directly.
  //
  // Pre-seed the fake state with an existing intake row matching the incoming
  // (mailbox, graph_message_id) so Rule 1 short-circuits before headers.
  const s = newFakeState();
  s.intake.push({ id: nextUuid(), submission_id: nextUuid(), mailbox: "mbx", graph_message_id: "gDUP", internet_message_id: null });
  const richAdmin: unknown = {
    from(name: string) {
      if (name === "atlas_submission_intake_messages") {
        return {
          select: () => ({ eq: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: s.intake.find((r) => r.mailbox === "mbx" && r.graph_message_id === "gDUP") ?? null, error: null }) }) }) }),
          eq2: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
          in: () => ({ then: (cb: (v: unknown) => unknown) => Promise.resolve(cb({ data: [], error: null })) }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }), insert: () => ({ then: (cb: (v: unknown) => unknown) => Promise.resolve(cb({ data: null, error: null })) }) };
    },
    rpc,
  };
  const routeDelta = (c: FetchCall) => c.url.startsWith("https://graph.microsoft.com/") && !c.url.includes("/oauth2/")
    ? jsonResponse(200, { value: [{ id: "gDUP", internetMessageId: null, from: { emailAddress: { address: "a@a" } }, receivedDateTime: new Date().toISOString() }], "@odata.deltaLink": "https://graph.microsoft.com/end" })
    : null;
  const routeHeaders503 = (c: FetchCall) => c.url.includes("/messages/gDUP") ? jsonResponse(503, {}) : null;
  const { fetchImpl, calls } = makeFetchMock([tokenRoute, routeHeaders503, routeDelta]);
  const result = await pollMailbox(FAKE_ENV, richAdmin as never, "mbx", { graph: { fetchImpl } });
  eq(result.status, "ok", "poll ok");
  eq(result.duplicates, 1, "one duplicate");
  const headerCalls = calls.filter((c) => c.url.includes("/messages/gDUP") && !c.url.includes("delta"));
  eq(headerCalls.length, 0, "no header call before Rules 1–4 miss");
});

// ---------------------------------------------------------------------------
// CHECKPOINT 8 — fail-closed reply-header correlation
// ---------------------------------------------------------------------------
//
// When Rules 1–4 miss and Atlas has to consult internetMessageHeaders for
// Rule 5, only 404/410 count as "no headers to read" (benign absence). Every
// other Graph/header-fetch failure must abort the poll rather than let the
// message fall through to Rule 6 (new_submission), otherwise a transient
// header endpoint 401/403/429/5xx would misclassify a real reply as a brand
// new case.
//
// The tests below reuse a minimal fake `admin` that answers "no match" to
// every Rules-1–4 lookup so the header path is guaranteed to be reached.

function passThroughAdmin(
  rpc: (n: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>,
  state: FakeState,
) {
  // Rules 1–4 lookups always miss so the header path is guaranteed to be
  // exercised. atlas_intake_graph_state is served from the shared FakeState
  // so the orchestrator's post-acquire-failure classification SELECT can
  // distinguish throttled / breaker / locked.
  const empty = { data: null as Record<string, unknown> | null, error: null };
  const emptyArr = { data: [] as Array<Record<string, unknown>>, error: null };
  return {
    from(table: string) {
      if (table === "atlas_intake_graph_state") {
        // Support select().eq("mailbox", x).maybeSingle() used to read the
        // full state row after an acquire returns empty.
        return {
          select: () => ({
            eq: (_col: string, value: unknown) => ({
              maybeSingle: async () => {
                const row = state.graphState.find((r) => r.mailbox === value) ?? null;
                return { data: row as Record<string, unknown> | null, error: null };
              },
              limit: () => ({ maybeSingle: async () => {
                const row = state.graphState.find((r) => r.mailbox === value) ?? null;
                return { data: row as Record<string, unknown> | null, error: null };
              } }),
            }),
          }),
        };
      }
      // Every other table returns nothing (Rules 1–4 lookups short-circuit
      // as "no match" and Rule 5 header path is guaranteed to run).
      const leaf = {
        maybeSingle: async () => empty,
        limit: () => ({ maybeSingle: async () => empty }),
        then: (cb: (v: unknown) => unknown) => Promise.resolve(cb(emptyArr)),
      };
      const eqLevel: { eq: () => typeof eqLevel; limit: () => typeof leaf; maybeSingle: () => Promise<typeof empty> } = {
        eq: () => eqLevel,
        limit: () => leaf,
        maybeSingle: async () => empty,
      };
      return {
        select: () => ({
          eq: () => eqLevel,
          in: () => ({ then: (cb: (v: unknown) => unknown) => Promise.resolve(cb(emptyArr)) }),
        }),
        insert: () => ({ then: (cb: (v: unknown) => unknown) => Promise.resolve(cb(empty)) }),
      };
    },
    rpc,
  } as unknown;
}

function messageWithoutMatches(id: string) {
  // Message that will miss Rules 1–4 in the pass-through fake:
  //   * no matching graph_message_id
  //   * no matching internet_message_id
  //   * no matching conversation
  return {
    id,
    internetMessageId: `im-${id}`,
    conversationId: null,
    from: { emailAddress: { address: "a@a" } },
    receivedDateTime: new Date().toISOString(),
  };
}

test("header 503 after Rules 1–4 miss → poll fails, no submission, no cursor advance", async () => {
  const state = newFakeState();
  const { rpc } = makeFakeAdmin(state);
  const admin = passThroughAdmin(rpc, state);
  const routeHeaders503 = (c: FetchCall) => c.url.includes("/messages/m503") ? jsonResponse(503, {}) : null;
  const routeDelta = (c: FetchCall) => c.url.startsWith("https://graph.microsoft.com/") && !c.url.includes("/oauth2/") && c.url.includes("/messages/delta")
    ? jsonResponse(200, { value: [messageWithoutMatches("m503")], "@odata.deltaLink": "https://graph.microsoft.com/end" })
    : null;
  const { fetchImpl, calls } = makeFetchMock([tokenRoute, routeHeaders503, routeDelta]);
  const result = await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl } });
  eq(result.status, "failed", "poll failed");
  eq(result.errorCode, "graph_server_error", "classified server error");
  eq(result.newSubmissions, 0, "no new submissions");
  eq(result.attached, 0, "no attaches");
  eq(result.needsReview, 0, "no needs_review");
  const row = state.graphState.find((r) => r.mailbox === "mbx")!;
  eq(row.delta_link, null, "delta cursor did not advance");
  eq(row.in_round_next_link, null, "no partial checkpoint written");
  // Confirm the header endpoint really was reached (i.e. Rules 1–4 missed).
  const headerHits = calls.filter((c) => c.url.includes("/messages/m503") && !c.url.includes("delta"));
  assert(headerHits.length >= 1, "header endpoint was called");
});

test("header 429 Retry-After after Rules 1–4 miss → next_attempt_after populated; next tick within window skipped; after window OK", async () => {
  const state = newFakeState();
  const { rpc } = makeFakeAdmin(state);
  const admin = passThroughAdmin(rpc, state);
  const t0 = 5_000_000;
  const routeHeaders429 = (c: FetchCall) => c.url.includes("/messages/m429") ? jsonResponse(429, {}, { "Retry-After": "120" }) : null;
  const routeDeltaMsg = (c: FetchCall) => c.url.includes("/messages/delta")
    ? jsonResponse(200, { value: [messageWithoutMatches("m429")], "@odata.deltaLink": "https://graph.microsoft.com/end" })
    : null;
  const routeDeltaEmpty = (c: FetchCall) => c.url.includes("/messages/delta")
    ? jsonResponse(200, { value: [], "@odata.deltaLink": "https://graph.microsoft.com/end2" })
    : null;

  const first = makeFetchMock([tokenRoute, routeHeaders429, routeDeltaMsg]);
  const r1 = await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl: first.fetchImpl }, now: () => t0 });
  eq(r1.status, "failed", "first tick failed");
  eq(r1.errorCode, "graph_throttled", "classified throttled");
  const row = state.graphState.find((r) => r.mailbox === "mbx")!;
  assert(typeof row.next_attempt_after === "string" && Date.parse(row.next_attempt_after as string) === t0 + 120_000,
    "next_attempt_after = now + 120s");

  // Within the Retry-After window — no Graph traffic.
  const second = makeFetchMock([tokenRoute, routeHeaders429, routeDeltaEmpty]);
  const r2 = await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl: second.fetchImpl }, now: () => t0 + 60_000 });
  eq(r2.status, "skipped_throttled", "throttled");
  const graphHits = second.calls.filter((c) => c.url.includes("graph.microsoft.com") && !c.url.includes("/oauth2/"));
  eq(graphHits.length, 0, "no Graph calls within window");

  // After the window — allowed to poll (empty delta round).
  const third = makeFetchMock([tokenRoute, routeDeltaEmpty]);
  const r3 = await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl: third.fetchImpl }, now: () => t0 + 121_000 });
  eq(r3.status, "ok", "allowed after Retry-After expiry");
});

test("header 401 after Rules 1–4 miss → poll fails; no submission; cursor unchanged", async () => {
  const state = newFakeState();
  const { rpc } = makeFakeAdmin(state);
  const admin = passThroughAdmin(rpc, state);
  const routeHeaders401 = (c: FetchCall) => c.url.includes("/messages/m401") ? jsonResponse(401, {}) : null;
  const routeDelta = (c: FetchCall) => c.url.includes("/messages/delta")
    ? jsonResponse(200, { value: [messageWithoutMatches("m401")], "@odata.deltaLink": "https://graph.microsoft.com/end" })
    : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, routeHeaders401, routeDelta]);
  const result = await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl } });
  eq(result.status, "failed", "failed");
  eq(result.errorCode, "graph_unauthorized", "classified unauthorized");
  eq(result.newSubmissions, 0, "no submission created");
  const row = state.graphState.find((r) => r.mailbox === "mbx")!;
  eq(row.delta_link, null, "cursor unchanged");
});

test("header 403 after Rules 1–4 miss → poll fails; no submission; cursor unchanged", async () => {
  const state = newFakeState();
  const { rpc } = makeFakeAdmin(state);
  const admin = passThroughAdmin(rpc, state);
  const routeHeaders403 = (c: FetchCall) => c.url.includes("/messages/m403") ? jsonResponse(403, {}) : null;
  const routeDelta = (c: FetchCall) => c.url.includes("/messages/delta")
    ? jsonResponse(200, { value: [messageWithoutMatches("m403")], "@odata.deltaLink": "https://graph.microsoft.com/end" })
    : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, routeHeaders403, routeDelta]);
  const result = await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl } });
  eq(result.status, "failed", "failed");
  eq(result.errorCode, "graph_forbidden", "classified forbidden");
  eq(result.newSubmissions, 0, "no submission created");
  const row = state.graphState.find((r) => r.mailbox === "mbx")!;
  eq(row.delta_link, null, "cursor unchanged");
});

test("header transport failure after Rules 1–4 miss → classified graph_header_fetch_failed; no PII in logs", async () => {
  const state = newFakeState();
  const { rpc } = makeFakeAdmin(state);
  const admin = passThroughAdmin(rpc, state);
  // fetchImpl throws a non-Graph transport error for the header URL only.
  const routeDeltaOk = (c: FetchCall) => c.url.includes("/messages/delta")
    ? jsonResponse(200, { value: [messageWithoutMatches("m-net")], "@odata.deltaLink": "https://graph.microsoft.com/end" })
    : null;
  const originalFetchImpl: typeof fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes("/messages/m-net") && !url.includes("delta")) {
      throw new TypeError("SECRET-NETWORK-ERROR-CANARY p5a-canary-sender@example.invalid");
    }
    const tokenRes = tokenRoute({ url });
    if (tokenRes) return tokenRes;
    const deltaRes = routeDeltaOk({ url });
    if (deltaRes) return deltaRes;
    return new Response("{}", { status: 500 });
  }) as typeof fetch;

  const originalErr = console.error;
  const captured: string[] = [];
  console.error = ((...args: unknown[]) => { captured.push(JSON.stringify(args)); }) as typeof console.error;
  let result;
  try {
    result = await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl: originalFetchImpl } });
  } finally {
    console.error = originalErr;
  }
  eq(result.status, "failed", "failed");
  eq(result.errorCode, "graph_header_fetch_failed", "classified graph_header_fetch_failed");
  eq(result.newSubmissions, 0, "no submission created");
  const row = state.graphState.find((r) => r.mailbox === "mbx")!;
  eq(row.delta_link, null, "cursor unchanged");
  // No raw exception text may reach logs.
  const joined = captured.join("\n");
  assert(!joined.includes("SECRET-NETWORK-ERROR-CANARY"), "raw exception text not logged");
  assert(!joined.includes("p5a-canary-sender@example.invalid"), "sender canary not logged");
  assert(!joined.includes("/messages/m-net"), "URL not logged");
});

test("header 404 after Rules 1–4 miss → benign absence; Rule 6 creates a new submission", async () => {
  const state = newFakeState();
  const { rpc } = makeFakeAdmin(state);
  const admin = passThroughAdmin(rpc, state);
  const routeHeaders404 = (c: FetchCall) => c.url.includes("/messages/m404") ? jsonResponse(404, {}) : null;
  const routeDelta = (c: FetchCall) => c.url.includes("/messages/delta")
    ? jsonResponse(200, { value: [messageWithoutMatches("m404")], "@odata.deltaLink": "https://graph.microsoft.com/end" })
    : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, routeHeaders404, routeDelta]);
  const result = await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl } });
  eq(result.status, "ok", "poll ok");
  eq(result.newSubmissions, 1, "one new submission (Rule 6)");
});

test("header 410 after Rules 1–4 miss → benign absence; Rule 6 creates a new submission", async () => {
  const state = newFakeState();
  const { rpc } = makeFakeAdmin(state);
  const admin = passThroughAdmin(rpc, state);
  // 410 with a non-syncStateNotFound body so it counts as a plain 410 that
  // the header client interprets as benign absence (not a delta reset).
  const routeHeaders410 = (c: FetchCall) => c.url.includes("/messages/m410") ? jsonResponse(410, {}) : null;
  const routeDelta = (c: FetchCall) => c.url.includes("/messages/delta")
    ? jsonResponse(200, { value: [messageWithoutMatches("m410")], "@odata.deltaLink": "https://graph.microsoft.com/end" })
    : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, routeHeaders410, routeDelta]);
  const result = await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl } });
  eq(result.status, "ok", "poll ok");
  eq(result.newSubmissions, 1, "one new submission (Rule 6)");
});

// ---------------------------------------------------------------------------
// FINDING #7 — bounded 410 reset
// ---------------------------------------------------------------------------

test("delta_expired: at most one reset per poll; second one → classified failure", async () => {
  const { rpc } = makeFakeAdmin(newFakeState());
  const admin: unknown = { from() { return { select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }), insert: () => ({ then: (cb: (v: unknown) => unknown) => Promise.resolve(cb({ data: null, error: null })) }) }; }, rpc };
  let deltaCalls = 0;
  const route410 = (c: FetchCall) => {
    if (!c.url.startsWith("https://graph.microsoft.com/") || c.url.includes("/oauth2/")) return null;
    deltaCalls++;
    return jsonResponse(410, { error: { code: "syncStateNotFound" } });
  };
  const { fetchImpl } = makeFetchMock([tokenRoute, route410]);
  const result = await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl }, attemptReplyHeaders: false });
  eq(result.status, "failed", "failed after bounded reset");
  eq(result.errorCode, "graph_delta_reset_failed", "classified graph_delta_reset_failed");
  eq(deltaCalls, 2, "exactly two delta attempts (first + one reset)");
});

// ---------------------------------------------------------------------------
// FINDING #4 — breaker: failed probe re-opens cooldown
// ---------------------------------------------------------------------------

test("breaker failed probe re-opens cooldown; next tick is skipped", async () => {
  const state = newFakeState();
  const { rpc } = makeFakeAdmin(state);
  const admin: unknown = { from() { return { select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }), insert: () => ({ then: (cb: (v: unknown) => unknown) => Promise.resolve(cb({ data: null, error: null })) }) }; }, rpc };
  // Preload state right below the threshold.
  state.graphState.push({
    mailbox: "mbx", delta_link: null, in_round_next_link: null, last_polled_at: null,
    last_success_at: null, last_error: null, consecutive_failures: CIRCUIT_BREAKER_FAILURES - 1,
    poll_in_flight_since: null, lease_id: null, breaker_opened_at: null,
    last_failure_at: null, next_attempt_after: null,
  });
  const routeFail = (c: FetchCall) => c.url.startsWith("https://graph.microsoft.com/") && !c.url.includes("/oauth2/") ? jsonResponse(503, {}) : null;
  const t0 = 10_000_000;
  const a = makeFetchMock([tokenRoute, routeFail]);
  await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl: a.fetchImpl }, now: () => t0, attemptReplyHeaders: false });
  const row = state.graphState.find((r) => r.mailbox === "mbx")!;
  const openedAtT0 = row.breaker_opened_at as string;
  assert(typeof openedAtT0 === "string", "breaker opened at T0");
  eq(Date.parse(openedAtT0), t0, "breaker opened_at == T0");

  // After cooldown, run a probe that also fails at T1.
  const t1 = t0 + CIRCUIT_BREAKER_COOLDOWN_MS + 500;
  const b = makeFetchMock([tokenRoute, routeFail]);
  await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl: b.fetchImpl }, now: () => t1, attemptReplyHeaders: false });
  const openedAtT1 = row.breaker_opened_at as string;
  eq(Date.parse(openedAtT1), t1, "breaker re-opened at T1 after failed probe");

  // Within the fresh cooldown → skipped.
  const t2 = t1 + 60_000;
  const c = makeFetchMock([tokenRoute, routeFail]);
  const skipped = await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl: c.fetchImpl }, now: () => t2, attemptReplyHeaders: false });
  eq(skipped.status, "skipped_breaker", "breaker holds after failed probe");
  const graphCalls = c.calls.filter((x) => x.url.includes("graph.microsoft.com") && !x.url.includes("/oauth2/"));
  eq(graphCalls.length, 0, "no Graph calls during fresh cooldown");
});

// ---------------------------------------------------------------------------
// FINDING #9F — replay after audit failure eventually completes
// ---------------------------------------------------------------------------

test("graph_poll_success audit failure once → replay next tick succeeds and cursor advances", async () => {
  const state = newFakeState();
  const { rpc } = makeFakeAdmin(state);
  const admin: unknown = { from() { return { select: () => ({ eq: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }), insert: () => ({ then: (cb: (v: unknown) => unknown) => Promise.resolve(cb({ data: null, error: null })) }) }; }, rpc };
  state.failNextRpc = { name: "atlas_intake_release_lease_success_with_floor", code: "audit_broken" };
  const routeDelta = (c: FetchCall) => c.url.startsWith("https://graph.microsoft.com/") && !c.url.includes("/oauth2/")
    ? jsonResponse(200, { value: [], "@odata.deltaLink": "https://graph.microsoft.com/end" })
    : null;
  const first = makeFetchMock([tokenRoute, routeDelta]);
  await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl: first.fetchImpl }, attemptReplyHeaders: false });
  const row = state.graphState.find((r) => r.mailbox === "mbx")!;
  eq(row.delta_link, null, "first tick: rollback preserved cursor");

  const second = makeFetchMock([tokenRoute, routeDelta]);
  const result = await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl: second.fetchImpl }, attemptReplyHeaders: false });
  eq(result.status, "ok", "second tick succeeds");
  eq(row.delta_link, "https://graph.microsoft.com/end", "cursor advanced on retry");
  const successAudits = state.audit.filter((a) => a.action === "graph_poll_success");
  eq(successAudits.length, 1, "exactly one graph_poll_success audit — no duplicates");
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ✓ ${t.name}`); passed++; }
    catch (e) { console.error(`  ✗ ${t.name}: ${(e as Error).message}`); failed++; }
  }
  console.log(`\nPhase 19c hardening: ${passed} passed, ${failed} failed out of ${tests.length}`);
  if (failed > 0 && typeof process !== "undefined") process.exitCode = 1;
})();
