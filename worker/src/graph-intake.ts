/**
 * Atlas Phase 5A — Microsoft Graph intake orchestrator (Checkpoint 2 hardened)
 * ----------------------------------------------------------------------------
 * Fenced Postgres-backed leases, atomic new-submission ingest via RPC,
 * durable resumable page checkpoint, breaker state independent of the poll
 * anchor, honored 429 Retry-After, checked audit/alert writes, PII-safe
 * error paths, and a canonical message-id contract shared with graph-client.
 *
 * The pure logic is factored so tests can drive it with an in-memory admin
 * fake that only speaks the small handful of table/RPC calls this file uses.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { graphIntakeEnabled, graphIntakeMailboxes, type Env } from "./config.js";
import {
  acquireGraphToken,
  canonicalMessageId,
  fetchDeltaPage,
  fetchInternetMessageHeaders,
  GraphError,
  initialDeltaUrl,
  isRemovedEvent,
  type GraphAccessToken,
  type GraphClientDeps,
  type GraphMessage,
} from "./graph-client.js";
import {
  correlate,
  type CorrelationLookups,
  type CorrelationOutcome,
  type OpenSubmissionRef,
} from "./graph-intake-correlation.js";
import { buildAlert } from "./phase8-core.js";

// System-actor UUID kept for atlas_submissions.created_by (NOT NULL, no FK).
// audit rows written by the poller use actor = NULL because atlas_audit_logs
// treats NULL actor as "system/cron" and we must not fabricate human identity.
export const ATLAS_INTAKE_SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00005a1a5a1a";

export const POLL_LEASE_STALE_MS = 5 * 60_000;
export const CIRCUIT_BREAKER_FAILURES = 10;
export const CIRCUIT_BREAKER_COOLDOWN_MS = 15 * 60_000;
/**
 * Per-tick page budget. Reaching this cap does NOT lose data — the last
 * successful nextLink is persisted as `in_round_next_link` and the next tick
 * resumes from it. See handleResumableEnd().
 */
export const MAX_DELTA_PAGES_PER_POLL = 50;

// ---------------------------------------------------------------------------
// Injection surfaces
// ---------------------------------------------------------------------------

export interface IntakeDeps {
  /** Injected fetch / clock for Graph. */
  graph?: GraphClientDeps;
  /** Injected clock. */
  now?: () => number;
  /**
   * When true, correlation attempts the reply-header rule (Rule 5). Requires
   * one extra Graph GET per message that reached it. Defaults to true.
   */
  attemptReplyHeaders?: boolean;
  /**
   * Optional lease-id generator (tests inject predictable IDs). Defaults to
   * crypto.randomUUID().
   */
  generateLeaseId?: () => string;
}

export interface PollResult {
  mailbox: string;
  pagesFetched: number;
  messagesConsidered: number;
  duplicates: number;
  attached: number;
  needsReview: number;
  newSubmissions: number;
  removedEvents: number;
  status:
    | "ok"
    | "ok_resumable"
    | "skipped_disabled"
    | "skipped_locked"
    | "skipped_breaker"
    | "skipped_throttled"
    | "skipped_lease_lost"
    | "failed";
  errorCode?: string;
}

// ---------------------------------------------------------------------------
// PII-safe hash for audit metadata
// ---------------------------------------------------------------------------

export async function safeHash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

// ---------------------------------------------------------------------------
// PII-safe error logging
// ---------------------------------------------------------------------------

/**
 * Whitelisted logger. Only fixed classified codes reach console — never
 * anything that could carry sender, subject, body preview, or Supabase's
 * echo of the failed row.
 */
