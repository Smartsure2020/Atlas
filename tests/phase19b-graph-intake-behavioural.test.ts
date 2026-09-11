/**
 * Phase 19b — Behavioural hardening tests for Phase 5A (Checkpoint 2)
 * ---------------------------------------------------------------------------
 * Drives the real orchestrator (pollMailbox / runGraphIntakeCycle) against a
 * tiny in-memory admin fake that reproduces the semantics of the Phase 5A
 * SQL RPCs and tables. Also mocks graph-client's fetch to inject responses
 * and prove URL validation prevents the transport from being called at all
 * when a URL fails the origin allowlist.
 *
 * These tests are behavioural — they exercise the orchestrator through its
 * public entry points, not source-text regexes. Real Postgres concurrency
 * (advisory locks, unique-index race under load) is not proved here; that
 * proof belongs to the staging gate.
 */

import {
  pollMailbox,
  runGraphIntakeCycle,
  POLL_LEASE_STALE_MS,
  CIRCUIT_BREAKER_FAILURES,
  CIRCUIT_BREAKER_COOLDOWN_MS,
  MAX_DELTA_PAGES_PER_POLL,
  ATLAS_INTAKE_SYSTEM_ACTOR_ID,
} from "../worker/src/graph-intake.js";
import { assertAllowedGraphUrl, GraphError, canonicalMessageId } from "../worker/src/graph-client.js";

// -----------------------------------------------------------------------
// Test runner
// -----------------------------------------------------------------------

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }
function assert(cond: unknown, message: string): asserts cond { if (!cond) throw new Error(message); }
function eq<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

// -----------------------------------------------------------------------
// Very small deterministic UUID generator so lease IDs are predictable
// -----------------------------------------------------------------------

let uuidCounter = 0;
function nextUuid() {
  uuidCounter++;
  const s = uuidCounter.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${s}`;
}

// -----------------------------------------------------------------------
// In-memory admin fake
//
// Supports the calls the orchestrator makes:
//   admin.rpc(name, args)
//   admin.from(table).insert(row) / .select(cols)... / .update(row).eq/.or
//   .maybeSingle() / .single() / .limit() / .order() / .in()
// -----------------------------------------------------------------------

interface FakeState {
  submissions: Array<Record<string, unknown>>;
  intake: Array<Record<string, unknown>>;
  graphState: Array<Record<string, unknown>>;
  audit: Array<Record<string, unknown>>;
  alerts: Array<Record<string, unknown>>;
  // Configured failures / interceptors.
  failNextIntakeIngest?: string;
  failNextAudit?: string;
  failNextAcquire?: string;
  // Phase 6 Checkpoint 1A — record every reset-floor advance RPC call.
  resetFloorAdvanceCalls: Array<{ mailbox: string; new_reset_floor: string | null }>;
  // Observability.
  logs: unknown[];
}

function newFakeState(): FakeState {
  return {
    submissions: [],
    intake: [],
    graphState: [],
    audit: [],
    alerts: [],
    resetFloorAdvanceCalls: [],
    logs: [],
  };
}

class FakeQuery {
  private filters: Array<(row: Record<string, unknown>) => boolean> = [];
  private orderBy: { field: string; ascending: boolean } | null = null;
  private limitN: number | null = null;
  private isUpdate: Record<string, unknown> | null = null;
  private selectCols: string | null = null;
  constructor(
    private state: FakeState,
    private table: string,
    private allRows: () => Array<Record<string, unknown>>,
    private replaceRows: (rows: Array<Record<string, unknown>>) => void,
  ) {}
  select(cols: string) { this.selectCols = cols; return this; }
  eq(field: string, value: unknown) {
    // PostgREST JSON-path filter: `col->>key` reads `row[col][key]` as text.
    const jsonPath = /^([a-zA-Z_][a-zA-Z0-9_]*)->>([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(field);
    if (jsonPath) {
      const [, col, key] = jsonPath;
      this.filters.push((r) => {
        const container = r[col] as Record<string, unknown> | null | undefined;
        if (container == null) return false;
        return String(container[key] ?? "") === String(value ?? "");
      });
      return this;
    }
    this.filters.push((r) => r[field] === value);
    return this;
  }
  in(field: string, values: unknown[]) {
    const set = new Set(values);
    this.filters.push((r) => set.has(r[field] as never));
    return this;
  }
  is(field: string, value: unknown) {
    if (value === null) this.filters.push((r) => r[field] == null);
    else this.filters.push((r) => r[field] === value);
    return this;
  }
  or(expr: string) {
    // Support a tiny subset of PostgREST or() used by the orchestrator's
    // legacy lease acquire fallback (kept for tests that still use it).
    // Real acquisition goes via RPC.
    this.filters.push((r) => {
      const clauses = expr.split(",");
      for (const c of clauses) {
        if (/poll_in_flight_since\.is\.null/.test(c) && r["poll_in_flight_since"] == null) return true;
        const m = /poll_in_flight_since\.lt\.(.+)$/.exec(c);
        if (m && typeof r["poll_in_flight_since"] === "string" && r["poll_in_flight_since"] < m[1]) return true;
      }
      return false;
    });
    return this;
  }
  lt(field: string, value: string) {
    this.filters.push((r) => typeof r[field] === "string" && (r[field] as string) < value);
    return this;
  }
  lte(_field: string, _value: unknown) { return this; }
  gte(_field: string, _value: unknown) { return this; }
  not(_field: string, _op: string, _value: unknown) { return this; }
  order(field: string, opts?: { ascending?: boolean }) {
    this.orderBy = { field, ascending: !!opts?.ascending };
    return this;
  }
  limit(n: number) { this.limitN = n; return this; }
  private applied(): Array<Record<string, unknown>> {
    let rows = this.allRows().filter((r) => this.filters.every((f) => f(r)));
    if (this.orderBy) {
      const { field, ascending } = this.orderBy;
      rows = rows.slice().sort((a, b) => {
        const av = a[field] as never; const bv = b[field] as never;
        if (av === bv) return 0;
        return ascending ? (av < bv ? -1 : 1) : (av < bv ? 1 : -1);
      });
    }
    if (this.limitN != null) rows = rows.slice(0, this.limitN);
    // Attach the atlas_submissions!inner join when requested by select().
    if (this.selectCols && /atlas_submissions!inner/.test(this.selectCols)) {
      rows = rows.map((row) => ({
        ...row,
        atlas_submissions: this.state.submissions.find((s) => s.id === row.submission_id) ?? null,
      }));
    }
    return rows;
  }
  private terminalRows(): Array<Record<string, unknown>> {
    return this.applied();
  }
  update(patch: Record<string, unknown>) { this.isUpdate = patch; return this; }
  async maybeSingle() { return { data: this.terminalRows()[0] ?? null, error: null }; }
  async single() {
    const rows = this.terminalRows();
    if (rows.length === 0) return { data: null, error: { message: "no rows" } };
    return { data: rows[0], error: null };
  }
  then<TResult1 = unknown>(
    onFulfilled: (v: { data: Array<Record<string, unknown>> | null; error: unknown }) => TResult1,
  ): Promise<TResult1> {
    if (this.isUpdate) {
      const rows = this.applied();
      for (const row of rows) Object.assign(row, this.isUpdate);
      return Promise.resolve(onFulfilled({ data: rows, error: null }));
    }
    return Promise.resolve(onFulfilled({ data: this.applied(), error: null }));
  }
  // Inserts go through a separate call path.
  insert(rowOrRows: Record<string, unknown> | Array<Record<string, unknown>>) {
    const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
    const inserted: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const withId: Record<string, unknown> = { id: row.id ?? nextUuid(), ...row };
      // Uniqueness enforcement for the two 0028 indexes.
      if (this.table === "atlas_submission_intake_messages") {
        const im = withId.internet_message_id;
        if (im && this.allRows().some((r) => r.internet_message_id === im)) {
          return { select: () => ({ single: async () => ({ data: null, error: { code: "23505" } }) }) };
        }
        const gm = withId.graph_message_id;
        const mb = withId.mailbox;
        if (mb && gm && this.allRows().some((r) => r.mailbox === mb && r.graph_message_id === gm)) {
          return { select: () => ({ single: async () => ({ data: null, error: { code: "23505" } }) }) };
        }
      }
      if (this.table === "atlas_intake_graph_state") {
        if (this.allRows().some((r) => r.mailbox === withId.mailbox)) {
          return { then: (cb: (v: { data: null; error: { code: string } }) => unknown) =>
            Promise.resolve(cb({ data: null, error: { code: "23505" } })) };
        }
      }
      inserted.push(withId as Record<string, unknown>);
      this.replaceRows([...this.allRows(), withId as Record<string, unknown>]);
    }
    return {
      select: (_cols?: string) => ({
        single: async () => ({ data: inserted[0], error: null }),
      }),
      then: (cb: (v: { data: Array<Record<string, unknown>>; error: null }) => unknown) =>
        Promise.resolve(cb({ data: inserted, error: null })),
    };
  }
}

function makeFakeAdmin(state: FakeState): {
  admin: unknown;
  state: FakeState;
} {
  function table(name: string) {
    const getAll = () => {
      switch (name) {
        case "atlas_submissions": return state.submissions;
        case "atlas_submission_intake_messages": return state.intake;
        case "atlas_intake_graph_state": return state.graphState;
        case "atlas_audit_logs": return state.audit;
        case "atlas_operational_alerts": return state.alerts;
      }
      return [];
    };
    const replaceAll = (rows: Array<Record<string, unknown>>) => {
      switch (name) {
        case "atlas_submissions": state.submissions = rows; return;
        case "atlas_submission_intake_messages": state.intake = rows; return;
        case "atlas_intake_graph_state": state.graphState = rows; return;
        case "atlas_audit_logs": state.audit = rows; return;
        case "atlas_operational_alerts": state.alerts = rows; return;
      }
    };
    return new FakeQuery(state, name, getAll, replaceAll);
  }

  async function rpc(name: string, args: Record<string, unknown>) {
    // Simulated failures for tests.
    if (name === "atlas_intake_acquire_lease" && state.failNextAcquire) {
      const code = state.failNextAcquire; state.failNextAcquire = undefined;
      return { data: null, error: { code, message: code } };
    }
    if (name === "atlas_intake_ingest_new_email" && state.failNextIntakeIngest) {
      const code = state.failNextIntakeIngest; state.failNextIntakeIngest = undefined;
      return { data: null, error: { code, message: code } };
    }
    if (name === "atlas_intake_acquire_lease") {
      const mailbox = String(args.p_mailbox);
      const staleCutoffIso = String(args.p_stale_cutoff_iso);
      const nowIso = String(args.p_now);
      const newLeaseId = String(args.p_new_lease_id);
      let row = state.graphState.find((r) => r.mailbox === mailbox);
      if (!row) {
        row = { mailbox, delta_link: null, in_round_next_link: null, last_polled_at: null,
                last_success_at: null, last_error: null, consecutive_failures: 0,
                poll_in_flight_since: null, lease_id: null, breaker_opened_at: null,
                last_failure_at: null, next_attempt_after: null };
        state.graphState.push(row);
      }
      const nextAttempt = row.next_attempt_after as string | null;
      const canAttempt = !nextAttempt || nextAttempt <= nowIso;
      const notLeased = row.poll_in_flight_since == null ||
        (typeof row.poll_in_flight_since === "string" && row.poll_in_flight_since < staleCutoffIso);
      if (!canAttempt || !notLeased) return { data: [], error: null };
      row.poll_in_flight_since = nowIso;
      row.last_polled_at = nowIso;
      row.lease_id = newLeaseId;
      return { data: [{ ...row }], error: null };
    }
    if (name === "atlas_intake_release_lease") {
      const mailbox = String(args.p_mailbox);
      const expectedLeaseId = String(args.p_expected_lease_id);
      const row = state.graphState.find((r) => r.mailbox === mailbox);
      if (!row || row.lease_id !== expectedLeaseId) return { data: [], error: null };
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
      return { data: [{ mailbox }], error: null };
    }
    if (name === "atlas_intake_reset_floor_advance") {
      // Phase 6 Checkpoint 1A — monotonic advance of the durable reset floor.
      // Idempotent + monotonic at the DB layer; here we just record and
      // apply the same guard (never regress).
      const mailbox = String(args.p_mailbox);
      const newFloor = (args.p_new_reset_floor as string | null) ?? null;
      state.resetFloorAdvanceCalls.push({ mailbox, new_reset_floor: newFloor });
      const row = state.graphState.find((r) => r.mailbox === mailbox);
      if (row && newFloor) {
        const current = (row.reset_floor as string | null) ?? null;
        if (current == null || current < newFloor) row.reset_floor = newFloor;
      }
      return { data: null, error: null };
    }
    if (name === "atlas_intake_release_lease_success") {
      const mailbox = String(args.p_mailbox);
      const expectedLeaseId = String(args.p_expected_lease_id);
      const row = state.graphState.find((r) => r.mailbox === mailbox);
      if (!row || row.lease_id !== expectedLeaseId) {
        return { data: [{ ok: false, reason: "lease_lost" }], error: null };
      }
      // Optional injectable audit failure inside the transaction.
      if (state.failNextAudit === "graph_poll_success") {
        state.failNextAudit = undefined;
        // Simulate transaction rollback: no state mutation, no audit written.
        return { data: [{ ok: false, reason: "audit_broken" }], error: null };
      }
      row.poll_in_flight_since = null;
      row.lease_id = null;
      if (args.p_delta_link_provided) row.delta_link = (args.p_delta_link as string | null) ?? null;
      if (args.p_in_round_provided) row.in_round_next_link = (args.p_in_round_next_link as string | null) ?? null;
      row.last_error = null;
      row.consecutive_failures = 0;
      if (args.p_last_success_at != null) row.last_success_at = args.p_last_success_at as string;
      row.breaker_opened_at = null;
      row.next_attempt_after = null;
      state.audit.push({
        id: nextUuid(),
        submission_id: null,
        action: "graph_poll_success",
        actor: null,
        metadata_json: args.p_audit_metadata,
      });
      return { data: [{ ok: true, reason: null }], error: null };
    }
    if (name === "atlas_intake_ingest_needs_review") {
      const im = args.p_internet_message_id as string | null;
      const gm = args.p_graph_message_id as string;
      const mb = args.p_mailbox as string;
      if (im && state.intake.some((r) => r.internet_message_id === im)) {
        const dup = state.intake.find((r) => r.internet_message_id === im)!;
        return { data: [{ outcome: "duplicate_internet_message_id", submission_id: dup.submission_id, intake_message_id: dup.id }], error: null };
      }
      if (state.intake.some((r) => r.mailbox === mb && r.graph_message_id === gm)) {
        const dup = state.intake.find((r) => r.mailbox === mb && r.graph_message_id === gm)!;
        return { data: [{ outcome: "duplicate_graph_message_id", submission_id: dup.submission_id, intake_message_id: dup.id }], error: null };
      }
      const submissionId = nextUuid();
      const intakeId = nextUuid();
      state.submissions.push({
        id: submissionId, created_by: args.p_system_actor_id, source_type: args.p_source_type,
        status: args.p_status, queue_status: args.p_queue_status, pipeline_stage: args.p_pipeline_stage,
        received_at: args.p_received_at ?? new Date().toISOString(),
        priority: args.p_priority, next_action: args.p_next_action,
      });
      state.intake.push({
        id: intakeId, submission_id: submissionId, source: "email", mailbox: mb, graph_message_id: gm,
        internet_message_id: im, conversation_id: args.p_conversation_id,
        sender_name: args.p_sender_name, sender_address: args.p_sender_address,
        recipients: args.p_recipients, subject: args.p_subject, body_preview: args.p_body_preview,
        received_at: args.p_received_at, has_attachments: args.p_has_attachments,
        processing_state: "needs_review",
      });
      state.audit.push({
        id: nextUuid(), submission_id: submissionId,
        action: "intake_correlation_needs_review", actor: null,
        metadata_json: {
          intake_message_id: intakeId,
          correlation_rule_matched: args.p_correlation_rule,
          graph_message_id_hash: args.p_graph_message_id_hash,
          mailbox_hash: args.p_mailbox_hash,
          candidate_submission_ids: args.p_candidate_ids,
        },
      });
      state.alerts.push({
        id: nextUuid(),
        alert_type: "intake_correlation_needs_review",
        severity: "warning", status: "open",
        title: args.p_alert_title, message: args.p_alert_message,
        related_submission_id: submissionId,
        metadata: {
          intake_message_id: intakeId,
          candidate_count: Array.isArray(args.p_candidate_ids) ? (args.p_candidate_ids as unknown[]).length : 0,
          rule: args.p_correlation_rule,
        },
      });
      return { data: [{ outcome: "created", submission_id: submissionId, intake_message_id: intakeId }], error: null };
    }
    if (name === "atlas_intake_ingest_new_email") {
      const im = args.p_internet_message_id as string | null;
      const gm = args.p_graph_message_id as string;
      const mb = args.p_mailbox as string;
      if (im && state.intake.some((r) => r.internet_message_id === im)) {
        const dup = state.intake.find((r) => r.internet_message_id === im)!;
        return { data: [{ outcome: "duplicate_internet_message_id", submission_id: dup.submission_id, intake_message_id: dup.id }], error: null };
      }
      if (state.intake.some((r) => r.mailbox === mb && r.graph_message_id === gm)) {
        const dup = state.intake.find((r) => r.mailbox === mb && r.graph_message_id === gm)!;
        return { data: [{ outcome: "duplicate_graph_message_id", submission_id: dup.submission_id, intake_message_id: dup.id }], error: null };
      }
      const submissionId = nextUuid();
      const intakeId = nextUuid();
      state.submissions.push({
        id: submissionId, created_by: args.p_system_actor_id, source_type: args.p_source_type,
        status: args.p_status, queue_status: args.p_queue_status, pipeline_stage: args.p_pipeline_stage,
        received_at: args.p_received_at ?? new Date().toISOString(),
        priority: args.p_priority, next_action: args.p_next_action,
      });
      state.intake.push({
        id: intakeId, submission_id: submissionId, source: "email", mailbox: mb, graph_message_id: gm,
        internet_message_id: im, conversation_id: args.p_conversation_id,
        sender_name: args.p_sender_name, sender_address: args.p_sender_address,
        recipients: args.p_recipients, subject: args.p_subject, body_preview: args.p_body_preview,
        received_at: args.p_received_at, has_attachments: args.p_has_attachments,
        processing_state: args.p_processing_state,
      });
      // Atomic audits — same shape as migration 0030.
      state.audit.push({
        id: nextUuid(), submission_id: submissionId,
        action: "submission_created_from_email", actor: null,
        metadata_json: {
          intake_message_id: intakeId,
          correlation_rule_matched: args.p_correlation_rule,
          graph_message_id_hash: args.p_graph_message_id_hash,
          mailbox_hash: args.p_mailbox_hash,
        },
      });
      state.audit.push({
        id: nextUuid(), submission_id: submissionId,
        action: "intake_message_recorded", actor: null,
        metadata_json: { intake_message_id: intakeId, mailbox_hash: args.p_mailbox_hash },
      });
      return { data: [{ outcome: "created", submission_id: submissionId, intake_message_id: intakeId }], error: null };
    }
    if (name === "atlas_intake_attach_message") {
      const im = args.p_internet_message_id as string | null;
      const gm = args.p_graph_message_id as string;
      const mb = args.p_mailbox as string;
      const submissionId = String(args.p_submission_id);
      if (im && state.intake.some((r) => r.internet_message_id === im)) {
        const dup = state.intake.find((r) => r.internet_message_id === im)!;
        return { data: [{ outcome: "duplicate_internet_message_id", intake_message_id: dup.id }], error: null };
      }
      if (state.intake.some((r) => r.mailbox === mb && r.graph_message_id === gm)) {
        const dup = state.intake.find((r) => r.mailbox === mb && r.graph_message_id === gm)!;
        return { data: [{ outcome: "duplicate_graph_message_id", intake_message_id: dup.id }], error: null };
      }
      const intakeId = nextUuid();
      state.intake.push({
        id: intakeId, submission_id: submissionId, source: "email", mailbox: mb,
        graph_message_id: gm, internet_message_id: im, conversation_id: args.p_conversation_id,
        sender_name: args.p_sender_name, sender_address: args.p_sender_address,
        recipients: args.p_recipients, subject: args.p_subject, body_preview: args.p_body_preview,
        received_at: args.p_received_at, has_attachments: args.p_has_attachments,
        processing_state: args.p_processing_state,
      });
      state.audit.push({
        id: nextUuid(), submission_id: submissionId,
        action: "intake_message_correlated", actor: null,
        metadata_json: {
          intake_message_id: intakeId,
          correlation_rule_matched: args.p_correlation_rule,
          graph_message_id_hash: args.p_graph_message_id_hash,
          mailbox_hash: args.p_mailbox_hash,
        },
      });
      return { data: [{ outcome: "attached", intake_message_id: intakeId }], error: null };
    }
    return { data: null, error: { message: `unknown_rpc:${name}` } };
  }

  const admin: unknown = {
    from(name: string) { return table(name); },
    rpc,
    auth: { getUser: async () => ({ data: null, error: null }) },
    storage: {},
  };
  return { admin, state };
}

// -----------------------------------------------------------------------
// Common Graph fetch mock builder
// -----------------------------------------------------------------------

interface FetchCall { url: string; init?: RequestInit }
function makeFetchMock(routes: Array<(call: FetchCall) => Response | Promise<Response> | null>): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, init });
    for (const route of routes) {
      const r = await route({ url, init });
      if (r) return r;
    }
    return new Response(JSON.stringify({}), { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

const FAKE_ENV = {
  ATLAS_GRAPH_INTAKE_ENABLED: "true",
  ATLAS_GRAPH_TENANT_ID: "tenant-x",
  ATLAS_GRAPH_CLIENT_ID: "client-x",
  ATLAS_GRAPH_CLIENT_SECRET: "secret-x",
  ATLAS_GRAPH_MAILBOXES_JSON: JSON.stringify(["intake@example.com"]),
  // Phase 6 forward-only cutover: non-production tests use an explicit test
  // default so the initial delta URL builder receives a fixed boundary
  // without inventing a per-mailbox JSON for every test.
  ATLAS_GRAPH_TEST_DEFAULT_CUTOVER: "2026-01-01T00:00:00.000Z",
  SUPABASE_URL: "http://localhost",
  SUPABASE_SERVICE_ROLE_KEY: "key",
  SUPABASE_ANON_KEY: "anon",
} as unknown as Parameters<typeof pollMailbox>[0];

// A token route that any test can share.
const tokenRoute = (call: FetchCall) =>
  call.url.includes("/oauth2/v2.0/token")
    ? jsonResponse(200, { access_token: "TOK", expires_in: 3600 })
    : null;

// A route that returns a single deltaLink (empty inbox).
const emptyDeltaRoute = (call: FetchCall) =>
  call.url.includes("/messages/delta")
    ? jsonResponse(200, { value: [], "@odata.deltaLink": "https://graph.microsoft.com/final" })
    : null;

// -----------------------------------------------------------------------
// FINDING #2: DB error is NOT a duplicate; cursor unchanged
// -----------------------------------------------------------------------

test("DB error on ingest fails the poll and does NOT advance delta cursor", async () => {
  const { admin, state } = makeFakeAdmin(newFakeState());
  state.failNextIntakeIngest = "intake_ingest_new_failed";
  const messageRoute = (call: FetchCall) => {
    if (call.url.includes("/messages/delta")) {
      return jsonResponse(200, {
        value: [{ id: "m1", internetMessageId: "im-1", conversationId: null, from: { emailAddress: { address: "a@a" } }, receivedDateTime: new Date().toISOString() }],
        "@odata.deltaLink": "https://graph.microsoft.com/final",
      });
    }
    if (call.url.includes("/messages/m1")) return jsonResponse(200, {});
    return null;
  };
  const { fetchImpl } = makeFetchMock([tokenRoute, messageRoute]);
  const result = await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl }, attemptReplyHeaders: false });
  eq(result.status, "failed", "status");
  eq(result.duplicates, 0, "duplicates count");
  const stateRow = state.graphState.find((r) => r.mailbox === "mbx")!;
  eq(stateRow.delta_link, null, "delta cursor NOT advanced");
  eq(stateRow.lease_id, null, "lease released");
  assert((stateRow.consecutive_failures as number) === 1, "failures incremented");
});

// -----------------------------------------------------------------------
// FINDING #3: Atomic ingest — same internetMessageId across mailboxes ⇒
//             one durable intake, one submission
// -----------------------------------------------------------------------

test("cross-mailbox race on same internetMessageId leaves exactly one submission", async () => {
  const { admin, state } = makeFakeAdmin(newFakeState());
  // Simulate mailbox A ingesting first, then mailbox B seeing the same id.
  const mkRoute = (msgId: string, im: string) => (call: FetchCall) =>
    call.url.includes("/messages/delta")
      ? jsonResponse(200, {
          value: [{ id: msgId, internetMessageId: im, from: { emailAddress: { address: "a@a" } }, receivedDateTime: new Date().toISOString() }],
          "@odata.deltaLink": "https://graph.microsoft.com/final",
        })
      : null;
  const a = makeFetchMock([tokenRoute, mkRoute("gA", "shared-im-1")]);
  const b = makeFetchMock([tokenRoute, mkRoute("gB", "shared-im-1")]);
  await pollMailbox(FAKE_ENV, admin as never, "mailbox-a", { graph: { fetchImpl: a.fetchImpl }, attemptReplyHeaders: false });
  await pollMailbox(FAKE_ENV, admin as never, "mailbox-b", { graph: { fetchImpl: b.fetchImpl }, attemptReplyHeaders: false });
  eq(state.submissions.length, 1, "exactly one submission");
  eq(state.intake.length, 1, "exactly one intake row");
});

// -----------------------------------------------------------------------
// FINDING #4: Lease fencing — A cannot clear B's lease
// -----------------------------------------------------------------------

test("lease fencing: stale A cannot overwrite B's newer lease/state", async () => {
  const { admin, state } = makeFakeAdmin(newFakeState());
  // First: A polls successfully, sets delta_link = a-delta.
  const routeAdelta = (call: FetchCall) =>
    call.url.includes("/messages") || call.url.includes("a-delta")
      ? jsonResponse(200, { value: [], "@odata.deltaLink": "https://graph.microsoft.com/a-delta" })
      : null;
  const a = makeFetchMock([tokenRoute, routeAdelta]);
  await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl: a.fetchImpl }, attemptReplyHeaders: false });
  const row = state.graphState.find((r) => r.mailbox === "mbx")!;
  eq(row.delta_link, "https://graph.microsoft.com/a-delta", "A advances cursor to a-delta");

  // Stale writer with wrong lease_id tries to overwrite the cursor.
  const rpcFn = (admin as { rpc: (n: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> }).rpc;
  const staleAttempt = await rpcFn("atlas_intake_release_lease", {
    p_mailbox: "mbx",
    p_expected_lease_id: "00000000-0000-4000-8000-DEADBEEFDEAD",
    p_delta_link: "https://graph.microsoft.com/a-STALE",
    p_delta_link_provided: true,
    p_in_round_next_link: null,
    p_in_round_provided: false,
    p_last_error: null,
    p_consecutive_failures: 0,
    p_last_success_at: new Date().toISOString(),
    p_last_failure_at: null,
    p_breaker_opened_at: null,
    p_breaker_provided: false,
    p_next_attempt_after: null,
    p_next_attempt_provided: false,
  });
  const rows = (staleAttempt.data as Array<{ mailbox?: string }> | null) ?? [];
  eq(rows.length, 0, "stale release returns no rows (lease_lost)");
  eq(row.delta_link, "https://graph.microsoft.com/a-delta", "stale writer could not overwrite delta_link");

  // Now B polls and successfully advances cursor to b-delta.
  const routeBdelta = (call: FetchCall) =>
    call.url.includes("/messages") || call.url.includes("a-delta") || call.url.includes("b-delta")
      ? jsonResponse(200, { value: [], "@odata.deltaLink": "https://graph.microsoft.com/b-delta" })
      : null;
  const b = makeFetchMock([tokenRoute, routeBdelta]);
  await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl: b.fetchImpl }, attemptReplyHeaders: false });
  eq(row.delta_link, "https://graph.microsoft.com/b-delta", "B successfully advances cursor");
});

// -----------------------------------------------------------------------
// FINDING #5: URL origin allowlist — rejected URL never reaches fetch
// -----------------------------------------------------------------------

test("assertAllowedGraphUrl rejects http, subdomain, userinfo, look-alike", () => {
  const bad = [
    "http://graph.microsoft.com/x",
    "https://evil.example/x",
    "https://graph.microsoft.com.evil.example/x",
    "https://graph.microsoft.com@evil.example/x",
    "https://GRAPH-microsoft-com/x", // dashes not dots — different host
    "https://api.graph.microsoft.com/x",
    "https://graph.microsoft.com:8080@evil/x",
  ];
  for (const u of bad) {
    let threw = false;
    try { assertAllowedGraphUrl(u); } catch (err) { threw = true; assert(err instanceof GraphError, "GraphError"); }
    assert(threw, `must reject: ${u}`);
  }
  // Allowed variants:
  assertAllowedGraphUrl("https://graph.microsoft.com/v1.0/anything");
});

test("orchestrator: poisoned delta persistence never calls fetch when URL fails allowlist", async () => {
  const { admin, state } = makeFakeAdmin(newFakeState());
  // Preload a foreign delta_link into graph state.
  state.graphState.push({
    mailbox: "mbx", delta_link: "https://evil.example/delta", in_round_next_link: null,
    last_polled_at: null, last_success_at: null, last_error: null, consecutive_failures: 0,
    poll_in_flight_since: null, lease_id: null, breaker_opened_at: null,
    last_failure_at: null, next_attempt_after: null,
  });
  // fetchImpl records calls and refuses anything that reached it besides the
  // token endpoint.
  const { fetchImpl, calls } = makeFetchMock([tokenRoute]);
  const result = await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl }, attemptReplyHeaders: false });
  eq(result.status, "failed", "failed status");
  const deltaCalls = calls.filter((c) => c.url.includes("evil.example"));
  eq(deltaCalls.length, 0, "fetch never called for a rejected URL");
  const row = state.graphState.find((r) => r.mailbox === "mbx")!;
  eq(row.delta_link, "https://evil.example/delta", "poisoned cursor left as-is (surfaced via failed status)");
});

// -----------------------------------------------------------------------
// FINDING #6: Canonical message-id equivalence
// -----------------------------------------------------------------------

test("canonicalMessageId is idempotent and matches bracketed vs bare form", () => {
  eq(canonicalMessageId("<abc@example.com>"), "abc@example.com", "strips brackets");
  eq(canonicalMessageId("abc@example.com"), "abc@example.com", "bare untouched");
  eq(canonicalMessageId("  <abc@example.com>  "), "abc@example.com", "trims");
  eq(canonicalMessageId(""), null, "empty => null");
  eq(canonicalMessageId(null), null, "null => null");
  // A repeated pass must give the same value.
  const once = canonicalMessageId("<abc@example.com>");
  eq(canonicalMessageId(once), once, "idempotent");
});

test("Rule 5 attaches when internetMessageId was stored bare but reply header is bracketed", async () => {
  const { admin, state } = makeFakeAdmin(newFakeState());
  // Seed an existing submission + prior intake message that stored the bare
  // canonical value.
  const submissionId = nextUuid();
  state.submissions.push({ id: submissionId, pipeline_stage: "in_progress" });
  state.intake.push({
    id: nextUuid(), submission_id: submissionId, source: "email", mailbox: "mbx",
    graph_message_id: "gA", internet_message_id: "MWHPR6E1BE060@example.outlook.com",
    conversation_id: null, sender_name: null, sender_address: null, recipients: [],
    subject: null, body_preview: null, received_at: null, has_attachments: false,
    processing_state: "processed",
  });
  const routeDelta = (call: FetchCall) =>
    call.url.includes("/messages/delta")
      ? jsonResponse(200, {
          value: [{ id: "gB", internetMessageId: "new-child@example.outlook.com", conversationId: null, from: { emailAddress: { address: "a@a" } }, receivedDateTime: new Date().toISOString() }],
          "@odata.deltaLink": "https://graph.microsoft.com/final",
        })
      : null;
  const routeHeaders = (call: FetchCall) =>
    call.url.includes("/messages/gB")
      ? jsonResponse(200, {
          internetMessageHeaders: [
            { name: "In-Reply-To", value: "<MWHPR6E1BE060@example.outlook.com>" },
          ],
        })
      : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, routeHeaders, routeDelta]);
  const result = await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl } });
  eq(result.status, "ok", "poll ok");
  eq(result.attached, 1, "one attach via reply-header rule");
  const child = state.intake.find((r) => r.internet_message_id === "new-child@example.outlook.com")!;
  eq(child.submission_id, submissionId, "attached to the right parent");
});

// -----------------------------------------------------------------------
// FINDING #7: >MAX pages continuation (resumable)
// -----------------------------------------------------------------------

test(">MAX pages -> ok_resumable and in_round_next_link persisted", async () => {
  const { admin, state } = makeFakeAdmin(newFakeState());
  let pageCount = 0;
  const totalPages = MAX_DELTA_PAGES_PER_POLL + 5;
  const routeDelta = (call: FetchCall) => {
    // Match every allowed Graph URL: initial delta or continuation.
    if (!call.url.startsWith("https://graph.microsoft.com/")) return null;
    if (call.url.includes("/oauth2/")) return null;
    pageCount++;
    const isLast = pageCount === totalPages;
    return jsonResponse(200, isLast
      ? { value: [], "@odata.deltaLink": "https://graph.microsoft.com/end" }
      : { value: [], "@odata.nextLink": `https://graph.microsoft.com/v1.0/continuation?p=${pageCount + 1}` });
  };
  const { fetchImpl } = makeFetchMock([tokenRoute, routeDelta]);
  const result = await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl }, attemptReplyHeaders: false });
  eq(result.status, "ok_resumable", "status resumable");
  eq(result.pagesFetched, MAX_DELTA_PAGES_PER_POLL, "hit page budget");
  const row = state.graphState.find((r) => r.mailbox === "mbx")!;
  assert(typeof row.in_round_next_link === "string" && (row.in_round_next_link as string).includes("continuation"), "checkpoint persisted");
  eq(row.delta_link, null, "durable cursor NOT advanced");

  // Second tick from checkpoint completes the round.
  const result2 = await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl }, attemptReplyHeaders: false });
  eq(result2.status, "ok", "second tick completes");
  eq(row.delta_link, "https://graph.microsoft.com/end", "cursor advanced");
  eq(row.in_round_next_link, null, "checkpoint cleared");
});