function logIntakeError(params: {
  code: string;
  mailboxHash?: string;
  intakeMessageIdHash?: string;
  submissionIdHash?: string;
}): void {
  console.error("atlas_graph_intake_error", {
    code: params.code,
    mailbox_hash: params.mailboxHash ?? null,
    intake_message_id_hash: params.intakeMessageIdHash ?? null,
    submission_id_hash: params.submissionIdHash ?? null,
    ts: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// State model
// ---------------------------------------------------------------------------

interface GraphStateRow {
  mailbox: string;
  delta_link: string | null;
  in_round_next_link: string | null;
  last_polled_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  poll_in_flight_since: string | null;
  lease_id: string | null;
  breaker_opened_at: string | null;
  last_failure_at: string | null;
  next_attempt_after: string | null;
}

// ---------------------------------------------------------------------------
// Lease acquire / release via RPC (fenced by lease_id)
// ---------------------------------------------------------------------------

interface AcquireResult {
  kind: "acquired" | "locked" | "throttled" | "breaker_open";
  row?: GraphStateRow;
  leaseId?: string;
}

export async function acquireMailboxLease(
  admin: SupabaseClient,
  mailbox: string,
  nowMs: number,
  deps: IntakeDeps = {},
): Promise<AcquireResult> {
  const leaseId = (deps.generateLeaseId ?? crypto.randomUUID.bind(crypto))();
  const nowIso = new Date(nowMs).toISOString();
  const staleCutoffIso = new Date(nowMs - POLL_LEASE_STALE_MS).toISOString();

  const { data, error } = await admin.rpc("atlas_intake_acquire_lease", {
    p_mailbox: mailbox,
    p_stale_cutoff_iso: staleCutoffIso,
    p_new_lease_id: leaseId,
    p_now: nowIso,
  });
  if (error) {
    throw new Error("intake_lease_acquire_failed");
  }
  const row = (Array.isArray(data) ? data[0] : data) as GraphStateRow | undefined;
  if (!row) {
    // Distinguish throttled/breaker/locked so operators see the right status.
    // We can only tell them apart from a read; do a cheap follow-up SELECT.
    const { data: current } = await admin
      .from("atlas_intake_graph_state")
      .select("mailbox, next_attempt_after, breaker_opened_at, poll_in_flight_since, consecutive_failures, last_polled_at, last_success_at")
      .eq("mailbox", mailbox)
      .maybeSingle();
    if (current?.next_attempt_after && Date.parse(current.next_attempt_after) > nowMs) {
      return { kind: "throttled" };
    }
    if (current?.breaker_opened_at) {
      const opened = Date.parse(current.breaker_opened_at);
      if (Number.isFinite(opened) && opened + CIRCUIT_BREAKER_COOLDOWN_MS > nowMs) {
        return { kind: "breaker_open" };
      }
    }
    return { kind: "locked" };
  }
  // Post-acquire breaker check: if the breaker is open and cooldown not yet
  // elapsed, release immediately without a Graph call. Uses breaker_opened_at
  // — never last_polled_at — so acquisition cannot move the cooldown anchor.
  if (row.breaker_opened_at) {
    const opened = Date.parse(row.breaker_opened_at);
    if (Number.isFinite(opened) && opened + CIRCUIT_BREAKER_COOLDOWN_MS > nowMs) {
      await releaseLease(admin, mailbox, leaseId, {}, {});
      return { kind: "breaker_open" };
    }
  }
  return { kind: "acquired", row, leaseId };
}

interface ReleaseState {
  deltaLink?: string | null;
  inRoundNextLink?: string | null;
  lastError?: string | null;
  consecutiveFailures?: number;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  breakerOpenedAt?: string | null;
  breakerProvided?: boolean;
  nextAttemptAfter?: string | null;
  nextAttemptProvided?: boolean;
}

async function releaseLease(
  admin: SupabaseClient,
  mailbox: string,
  expectedLeaseId: string,
  state: ReleaseState,
  _flags: unknown,
): Promise<{ ok: boolean }> {
  const { data, error } = await admin.rpc("atlas_intake_release_lease", {
    p_mailbox: mailbox,
    p_expected_lease_id: expectedLeaseId,
    p_delta_link: state.deltaLink ?? null,
    p_delta_link_provided: state.deltaLink !== undefined,
    p_in_round_next_link: state.inRoundNextLink ?? null,
    p_in_round_provided: state.inRoundNextLink !== undefined,
    p_last_error: state.lastError ?? null,
    p_consecutive_failures: state.consecutiveFailures ?? null,
    p_last_success_at: state.lastSuccessAt ?? null,
    p_last_failure_at: state.lastFailureAt ?? null,
    p_breaker_opened_at: state.breakerOpenedAt ?? null,
    p_breaker_provided: Boolean(state.breakerProvided),
    p_next_attempt_after: state.nextAttemptAfter ?? null,
    p_next_attempt_provided: Boolean(state.nextAttemptProvided),
  });
  if (error) return { ok: false };
  const row = (Array.isArray(data) ? data[0] : data) as { mailbox?: string } | undefined;
  return { ok: Boolean(row?.mailbox) };
}

// ---------------------------------------------------------------------------
// Correlation lookups
// ---------------------------------------------------------------------------

function buildLookups(admin: SupabaseClient): CorrelationLookups {
  return {
    async findByGraphMessageId(mailbox, graphMessageId) {
      const { data } = await admin
        .from("atlas_submission_intake_messages")
        .select("id, submission_id")
        .eq("mailbox", mailbox)
        .eq("graph_message_id", graphMessageId)
        .limit(1)
        .maybeSingle();
      return data ? { id: data.id as string, submission_id: data.submission_id as string } : null;
    },
    async findByInternetMessageId(internetMessageId) {
      const { data } = await admin
        .from("atlas_submission_intake_messages")
        .select("id, submission_id")
        .eq("internet_message_id", internetMessageId)
        .limit(1)
        .maybeSingle();
      return data ? { id: data.id as string, submission_id: data.submission_id as string } : null;
    },
    async findSubmissionsByConversationId(conversationId) {
      const { data } = await admin
        .from("atlas_submission_intake_messages")
        .select("submission_id, atlas_submissions!inner(id, pipeline_stage)")
        .eq("conversation_id", conversationId);
      const rows = (data ?? []) as Array<{ submission_id: string; atlas_submissions?: { pipeline_stage?: string | null } | null }>;
      const seen = new Set<string>();
      const out: OpenSubmissionRef[] = [];
      for (const row of rows) {
        if (seen.has(row.submission_id)) continue;
        seen.add(row.submission_id);
        out.push({ id: row.submission_id, pipeline_stage: row.atlas_submissions?.pipeline_stage ?? null });
      }
      return out;
    },
    async findByParentMessageIds(messageIds) {
      if (messageIds.length === 0) return [];
      const { data } = await admin
        .from("atlas_submission_intake_messages")
        .select("submission_id, atlas_submissions!inner(id, pipeline_stage)")
        .in("internet_message_id", messageIds);
      const rows = (data ?? []) as Array<{ submission_id: string; atlas_submissions?: { pipeline_stage?: string | null } | null }>;
      return rows.map((row) => ({
        submission_id: row.submission_id,
        pipeline_stage: row.atlas_submissions?.pipeline_stage ?? null,
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// Message projection
// ---------------------------------------------------------------------------

function projectRecipients(
  message: GraphMessage,
): Array<{ role: "to" | "cc"; name: string | null; address: string | null }> {
  const out: Array<{ role: "to" | "cc"; name: string | null; address: string | null }> = [];
  for (const r of message.toRecipients ?? []) {
    out.push({
      role: "to",
      name: r?.emailAddress?.name ?? null,
      address: r?.emailAddress?.address ?? null,
    });
  }
  for (const r of message.ccRecipients ?? []) {
    out.push({
      role: "cc",
      name: r?.emailAddress?.name ?? null,
      address: r?.emailAddress?.address ?? null,
    });
  }
  return out;
}

/** Parse Graph's ISO-8601 receivedDateTime; null if invalid. */
function parseReceivedAt(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const ms = Date.parse(String(raw));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

interface IngestFields {
  mailbox: string;
  graphMessageId: string;
  internetMessageId: string | null;
  conversationId: string | null;
  senderName: string | null;
  senderAddress: string | null;
  recipients: unknown;
  subject: string | null;
  bodyPreview: string | null;
  receivedAt: string | null;
  hasAttachments: boolean;
  processingState: "processed" | "needs_review";
}

function projectFields(mailbox: string, message: GraphMessage, processingState: "processed" | "needs_review"): IngestFields {
  return {
    mailbox,
    graphMessageId: message.id,
    internetMessageId: canonicalMessageId(message.internetMessageId ?? null),
    conversationId: message.conversationId ?? null,
    senderName: message.from?.emailAddress?.name ?? null,
    senderAddress: message.from?.emailAddress?.address ?? null,
    recipients: projectRecipients(message),
    subject: message.subject ?? null,
    bodyPreview: message.bodyPreview ?? null,
    receivedAt: parseReceivedAt(message.receivedDateTime),
    hasAttachments: Boolean(message.hasAttachments),
    processingState,
  };
}

// ---------------------------------------------------------------------------
// Atomic ingest via RPC
// ---------------------------------------------------------------------------

interface IngestNewResult {
  outcome: "created" | "duplicate_internet_message_id" | "duplicate_graph_message_id";
  submissionId: string;
  intakeMessageId: string;
}

async function ingestNewEmail(
  admin: SupabaseClient,
  fields: IngestFields,
  correlationRule: string,
  mailboxHash: string,
  graphMessageIdHash: string,
): Promise<IngestNewResult> {
  const { data, error } = await admin.rpc("atlas_intake_ingest_new_email", {
    p_system_actor_id: ATLAS_INTAKE_SYSTEM_ACTOR_ID,
    p_source_type: "email",
    p_pipeline_stage: "new",
    p_queue_status: "new",
    p_status: "new",
    p_priority: "normal",
    p_next_action: "Review intake",
    p_received_at: fields.receivedAt,
    p_mailbox: fields.mailbox,
    p_graph_message_id: fields.graphMessageId,
    p_internet_message_id: fields.internetMessageId,
    p_conversation_id: fields.conversationId,
    p_sender_name: fields.senderName,
    p_sender_address: fields.senderAddress,
    p_recipients: fields.recipients,
    p_subject: fields.subject,
    p_body_preview: fields.bodyPreview,
    p_has_attachments: fields.hasAttachments,
    p_processing_state: fields.processingState,
    // Atomic audit metadata (safe: no sender/subject/body).
    p_correlation_rule: correlationRule,
    p_mailbox_hash: mailboxHash,
    p_graph_message_id_hash: graphMessageIdHash,
  });
  if (error) throw new IntakeDbError("intake_ingest_new_failed");
  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome: string; submission_id: string; intake_message_id: string }
    | undefined;
  if (!row) throw new IntakeDbError("intake_ingest_new_returned_no_row");
  return {
    outcome: row.outcome as IngestNewResult["outcome"],
    submissionId: String(row.submission_id),
    intakeMessageId: String(row.intake_message_id),
  };
}

interface AttachResult {
  outcome: "attached" | "duplicate_internet_message_id" | "duplicate_graph_message_id";
  intakeMessageId: string;
}

async function attachIntakeMessage(
  admin: SupabaseClient,
  submissionId: string,
  fields: IngestFields,
  correlationRule: string,
  mailboxHash: string,
  graphMessageIdHash: string,
): Promise<AttachResult> {
  const { data, error } = await admin.rpc("atlas_intake_attach_message", {
    p_submission_id: submissionId,
    p_mailbox: fields.mailbox,
    p_graph_message_id: fields.graphMessageId,
    p_internet_message_id: fields.internetMessageId,
    p_conversation_id: fields.conversationId,
    p_sender_name: fields.senderName,
    p_sender_address: fields.senderAddress,
    p_recipients: fields.recipients,
    p_subject: fields.subject,
    p_body_preview: fields.bodyPreview,
    p_received_at: fields.receivedAt,
    p_has_attachments: fields.hasAttachments,
    p_processing_state: fields.processingState,
    // Atomic audit metadata (safe: no sender/subject/body).
    p_correlation_rule: correlationRule,
    p_mailbox_hash: mailboxHash,
    p_graph_message_id_hash: graphMessageIdHash,
  });
  if (error) throw new IntakeDbError("intake_attach_failed");
  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome: string; intake_message_id: string }
    | undefined;
  if (!row) throw new IntakeDbError("intake_attach_returned_no_row");
  return {
    outcome: row.outcome as AttachResult["outcome"],
    intakeMessageId: String(row.intake_message_id),
  };
}

/**
 * Transactional needs-review ingest. Creates the review-container submission,
 * the needs_review intake row, the required audit event, AND the operational
 * alert in one SQL transaction — no partial states possible.
 */
async function ingestNeedsReview(
  admin: SupabaseClient,
  fields: IngestFields,
  correlationRule: string,
  mailboxHash: string,
  graphMessageIdHash: string,
  candidateSubmissionIds: string[],
): Promise<IngestNewResult> {
  const { data, error } = await admin.rpc("atlas_intake_ingest_needs_review", {
    p_system_actor_id: ATLAS_INTAKE_SYSTEM_ACTOR_ID,
    p_source_type: "email",
    p_pipeline_stage: "new",
    p_queue_status: "new",
    p_status: "new",
    p_priority: "normal",
    p_next_action: "Review intake",
    p_received_at: fields.receivedAt,
    p_mailbox: fields.mailbox,
    p_graph_message_id: fields.graphMessageId,
    p_internet_message_id: fields.internetMessageId,
    p_conversation_id: fields.conversationId,
    p_sender_name: fields.senderName,
    p_sender_address: fields.senderAddress,
    p_recipients: fields.recipients,
    p_subject: fields.subject,
    p_body_preview: fields.bodyPreview,
    p_has_attachments: fields.hasAttachments,
    p_correlation_rule: correlationRule,
    p_mailbox_hash: mailboxHash,
    p_graph_message_id_hash: graphMessageIdHash,
    p_candidate_ids: candidateSubmissionIds,
    p_alert_title: "Ambiguous intake correlation",
    p_alert_message: "An email matched more than one open case. Operator review is required.",
  });
  if (error) throw new IntakeDbError("intake_needs_review_failed");
  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome: string; submission_id: string; intake_message_id: string }
    | undefined;
  if (!row) throw new IntakeDbError("intake_needs_review_returned_no_row");
  return {
    outcome: row.outcome as IngestNewResult["outcome"],
    submissionId: String(row.submission_id),
    intakeMessageId: String(row.intake_message_id),
  };
}

/** Distinguish DB-side failures from other error classes for the caller. */
class IntakeDbError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.name = "IntakeDbError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Per-message processing
// ---------------------------------------------------------------------------

interface ProcessMessageOutcome {
  kind: "duplicate" | "attach" | "needs_review" | "new_submission" | "removed";
}

async function processSingleMessage(args: {
  admin: SupabaseClient;
  mailbox: string;
  message: GraphMessage;
  token: GraphAccessToken;
  deps: IntakeDeps;
}): Promise<ProcessMessageOutcome> {
  const { admin, mailbox, message, token, deps } = args;
  if (isRemovedEvent(message)) return { kind: "removed" };
  if (!message.id) return { kind: "removed" };

  const lookups = buildLookups(admin);
  const canonicalInternetId = canonicalMessageId(message.internetMessageId ?? null);
  const mailboxHash = await safeHash(mailbox);
  const graphIdHash = await safeHash(message.id);

  // Rules 1–4 first, WITHOUT fetching In-Reply-To/References. This avoids
  // extra Graph traffic for known duplicates / conversation matches and means
  // a header endpoint hiccup cannot block deterministic correlation.
  const initialOutcome: CorrelationOutcome = await correlate(
    {
      mailbox,
      graphMessageId: message.id,
      internetMessageId: canonicalInternetId,
      conversationId: message.conversationId ?? null,
      parentMessageIds: [],
    },
    lookups,
  );

  // If Rules 1–4 produced any decisive outcome, act on it and return.
  if (initialOutcome.kind === "duplicate") return { kind: "duplicate" };
  if (initialOutcome.kind === "attach") {
    return finaliseAttach(admin, mailbox, message, initialOutcome.submissionId, initialOutcome.rule, mailboxHash, graphIdHash);
  }
  if (initialOutcome.kind === "needs_review") {
    return finaliseNeedsReview(admin, mailbox, message, initialOutcome.rule, mailboxHash, graphIdHash, initialOutcome.candidateSubmissionIds);
  }

  // Rules 1–4 miss. NOW try the reply-header rule.
  let outcome: CorrelationOutcome = initialOutcome;
  if (deps.attemptReplyHeaders !== false) {
    let parentMessageIds: string[] = [];
    try {
      const headers = await fetchInternetMessageHeaders(mailbox, message.id, token, deps.graph);
      const ids = [
        ...(headers.inReplyTo ? [headers.inReplyTo] : []),
        ...headers.references,
      ];
      parentMessageIds = ids.filter((v, i, arr) => v && arr.indexOf(v) === i);
    } catch (err) {
      // 404/410 on the header endpoint is a benign "no headers"; every other
      // Graph error means we cannot deterministically decide Rule 5. In that
      // case skip Rule 5 and fall through to Rule 6 (new submission) — the
      // message is still ingested, just as a new case rather than a reply.
      if (!(err instanceof GraphError && (err.status === 404 || err.status === 410))) {
        parentMessageIds = [];
      }
    }
    if (parentMessageIds.length > 0) {
      outcome = await correlate(
        {
          mailbox,
          graphMessageId: message.id,
          internetMessageId: canonicalInternetId,
          conversationId: message.conversationId ?? null,
          parentMessageIds,
        },
        lookups,
      );
    }
  }

  if (outcome.kind === "attach") {
    return finaliseAttach(admin, mailbox, message, outcome.submissionId, outcome.rule, mailboxHash, graphIdHash);
  }
  if (outcome.kind === "needs_review") {
    return finaliseNeedsReview(admin, mailbox, message, outcome.rule, mailboxHash, graphIdHash, outcome.candidateSubmissionIds);
  }
  if (outcome.kind === "duplicate") return { kind: "duplicate" };

  // Rule 6 — new submission. Atomic ingest RPC writes the submission, intake
  // row, submission_created_from_email + intake_message_recorded audits under
  // one transaction.
  const fields = projectFields(mailbox, message, "processed");
  const ingested = await ingestNewEmail(admin, fields, outcome.rule, mailboxHash, graphIdHash);
  if (ingested.outcome !== "created") return { kind: "duplicate" };
  return { kind: "new_submission" };
}

async function finaliseAttach(
  admin: SupabaseClient,
  mailbox: string,
  message: GraphMessage,
  submissionId: string,
  rule: string,
  mailboxHash: string,
  graphIdHash: string,
): Promise<ProcessMessageOutcome> {
  const fields = projectFields(mailbox, message, "processed");
  const attach = await attachIntakeMessage(admin, submissionId, fields, rule, mailboxHash, graphIdHash);
  if (attach.outcome !== "attached") return { kind: "duplicate" };
  return { kind: "attach" };
}

async function finaliseNeedsReview(
  admin: SupabaseClient,
  mailbox: string,
  message: GraphMessage,
  rule: string,
  mailboxHash: string,
  graphIdHash: string,
  candidateSubmissionIds: string[],
): Promise<ProcessMessageOutcome> {
  const fields = projectFields(mailbox, message, "needs_review");
  const ingested = await ingestNeedsReview(admin, fields, rule, mailboxHash, graphIdHash, candidateSubmissionIds);
  if (ingested.outcome !== "created") return { kind: "duplicate" };
  return { kind: "needs_review" };
}

// ---------------------------------------------------------------------------
// Poll driver
// ---------------------------------------------------------------------------

/**
 * Choose the starting cursor for this tick. Precedence:
 *   1. in_round_next_link (mid-round checkpoint from a previous partial tick)
 *   2. delta_link         (the durable cursor of the last completed round)
 *   3. initial delta URL  (first-ever poll for this mailbox)
 */
function chooseStartCursor(row: GraphStateRow, mailbox: string): string {
  return row.in_round_next_link ?? row.delta_link ?? initialDeltaUrl(mailbox);
}

export async function pollMailbox(
  env: Env,
  admin: SupabaseClient,
  mailbox: string,
  deps: IntakeDeps = {},
): Promise<PollResult> {
  const nowFn = deps.now ?? Date.now;
  const result: PollResult = {
    mailbox,
    pagesFetched: 0,
    messagesConsidered: 0,
    duplicates: 0,
    attached: 0,
    needsReview: 0,
    newSubmissions: 0,
    removedEvents: 0,
    status: "failed",
  };

  const acquired = await acquireMailboxLease(admin, mailbox, nowFn(), deps);
  if (acquired.kind === "locked") { result.status = "skipped_locked"; return result; }
  if (acquired.kind === "throttled") { result.status = "skipped_throttled"; return result; }
  if (acquired.kind === "breaker_open") { result.status = "skipped_breaker"; return result; }
  const lease = acquired.row!;
  const leaseId = acquired.leaseId!;
  const mailboxHash = await safeHash(mailbox);

  let token: GraphAccessToken;
  try {
    token = await acquireGraphToken(env, deps.graph);
  } catch (err) {
    await recordFailure(admin, mailbox, mailboxHash, leaseId, lease, err, nowFn());
    result.status = "failed";
    result.errorCode = err instanceof GraphError ? err.code : "graph_token_failed";
    return result;
  }

  let cursor: string | null = chooseStartCursor(lease, mailbox);
  let finalDeltaLink: string | null = null;
  let pageBudgetExhausted = false;
  let lastNextLink: string | null = null;
  // Bounded delta-cursor reset: at most one restart from initialDeltaUrl per
  // poll attempt. A second delta-expired response in the same tick becomes a
  // classified failure — otherwise a persistently-expired delta could
  // indefinitely restart the loop.
  let deltaResetAttempted = false;

  try {
    while (cursor && result.pagesFetched < MAX_DELTA_PAGES_PER_POLL) {
      let page: Awaited<ReturnType<typeof fetchDeltaPage>>;
      try {
        page = await fetchDeltaPage(cursor, token, deps.graph);
      } catch (err) {
        if (err instanceof GraphError && err.deltaTokenExpired) {
          if (deltaResetAttempted) {
            throw new GraphError({
              status: err.status,
              code: "graph_delta_reset_failed",
              message: "graph_delta_reset_failed",
            });
          }
          deltaResetAttempted = true;
          cursor = initialDeltaUrl(mailbox);
          continue;
        }
        throw err;
      }
      result.pagesFetched += 1;

      for (const message of page.messages) {
        result.messagesConsidered += 1;
        if (isRemovedEvent(message)) {
          result.removedEvents += 1;
          continue;
        }
        const outcome = await processSingleMessage({ admin, mailbox, message, token, deps });
        if (outcome.kind === "duplicate") result.duplicates += 1;
        else if (outcome.kind === "attach") result.attached += 1;
        else if (outcome.kind === "needs_review") result.needsReview += 1;
        else if (outcome.kind === "new_submission") result.newSubmissions += 1;
        else if (outcome.kind === "removed") result.removedEvents += 1;
      }

      cursor = page.nextLink;
      lastNextLink = page.nextLink;
      if (page.deltaLink) finalDeltaLink = page.deltaLink;
      if (result.pagesFetched >= MAX_DELTA_PAGES_PER_POLL && page.nextLink) {
        pageBudgetExhausted = true;
      }
    }

    const nowIso = new Date(nowFn()).toISOString();
    const buildSuccessMetadata = (resumable: boolean) => ({
      mailbox_hash: mailboxHash,
      pages: result.pagesFetched,
      messages: result.messagesConsidered,
      duplicates: result.duplicates,
      attached: result.attached,
      needs_review: result.needsReview,
      new_submissions: result.newSubmissions,
      removed_events: result.removedEvents,
      resumable,
    });

    if (finalDeltaLink) {
      // Full round complete. Fenced RPC atomically advances the durable
      // cursor, clears failure/breaker/throttle state, AND writes the
      // graph_poll_success audit in one transaction. A lease-lost result
      // mutates nothing.
      const ok = await releaseLeaseSuccess(admin, mailbox, leaseId, {
        deltaLink: finalDeltaLink,
        inRoundNextLink: null,
        lastSuccessAt: nowIso,
        auditMetadata: buildSuccessMetadata(false),
      });
      if (!ok) { result.status = "skipped_lease_lost"; result.errorCode = "lease_lost"; return result; }
      result.status = "ok";
      return result;
    }

    if (pageBudgetExhausted && lastNextLink) {
      // Resumable partial tick — same atomicity guarantee; only in_round
      // checkpoint moves, delta_link is untouched.
      const ok = await releaseLeaseSuccess(admin, mailbox, leaseId, {
        inRoundNextLink: lastNextLink,
        lastSuccessAt: nowIso,
        auditMetadata: buildSuccessMetadata(true),
      });
      if (!ok) { result.status = "skipped_lease_lost"; result.errorCode = "lease_lost"; return result; }
      result.status = "ok_resumable";
      return result;
    }

    // No pages fetched at all (e.g. empty inbox on a fresh delta) — atomic
    // release + audit with no cursor change.
    const ok = await releaseLeaseSuccess(admin, mailbox, leaseId, {
      lastSuccessAt: nowIso,
      auditMetadata: buildSuccessMetadata(false),
    });
    if (!ok) { result.status = "skipped_lease_lost"; result.errorCode = "lease_lost"; return result; }
    result.status = "ok";
    return result;
  } catch (err) {
    await recordFailure(admin, mailbox, mailboxHash, leaseId, lease, err, nowFn());
    result.status = "failed";
    result.errorCode = classifyError(err);
    return result;
  }
}

/**
 * Fenced success-completion RPC wrapper. Returns true iff the transaction
 * committed under the caller's lease. On a lost fence the DB state is
 * untouched — the caller must not report a false poll success.
 */
async function releaseLeaseSuccess(
  admin: SupabaseClient,
  mailbox: string,
  leaseId: string,
  update: {
    deltaLink?: string | null;
    inRoundNextLink?: string | null;
    lastSuccessAt?: string | null;
    auditMetadata: Record<string, unknown>;
  },
): Promise<boolean> {
  const { data, error } = await admin.rpc("atlas_intake_release_lease_success", {
    p_mailbox: mailbox,
    p_expected_lease_id: leaseId,
    p_delta_link: update.deltaLink ?? null,
    p_delta_link_provided: update.deltaLink !== undefined,
    p_in_round_next_link: update.inRoundNextLink ?? null,
    p_in_round_provided: update.inRoundNextLink !== undefined,
    p_last_success_at: update.lastSuccessAt ?? null,
    p_audit_metadata: update.auditMetadata,
  });
  if (error) throw new IntakeDbError("intake_release_success_failed");
  const row = (Array.isArray(data) ? data[0] : data) as { ok?: boolean } | undefined;
  return Boolean(row?.ok);
}

function classifyError(err: unknown): string {
  if (err instanceof GraphError) return err.code;
  if (err instanceof IntakeDbError) return err.code;
  if (err instanceof Error && err.message === "intake_processing_failed") return err.message;
  return "intake_processing_failed";
}

async function recordFailure(
  admin: SupabaseClient,
  mailbox: string,
  mailboxHash: string,
  leaseId: string,
  lease: GraphStateRow,
  err: unknown,
  nowMs: number,
): Promise<void> {
  const nextFailures = (lease.consecutive_failures ?? 0) + 1;
  const code = classifyError(err);
  logIntakeError({ code, mailboxHash });

  const nowIso = new Date(nowMs).toISOString();
  const throttled = err instanceof GraphError && err.status === 429;
  const retryAfterSec = throttled ? err.retryAfterSeconds ?? 60 : null;
  const nextAttemptIso = retryAfterSec != null
    ? new Date(nowMs + retryAfterSec * 1000).toISOString()
    : null;

  // Breaker anchor selection:
  //   * If threshold has just been crossed  → open at nowIso.
  //   * If the breaker was already open AND this failure came from a probe
  //     (a poll that ran because the previous cooldown had elapsed) → re-open
  //     the breaker at nowIso for a fresh cooldown.
  //   * Otherwise (breaker was already open and this failure came from within
  //     the cooldown — should be unreachable because acquire is gated, but
  //     safe by default) preserve the existing anchor.
  const breakerJustOpened =
    nextFailures >= CIRCUIT_BREAKER_FAILURES && !lease.breaker_opened_at;
  const failedProbe =
    Boolean(lease.breaker_opened_at) &&
    nextFailures >= CIRCUIT_BREAKER_FAILURES;
  const breakerOpenedAtIso =
    breakerJustOpened || failedProbe
      ? nowIso
      : (lease.breaker_opened_at ?? null);

  await releaseLease(admin, mailbox, leaseId, {
    lastError: code,
    consecutiveFailures: nextFailures,
    lastFailureAt: nowIso,
    breakerOpenedAt: breakerOpenedAtIso,
    breakerProvided:
      breakerJustOpened || failedProbe || Boolean(lease.breaker_opened_at),
    nextAttemptAfter: nextAttemptIso,
    nextAttemptProvided: retryAfterSec != null,
  }, {});

  const alertClass =
    err instanceof GraphError && (err.status === 401 || err.status === 403 || err.status === 404);
  if (alertClass || breakerJustOpened) {
    // Alert insertion best-effort here: a failure recording an alert must not
    // itself trigger unbounded log noise.
    await admin.from("atlas_operational_alerts").insert(
      buildAlert({
        alertType: alertClass ? "graph_intake_auth_failure" : "graph_intake_failure_repeated",
        severity: alertClass ? "critical" : "warning",
        title: alertClass ? "Graph intake authentication failed" : "Graph intake repeatedly failing",
        message: alertClass
          ? "Atlas could not authenticate to Microsoft Graph. Check the intake app configuration."
          : "Atlas has recorded many consecutive Graph intake failures; the poller is temporarily paused.",
        metadata: {
          mailbox_hash: mailboxHash,
          consecutive_failures: nextFailures,
          error_code: code,
        },
      }),
    ).then(() => undefined, () => undefined);
  }

  // Best-effort failure audit (already the failure path — logging here is
  // enough if the audit table itself is misbehaving).
  await admin
    .from("atlas_audit_logs")
    .insert({
      submission_id: null,
      action: "graph_poll_failed",
      actor: null,
      metadata_json: {
        mailbox_hash: mailboxHash,
        error_code: code,
        consecutive_failures: nextFailures,
      },
    })
    .then(() => undefined, () => undefined);
}

// ---------------------------------------------------------------------------
// Scheduled entry (dependency-injected admin)
// ---------------------------------------------------------------------------

/**
 * Run one full Graph intake cycle for every configured mailbox. `admin` is the
 * privileged Supabase client — callers building for production compose it via
 * adminClient(env) in the module that owns that runtime dependency
 * (graph-intake-endpoints.ts). Behavioural tests pass an in-memory fake.
 *
 * When the feature flag is off, or the mailbox list is missing/malformed, this
 * function performs NO Graph work.
 */
export async function runGraphIntakeCycle(
  env: Env,
  admin: SupabaseClient,
  deps: IntakeDeps = {},
): Promise<PollResult[]> {
  if (!graphIntakeEnabled(env)) return [];
  const mailboxes = graphIntakeMailboxes(env);
  if (mailboxes.length === 0) {
    try {
      const { data: existing } = await admin
        .from("atlas_operational_alerts")
        .select("id")
        .eq("alert_type", "graph_intake_misconfigured")
        .in("status", ["open", "acknowledged"])
        .limit(1)
        .maybeSingle();
      if (!existing?.id) {
        await admin.from("atlas_operational_alerts").insert(
          buildAlert({
            alertType: "graph_intake_misconfigured",
            severity: "warning",
            title: "Graph intake is enabled but no mailboxes are configured",
            message: "Set ATLAS_GRAPH_MAILBOXES_JSON to a JSON array of mailboxes, or disable ATLAS_GRAPH_INTAKE_ENABLED.",
          }),
        );
      }
    } catch {
      /* alert insertion failure must not block scheduled() */
    }
    return [];
  }
  const results: PollResult[] = [];
  for (const mailbox of mailboxes) {
    const result = await pollMailbox(env, admin, mailbox, deps);
    results.push(result);
  }
  return results;
}

// Test-only exports — pollMailbox is already exported.
export const __testables = {
  releaseLease,
  releaseLeaseSuccess,
  ingestNewEmail,
  attachIntakeMessage,
  ingestNeedsReview,
};