// -----------------------------------------------------------------------
// FINDING #8: Breaker uses breaker_opened_at, not last_polled_at
// -----------------------------------------------------------------------

test("breaker: opens after threshold and blocks polls during cooldown", async () => {
  const { admin, state } = makeFakeAdmin(newFakeState());
  // Preload state near the threshold.
  state.graphState.push({
    mailbox: "mbx", delta_link: null, in_round_next_link: null, last_polled_at: null,
    last_success_at: null, last_error: null, consecutive_failures: CIRCUIT_BREAKER_FAILURES - 1,
    poll_in_flight_since: null, lease_id: null, breaker_opened_at: null,
    last_failure_at: null, next_attempt_after: null,
  });
  // Force a server error.
  const routeFail = (call: FetchCall) =>
    call.url.includes("/messages/delta") ? jsonResponse(503, {}) : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, routeFail]);
  const t0 = 1_000_000;
  await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl }, now: () => t0, attemptReplyHeaders: false });
  const row = state.graphState.find((r) => r.mailbox === "mbx")!;
  eq(row.consecutive_failures, CIRCUIT_BREAKER_FAILURES, "threshold crossed");
  eq(typeof row.breaker_opened_at, "string", "breaker opened_at recorded");

  // Advance clock to still-within-cooldown and try again.
  const t1 = t0 + Math.floor(CIRCUIT_BREAKER_COOLDOWN_MS / 2);
  const { fetchImpl: f2, calls } = makeFetchMock([tokenRoute, routeFail]);
  const skipped = await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl: f2 }, now: () => t1, attemptReplyHeaders: false });
  eq(skipped.status, "skipped_breaker", "breaker blocks during cooldown");
  const graphCalls = calls.filter((c) => c.url.includes("/messages"));
  eq(graphCalls.length, 0, "no Graph message call during cooldown");

  // After cooldown expires, a probe is permitted; on success breaker closes.
  const t2 = t0 + CIRCUIT_BREAKER_COOLDOWN_MS + 1_000;
  const { fetchImpl: f3 } = makeFetchMock([tokenRoute, emptyDeltaRoute]);
  const probed = await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl: f3 }, now: () => t2, attemptReplyHeaders: false });
  eq(probed.status, "ok", "probe succeeds");
  eq(row.breaker_opened_at, null, "breaker closed after success");
  eq(row.consecutive_failures, 0, "failure count reset");
});

// -----------------------------------------------------------------------
// FINDING #9: Checked audit — audit failure prevents cursor advancement
// -----------------------------------------------------------------------

test("graph_poll_success audit failure rolls back cursor advance (lease_lost result)", async () => {
  const { admin, state } = makeFakeAdmin(newFakeState());
  // Simulate the transactional audit insert failing inside the fenced
  // success RPC. The whole transaction rolls back → cursor stays null →
  // no false success audit is written.
  state.failNextAudit = "graph_poll_success";
  const routeDelta = (call: FetchCall) =>
    call.url.includes("/messages/delta")
      ? jsonResponse(200, { value: [], "@odata.deltaLink": "https://graph.microsoft.com/final" })
      : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, routeDelta]);
  const result = await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl }, attemptReplyHeaders: false });
  const row = state.graphState.find((r) => r.mailbox === "mbx")!;
  eq(row.delta_link, null, "cursor NOT advanced");
  const successAudits = state.audit.filter((a) => a.action === "graph_poll_success");
  eq(successAudits.length, 0, "no graph_poll_success audit written");
  assert(result.status === "skipped_lease_lost" || result.status === "failed", "safe result status");
});

// -----------------------------------------------------------------------
// FINDING #10: No PII in error paths
// -----------------------------------------------------------------------

test("failure path logs contain no sender/subject/body_preview strings", async () => {
  const { admin, state } = makeFakeAdmin(newFakeState());
  state.failNextIntakeIngest = "intake_ingest_new_failed";
  const routeDelta = (call: FetchCall) =>
    call.url.includes("/messages/delta")
      ? jsonResponse(200, {
          value: [{
            id: "m-secret", internetMessageId: "im-secret",
            from: { emailAddress: { address: "seCret@example.com", name: "SECRET NAME" } },
            subject: "SECRET SUBJECT",
            bodyPreview: "SECRET BODY",
            receivedDateTime: new Date().toISOString(),
          }],
          "@odata.deltaLink": "https://graph.microsoft.com/final",
        })
      : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, routeDelta]);
  const originalErr = console.error;
  const captured: string[] = [];
  console.error = ((...args: unknown[]) => { captured.push(JSON.stringify(args)); }) as typeof console.error;
  try {
    await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl }, attemptReplyHeaders: false });
  } finally {
    console.error = originalErr;
  }
  const joined = captured.join("\n");
  assert(!joined.includes("SECRET NAME"), "no sender name");
  assert(!joined.includes("seCret@example.com"), "no sender address");
  assert(!joined.includes("SECRET SUBJECT"), "no subject");
  assert(!joined.includes("SECRET BODY"), "no body preview");
});

// -----------------------------------------------------------------------
// FINDING #11: received_at from Graph
// -----------------------------------------------------------------------

test("submission.received_at comes from Graph receivedDateTime, not poll time", async () => {
  const { admin, state } = makeFakeAdmin(newFakeState());
  const emailReceived = "2026-01-02T03:04:05.000Z";
  const pollTime = Date.parse("2026-06-30T12:00:00Z");
  const routeDelta = (call: FetchCall) =>
    call.url.includes("/messages/delta")
      ? jsonResponse(200, {
          value: [{ id: "m1", internetMessageId: "im-1", from: { emailAddress: { address: "a@a" } }, receivedDateTime: emailReceived }],
          "@odata.deltaLink": "https://graph.microsoft.com/final",
        })
      : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, routeDelta]);
  const result = await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl }, now: () => pollTime, attemptReplyHeaders: false });
  eq(result.status, "ok", "ok");
  const sub = state.submissions[0];
  eq(sub.received_at, emailReceived, "received_at equals Graph value");
  const intakeRow = state.intake[0];
  eq(intakeRow.received_at, emailReceived, "intake received_at equals Graph value");
});

// -----------------------------------------------------------------------
// FINDING #12: 429 Retry-After honored
// -----------------------------------------------------------------------

test("429 Retry-After: next_attempt_after set; next tick within window is skipped", async () => {
  const { admin, state } = makeFakeAdmin(newFakeState());
  const t0 = 2_000_000;
  const route429 = (call: FetchCall) =>
    call.url.includes("/messages/delta") ? jsonResponse(429, {}, { "Retry-After": "120" }) : null;
  const a = makeFetchMock([tokenRoute, route429]);
  await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl: a.fetchImpl }, now: () => t0, attemptReplyHeaders: false });
  const row = state.graphState.find((r) => r.mailbox === "mbx")!;
  assert(typeof row.next_attempt_after === "string", "next_attempt_after set");
  assert(Date.parse(row.next_attempt_after as string) > t0, "future");

  // Tick 60 s later => still throttled, no fetch.
  const b = makeFetchMock([tokenRoute, emptyDeltaRoute]);
  const skipped = await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl: b.fetchImpl }, now: () => t0 + 60_000, attemptReplyHeaders: false });
  eq(skipped.status, "skipped_throttled", "throttled");
  const graphCalls = b.calls.filter((c) => c.url.includes("/messages"));
  eq(graphCalls.length, 0, "no message call");

  // Tick after retry window => allowed.
  const c = makeFetchMock([tokenRoute, emptyDeltaRoute]);
  const ok = await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl: c.fetchImpl }, now: () => t0 + 121_000, attemptReplyHeaders: false });
  eq(ok.status, "ok", "allowed after window");
});

// -----------------------------------------------------------------------
// FINDING #13: Misconfigured mailbox list emits a classified alert
// -----------------------------------------------------------------------

test("flag on + empty mailbox list => classified alert, no Graph traffic", async () => {
  const state = newFakeState();
  const { admin } = makeFakeAdmin(state);
  const env = {
    ...FAKE_ENV,
    ATLAS_GRAPH_MAILBOXES_JSON: "not-json",
  } as unknown as Parameters<typeof runGraphIntakeCycle>[0];
  const { fetchImpl, calls } = makeFetchMock([tokenRoute, emptyDeltaRoute]);
  // Patch the adminClient path by injecting our fake via the graph deps: the
  // orchestrator uses adminClient(env) internally, so we override that via a
  // globalThis shim used by tests only — actually the module resolves it at
  // import time. Simpler: assert via runGraphIntakeCycle directly which is
  // what the scheduled handler calls, and verify no fetch to Graph occurred.
  // Since runGraphIntakeCycle constructs its own admin, we exercise the
  // pollMailbox side-effect indirectly. For alerts we require a fake admin,
  // so we call the internal helper directly by monkey-patching adminClient.
  // Instead of doing that (complex), we assert:
  //   * runGraphIntakeCycle returns []
  //   * fetch was never called
  const results = await runGraphIntakeCycle(env, admin as never, { graph: { fetchImpl } });
  eq(results.length, 0, "no polls");
  const graphCalls = calls.filter((c) => c.url.includes("graph.microsoft.com"));
  eq(graphCalls.length, 0, "no graph traffic");
  // Alert was recorded on the injected admin fake.
  const misconfigAlerts = state.alerts.filter((a) => a.alert_type === "graph_intake_misconfigured");
  eq(misconfigAlerts.length, 1, "one misconfiguration alert recorded");
});

// -----------------------------------------------------------------------
// FINDING #14: System actor semantics — audit rows use actor=null
// -----------------------------------------------------------------------

test("intake audits use actor=null (system/cron convention)", async () => {
  const { admin, state } = makeFakeAdmin(newFakeState());
  const routeDelta = (call: FetchCall) =>
    call.url.includes("/messages/delta")
      ? jsonResponse(200, {
          value: [{ id: "m1", internetMessageId: "im-1", from: { emailAddress: { address: "a@a" } }, receivedDateTime: new Date().toISOString() }],
          "@odata.deltaLink": "https://graph.microsoft.com/final",
        })
      : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, routeDelta]);
  await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl }, attemptReplyHeaders: false });
  assert(state.audit.length >= 2, "audits written");
  for (const row of state.audit) {
    eq(row.actor, null, `actor null for ${row.action}`);
  }
  // Submission still uses reserved created_by (NOT NULL constraint).
  eq(state.submissions[0].created_by, ATLAS_INTAKE_SYSTEM_ACTOR_ID, "created_by is system marker");
});

// -----------------------------------------------------------------------
// Phase 6 Checkpoint 1A — durable reset-floor behavioural coverage
// -----------------------------------------------------------------------

test("reset floor: full completed round advances the durable reset_floor", async () => {
  const { admin, state } = makeFakeAdmin(newFakeState());
  const routeDelta = (call: FetchCall) =>
    call.url.includes("/messages/delta")
      ? jsonResponse(200, {
          value: [],
          "@odata.deltaLink": "https://graph.microsoft.com/final",
        })
      : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, routeDelta]);
  const pollStartMs = Date.parse("2026-10-15T00:00:00.000Z");
  const result = await pollMailbox(FAKE_ENV, admin as never, "mbx", {
    graph: { fetchImpl },
    now: () => pollStartMs,
    attemptReplyHeaders: false,
  });
  eq(result.status, "ok", "status ok");
  // Exactly one advance call, addressed to this mailbox.
  eq(state.resetFloorAdvanceCalls.length, 1, "one advance");
  eq(state.resetFloorAdvanceCalls[0].mailbox, "mbx", "correct mailbox");
  // Value = pollStart - 24h, clamped to configured cutover.
  // Test default cutover is 2026-01-01T00:00:00.000Z, so pollStart-24h wins.
  eq(state.resetFloorAdvanceCalls[0].new_reset_floor, "2026-10-14T00:00:00.000Z", "advance value");
  // Persisted onto the state row.
  const row = state.graphState.find((r) => r.mailbox === "mbx")!;
  eq(row.reset_floor, "2026-10-14T00:00:00.000Z", "row updated");
});

test("reset floor: partial / resumable round does NOT advance the reset_floor", async () => {
  // Force page-budget exhaustion (nextLink on every page, no deltaLink)
  // so pollMailbox exits with status="ok_resumable" — same pattern as the
  // existing ">MAX pages -> ok_resumable" test above.
  const { admin, state } = makeFakeAdmin(newFakeState());
  let pageCount = 0;
  const routeDelta = (call: FetchCall) => {
    if (!call.url.startsWith("https://graph.microsoft.com/")) return null;
    if (call.url.includes("/oauth2/")) return null;
    pageCount += 1;
    return jsonResponse(200, {
      value: [],
      "@odata.nextLink": `https://graph.microsoft.com/v1.0/continuation?p=${pageCount + 1}`,
      // NO deltaLink → round never completes in this tick.
    });
  };
  const { fetchImpl } = makeFetchMock([tokenRoute, routeDelta]);
  const result = await pollMailbox(FAKE_ENV, admin as never, "mbx", {
    graph: { fetchImpl },
    now: () => Date.parse("2026-10-15T00:00:00.000Z"),
    attemptReplyHeaders: false,
  });
  eq(result.status, "ok_resumable", "status ok_resumable");
  eq(state.resetFloorAdvanceCalls.length, 0, "no advance calls on resumable round");
});

test("reset floor: 410 reset uses max(configured_cutover, persisted_reset_floor)", async () => {
  const { admin, state } = makeFakeAdmin(newFakeState());
  // Pre-seed a persisted reset floor much later than the configured cutover
  // (test-default cutover = 2026-01-01T00:00:00.000Z).
  state.graphState.push({
    mailbox: "mbx",
    delta_link: null,
    in_round_next_link: null,
    last_polled_at: null,
    last_success_at: null,
    last_error: null,
    consecutive_failures: 0,
    poll_in_flight_since: null,
    lease_id: null,
    breaker_opened_at: null,
    last_failure_at: null,
    next_attempt_after: null,
    reset_floor: "2026-06-15T00:00:00.000Z",
  });
  // Capture the URL of the first delta request. That's the initial URL
  // Atlas sends — it must carry the FLOOR's cutover, not the configured one.
  let firstDeltaUrl: string | null = null;
  const routeDelta = (call: FetchCall) => {
    if (!call.url.includes("/messages/delta")) return null;
    if (firstDeltaUrl == null) firstDeltaUrl = call.url;
    return jsonResponse(200, { value: [], "@odata.deltaLink": "https://graph.microsoft.com/final" });
  };
  const { fetchImpl } = makeFetchMock([tokenRoute, routeDelta]);
  await pollMailbox(FAKE_ENV, admin as never, "mbx", {
    graph: { fetchImpl },
    attemptReplyHeaders: false,
  });
  assert(firstDeltaUrl != null, "captured initial URL");
  const capturedUrl = firstDeltaUrl as string;
  assert(capturedUrl.includes("2026-06-15T00%3A00%3A00.000Z"), "floor is in initial URL");
  assert(!capturedUrl.includes("2026-01-01T00%3A00%3A00.000Z"), "configured cutover NOT in URL");
});

test("reset floor: never precedes the configured cutover", async () => {
  const { admin, state } = makeFakeAdmin(newFakeState());
  // Pre-seed a floor OLDER than the configured cutover — should never
  // reach the URL. The runtime's maxIsoUtc + the RPC's monotonic guard
  // both defend this.
  state.graphState.push({
    mailbox: "mbx",
    delta_link: null,
    in_round_next_link: null,
    last_polled_at: null,
    last_success_at: null,
    last_error: null,
    consecutive_failures: 0,
    poll_in_flight_since: null,
    lease_id: null,
    breaker_opened_at: null,
    last_failure_at: null,
    next_attempt_after: null,
    reset_floor: "2025-01-01T00:00:00.000Z",
  });
  let firstDeltaUrl: string | null = null;
  const routeDelta = (call: FetchCall) => {
    if (!call.url.includes("/messages/delta")) return null;
    if (firstDeltaUrl == null) firstDeltaUrl = call.url;
    return jsonResponse(200, { value: [], "@odata.deltaLink": "https://graph.microsoft.com/final" });
  };
  const { fetchImpl } = makeFetchMock([tokenRoute, routeDelta]);
  await pollMailbox(FAKE_ENV, admin as never, "mbx", {
    graph: { fetchImpl },
    attemptReplyHeaders: false,
  });
  const captured = firstDeltaUrl as string | null;
  assert(captured != null, "captured initial URL");
  const url2 = captured as string;
  assert(url2.includes("2026-01-01T00%3A00%3A00.000Z"), "configured cutover used, not the older floor");
  assert(!url2.includes("2025-01-01"), "old floor never leaks to URL");
});

test("reset floor: repeated fully-completed rounds are idempotent and monotonic", async () => {
  const { admin, state } = makeFakeAdmin(newFakeState());
  // Respond to BOTH the initial /messages/delta URL and the persisted
  // delta_link continuation URL — the second poll resumes from delta_link,
  // not initialDeltaUrl, so the route must match both.
  const routeDelta = (call: FetchCall) =>
    (call.url.includes("/messages/delta") || call.url.includes("/final"))
      ? jsonResponse(200, { value: [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/users/mbx/mailFolders/Inbox/messages/delta?$deltatoken=final" })
      : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, routeDelta]);
  const t1 = Date.parse("2026-10-15T00:00:00.000Z");
  const t2 = Date.parse("2026-10-16T00:00:00.000Z");
  await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl }, now: () => t1, attemptReplyHeaders: false });
  await pollMailbox(FAKE_ENV, admin as never, "mbx", { graph: { fetchImpl }, now: () => t2, attemptReplyHeaders: false });
  eq(state.resetFloorAdvanceCalls.length, 2, "one call per completed round");
  eq(state.resetFloorAdvanceCalls[0].new_reset_floor, "2026-10-14T00:00:00.000Z", "first advance");
  eq(state.resetFloorAdvanceCalls[1].new_reset_floor, "2026-10-15T00:00:00.000Z", "second advance");
  // Monotonic: DB kept the newer value.
  const row = state.graphState.find((r) => r.mailbox === "mbx")!;
  eq(row.reset_floor, "2026-10-15T00:00:00.000Z", "row holds the newer floor");
});

// -----------------------------------------------------------------------
// Phase 6 Checkpoint 1A — cutover-missing alert dedup
// -----------------------------------------------------------------------

test("cutover-missing: two consecutive polls insert exactly one operational alert", async () => {
  const { admin, state } = makeFakeAdmin(newFakeState());
  // Env WITHOUT any cutover (no per-mailbox JSON, no test default) →
  // pollMailbox refuses AND inserts a critical alert on the first call.
  const noCutoverEnv = {
    ATLAS_GRAPH_INTAKE_ENABLED: "true",
    ATLAS_GRAPH_TENANT_ID: "t",
    ATLAS_GRAPH_CLIENT_ID: "c",
    ATLAS_GRAPH_CLIENT_SECRET: "s",
    ATLAS_GRAPH_MAILBOXES_JSON: JSON.stringify(["mbx"]),
    // no ATLAS_GRAPH_TEST_DEFAULT_CUTOVER
  } as unknown as Parameters<typeof pollMailbox>[0];
  const { fetchImpl } = makeFetchMock([tokenRoute]);
  const r1 = await pollMailbox(noCutoverEnv, admin as never, "mbx", { graph: { fetchImpl } });
  eq(r1.status, "skipped_cutover_missing", "first poll refused");
  eq(state.alerts.length, 1, "one alert inserted on first refusal");
  eq(state.alerts[0].alert_type, "graph_intake_cutover_missing", "correct alert type");
  const r2 = await pollMailbox(noCutoverEnv, admin as never, "mbx", { graph: { fetchImpl } });
  eq(r2.status, "skipped_cutover_missing", "second poll refused");
  eq(state.alerts.length, 1, "still one alert — dedup held across the minute-cron");
});

// -----------------------------------------------------------------------
// Runner
// -----------------------------------------------------------------------

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
  console.log(`\nPhase 19b behavioural: ${passed} passed, ${failed} failed out of ${tests.length}`);
  if (failed > 0 && typeof process !== "undefined") process.exitCode = 1;
})();
