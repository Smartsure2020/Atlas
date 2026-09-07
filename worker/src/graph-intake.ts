/**
 * Atlas Phase 5A — Microsoft Graph intake orchestrator
 * ----------------------------------------------------------------------------
 * Ties graph-client (transport) and graph-intake-correlation (rules) together
 * with:
 *   * a Postgres-backed cross-isolate lease so two Workers cannot poll the
 *     same mailbox concurrently;
 *   * delta-cursor pagination whose durable persistence never advances past
 *     an unprocessed page;
 *   * idempotent submission creation and intake-message persistence;
 *   * safe operational failure recording (auth-class error backoff);
 *   * privacy-safe audit events (no PII, no delta link, no tokens).
 *
 * The public entry points are:
 *   * `runGraphIntakeCycle(env, ctx)` — called from scheduled() every minute
 *     when ATLAS_GRAPH_INTAKE_ENABLED === "true".
 *   * `handleGraphPollNow(env, user)` — the narrow admin, non-prod poll
 *     endpoint that uses the same implementation.
 *
 * The bulk of the file is written against an injectable `IntakeDeps`
 * interface so tests exercise it without a live Supabase.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { adminClient, audit, json, jsonError, type AtlasUser } from "./auth";
import { graphIntakeEnabled, graphIntakeMailboxes, type Env } from "./config";
import {
  acquireGraphToken,
  fetchDeltaPage,
  fetchInternetMessageHeaders,
  GraphError,
  initialDeltaUrl,
  isRemovedEvent,
  type GraphAccessToken,
  type GraphClientDeps,
  type GraphMessage,
} from "./graph-client";
import {
  correlate,
  type CorrelationLookups,
  type CorrelationOutcome,
  type OpenSubmissionRef,
} from "./graph-intake-correlation";
import { buildAlert } from "./phase8-core";
import { logOperationError } from "./phase6-hardening";

// A dedicated system-actor UUID for submissions created by the intake poller.
// atlas_submissions.created_by is NOT NULL and carries no FK to auth.users,
// so a well-known reserved UUID is a safe system-ownership marker. Not a real
// user; used only for created_by on Phase 5A email-created submissions and as
// a stable actor tag in audit rows the poller writes.
export const ATLAS_INTAKE_SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00005a1a5a1a";

/**
 * Lease duration. Above this a stale lease is considered abandoned and can
 * be reclaimed by another Worker isolate. Chosen well above a typical delta
 * poll (< 10 s) so a fast concurrent invocation cannot preempt a live one.
 */
export const POLL_LEASE_STALE_MS = 5 * 60_000;

/** Persistent-failure threshold above which the poller stops calling Graph. */
export const CIRCUIT_BREAKER_FAILURES = 10;

/** Circuit-breaker cooldown once tripped. */
export const CIRCUIT_BREAKER_COOLDOWN_MS = 15 * 60_000;

/** Maximum pages fetched per poll — a defensive bound against runaway delta. */
export const MAX_DELTA_PAGES_PER_POLL = 50;

export interface IntakeDeps {
  /** Injected fetch for Graph. */
  graph?: GraphClientDeps;
  /** Injected clock. */
  now?: () => number;
  /**
   * When true, correlation attempts the reply-header rule (Rule 5). Requires
   * one extra Graph GET per message that reached it. Defaults to true.
   */
  attemptReplyHeaders?: boolean;
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
  status: "ok" | "skipped_disabled" | "skipped_locked" | "skipped_breaker" | "failed";
  errorCode?: string;
}

// ---------------------------------------------------------------------------
// PII-safe hashing for audit metadata
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex hash used to fingerprint identifiers in audit metadata without
 * storing the underlying string. Non-reversible, collision-resistant enough
 * to correlate poll runs referencing the same message without exposing the
 * value itself.
 */
export async function safeHash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

// ---------------------------------------------------------------------------
// Small helpers to project a Graph message into DB row shape
// ---------------------------------------------------------------------------

interface IntakeRowInsert {
  submission_id: string;
  source: "email";
  mailbox: string;
  graph_message_id: string;
  internet_message_id: string | null;
  conversation_id: string | null;
  sender_name: string | null;
  sender_address: string | null;
  recipients: unknown;
  subject: string | null;
  body_preview: string | null;
  received_at: string | null;
  has_attachments: boolean;
  processing_state: "processed" | "needs_review";
}

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

function buildIntakeRow(input: {
  mailbox: string;
  message: GraphMessage;
  submissionId: string;
  processingState: "processed" | "needs_review";
}): IntakeRowInsert {
  const m = input.message;
  return {
    submission_id: input.submissionId,
    source: "email",
    mailbox: input.mailbox,
    graph_message_id: m.id,
    internet_message_id: m.internetMessageId ?? null,
    conversation_id: m.conversationId ?? null,
    sender_name: m.from?.emailAddress?.name ?? null,
    sender_address: m.from?.emailAddress?.address ?? null,
    recipients: projectRecipients(m),
    subject: m.subject ?? null,
    body_preview: m.bodyPreview ?? null,
    received_at: m.receivedDateTime ?? null,
    has_attachments: Boolean(m.hasAttachments),
    processing_state: input.processingState,
  };
}

// ---------------------------------------------------------------------------
// Postgres-backed lease + delta-state operations
// ---------------------------------------------------------------------------

interface GraphStateRow {
  mailbox: string;
  delta_link: string | null;
  last_polled_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  poll_in_flight_since: string | null;
}

/**
 * Acquire the mailbox poll lease atomically.
 *
 * The row is created on first observation (delta_link null). The UPDATE only
 * succeeds if either the previous lease is null or older than the staleness
 * cutoff — this is the CAS guarantee that keeps two isolates from polling
 * the same mailbox simultaneously.
 */
export async function acquireMailboxLease(
  admin: SupabaseClient,
  mailbox: string,
  nowMs: number,
): Promise<GraphStateRow | null> {
  const nowIso = new Date(nowMs).toISOString();
  const staleCutoffIso = new Date(nowMs - POLL_LEASE_STALE_MS).toISOString();

  // Ensure the row exists. Upsert-style; if the row already exists we skip
  // the insert error.
  await admin
    .from("atlas_intake_graph_state")
    .insert({ mailbox, consecutive_failures: 0 })
    .then(() => undefined, () => undefined);

  // CAS: only claim when nobody holds the lease or the previous one is stale.
  const { data } = await admin
    .from("atlas_intake_graph_state")
    .update({ poll_in_flight_since: nowIso, last_polled_at: nowIso })
    .eq("mailbox", mailbox)
    .or(`poll_in_flight_since.is.null,poll_in_flight_since.lt.${staleCutoffIso}`)
    .select("mailbox, delta_link, last_polled_at, last_success_at, last_error, consecutive_failures, poll_in_flight_since")
    .maybeSingle();

  return (data as GraphStateRow | null) ?? null;
}

export async function releaseMailboxLease(
  admin: SupabaseClient,
  mailbox: string,
  update: {
    deltaLink?: string | null;
    lastError?: string | null;
    consecutiveFailures?: number;
    lastSuccessAt?: string | null;
  },
): Promise<void> {
  const patch: Record<string, unknown> = { poll_in_flight_since: null };
  if (update.deltaLink !== undefined) patch.delta_link = update.deltaLink;
  if (update.lastError !== undefined) patch.last_error = update.lastError;
  if (update.consecutiveFailures !== undefined) patch.consecutive_failures = update.consecutiveFailures;
  if (update.lastSuccessAt !== undefined) patch.last_success_at = update.lastSuccessAt;
  await admin.from("atlas_intake_graph_state").update(patch).eq("mailbox", mailbox);
}

// ---------------------------------------------------------------------------
// Correlation lookups against Supabase
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
      const out: OpenSubmissionRef[] = [];
      const seen = new Set<string>();
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
// Submission creation and intake persistence
// ---------------------------------------------------------------------------

async function createIntakeSubmission(
  admin: SupabaseClient,
  now: string,
): Promise<string | null> {
  // Server owns every ownership/state field. Nothing from email content leaks
  // into created_by, assigned_to, pipeline_stage or queue_status.
  const { data, error } = await admin
    .from("atlas_submissions")
    .insert({
      created_by: ATLAS_INTAKE_SYSTEM_ACTOR_ID,
      source_type: "email",
      status: "new",
      queue_status: "new",
      pipeline_stage: "new",
      received_at: now,
      last_pipeline_stage_changed_at: now,
      priority: "normal",
      next_action: "Review intake",
    })
    .select("id")
    .single();
  if (error || !data) {
    logOperationError({
      endpoint: "graph_intake",
      operation: "create_email_submission",
      code: "create_failed",
      status: 500,
      errorName: error?.message,
    });
    return null;
  }
  return String(data.id);
}

/**
 * Insert an intake row idempotently. The two dedup UNIQUE indexes catch the
 * race where two Workers see the same message before either has committed —
 * the loser's INSERT fails with a unique-violation and we treat it as a
 * duplicate no-op.
 */
async function persistIntakeRow(
  admin: SupabaseClient,
  row: IntakeRowInsert,
): Promise<{ id: string } | null> {
  const { data, error } = await admin
    .from("atlas_submission_intake_messages")
    .insert(row)
    .select("id")
    .single();
  if (!error && data) return { id: String(data.id) };
  // Unique-violation is expected under concurrent polls — swallow safely.
  const code = ((error as unknown as { code?: string })?.code ?? "").toString();
  if (code === "23505") return null;
  logOperationError({
    endpoint: "graph_intake",
    operation: "persist_intake_row",
    code: "intake_insert_failed",
    status: 500,
    errorName: error?.message,
  });
  return null;
}

// ---------------------------------------------------------------------------
// Per-message processing
// ---------------------------------------------------------------------------

interface ProcessMessageArgs {
  admin: SupabaseClient;
  env: Env;
  mailbox: string;
  message: GraphMessage;
  token: GraphAccessToken;
  deps: IntakeDeps;
}

interface ProcessMessageOutcome {
  kind: "duplicate" | "attach" | "needs_review" | "new_submission" | "removed";
  intakeId?: string;
}

async function processSingleMessage(args: ProcessMessageArgs): Promise<ProcessMessageOutcome> {
  const { admin, env, mailbox, message, token, deps } = args;
  if (isRemovedEvent(message)) return { kind: "removed" };
  if (!message.id) return { kind: "removed" };

  const lookups = buildLookups(admin);
  // Reply headers require one extra request. Defer until Rules 1..4 have not
  // matched, but the correlate() call needs the values upfront to preserve
  // ordering — perform the fetch only when the message has neither an already
  // seen id nor a conversation match (checked below via a light pre-pass).
  //
  // To keep correlate() a pure function we simply attempt to fetch the
  // headers ahead of time; the small extra Graph call is scoped by the
  // enabled feature flag and the fact that we only process brand-new
  // messages here (Rule 1/2 duplicates are re-tested by correlate() itself
  // and short-circuit before the parent-message lookup runs).
  let parentMessageIds: string[] = [];
  if (deps.attemptReplyHeaders !== false) {
    try {
      const headers = await fetchInternetMessageHeaders(mailbox, message.id, token, deps.graph);
      const ids = [
        ...(headers.inReplyTo ? [headers.inReplyTo] : []),
        ...headers.references,
      ];
      parentMessageIds = ids.filter((v, i, arr) => v && arr.indexOf(v) === i);
    } catch (err) {
      if (err instanceof GraphError && (err.status === 404 || err.status === 410)) {
        parentMessageIds = [];
      } else {
        throw err;
      }
    }
  }

  const outcome: CorrelationOutcome = await correlate(
    {
      mailbox,
      graphMessageId: message.id,
      internetMessageId: message.internetMessageId ?? null,
      conversationId: message.conversationId ?? null,
      parentMessageIds,
    },
    lookups,
  );

  const nowIso = new Date((deps.now ?? Date.now)()).toISOString();

  if (outcome.kind === "duplicate") {
    return { kind: "duplicate" };
  }

  if (outcome.kind === "attach") {
    const row = buildIntakeRow({
      mailbox,
      message,
      submissionId: outcome.submissionId,
      processingState: "processed",
    });
    const inserted = await persistIntakeRow(admin, row);
    if (!inserted) return { kind: "duplicate" };
    const graphIdHash = await safeHash(message.id);
    await audit(env, {
      submissionId: outcome.submissionId,
      action: "intake_message_correlated",
      actorId: ATLAS_INTAKE_SYSTEM_ACTOR_ID,
      metadata: {
        intake_message_id: inserted.id,
        correlation_rule_matched: outcome.rule,
        graph_message_id_hash: graphIdHash,
      },
    });
    return { kind: "attach", intakeId: inserted.id };
  }

  if (outcome.kind === "needs_review") {
    // A safe intake-review container: a new submission that is intentionally
    // pipeline_stage='new' and carries no fabricated correlation. Candidate
    // ids are only recorded in the audit metadata for operator triage.
    const reviewSubmissionId = await createIntakeSubmission(admin, nowIso);
    if (!reviewSubmissionId) return { kind: "duplicate" };
    const row = buildIntakeRow({
      mailbox,
      message,
      submissionId: reviewSubmissionId,
      processingState: "needs_review",
    });
    const inserted = await persistIntakeRow(admin, row);
    if (!inserted) return { kind: "duplicate" };
    const graphIdHash = await safeHash(message.id);
    await audit(env, {
      submissionId: reviewSubmissionId,
      action: "intake_correlation_needs_review",
      actorId: ATLAS_INTAKE_SYSTEM_ACTOR_ID,
      metadata: {
        intake_message_id: inserted.id,
        correlation_rule_matched: outcome.rule,
        graph_message_id_hash: graphIdHash,
        candidate_submission_ids: outcome.candidateSubmissionIds,
      },
    });
    // Also register an operational alert; message text is bland.
    await admin.from("atlas_operational_alerts").insert(
      buildAlert({
        alertType: "intake_correlation_needs_review",
        severity: "warning",
        title: "Ambiguous intake correlation",
        message: "An email matched more than one open case. Operator review is required.",
        relatedSubmissionId: reviewSubmissionId,
        metadata: {
          intake_message_id: inserted.id,
          candidate_count: outcome.candidateSubmissionIds.length,
          rule: outcome.rule,
        },
      }),
    );
    return { kind: "needs_review", intakeId: inserted.id };
  }

  // outcome.kind === "new_submission"
  const submissionId = await createIntakeSubmission(admin, nowIso);
  if (!submissionId) return { kind: "duplicate" };
  const row = buildIntakeRow({
    mailbox,
    message,
    submissionId,
    processingState: "processed",
  });
  const inserted = await persistIntakeRow(admin, row);
  if (!inserted) return { kind: "duplicate" };
  const graphIdHash = await safeHash(message.id);
  await audit(env, {
    submissionId,
    action: "submission_created_from_email",
    actorId: ATLAS_INTAKE_SYSTEM_ACTOR_ID,
    metadata: {
      intake_message_id: inserted.id,
      correlation_rule_matched: outcome.rule,
      graph_message_id_hash: graphIdHash,
      mailbox_hash: await safeHash(mailbox),
    },
  });
  await audit(env, {
    submissionId,
    action: "intake_message_recorded",
    actorId: ATLAS_INTAKE_SYSTEM_ACTOR_ID,
    metadata: { intake_message_id: inserted.id },
  });
  return { kind: "new_submission", intakeId: inserted.id };
}

// ---------------------------------------------------------------------------
// Poll driver
// ---------------------------------------------------------------------------

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

  const lease = await acquireMailboxLease(admin, mailbox, nowFn());
  if (!lease) {
    result.status = "skipped_locked";
    return result;
  }

  // Circuit breaker: once we've hit the failure threshold, refuse to hammer
  // Graph until the cooldown expires. Uses last_polled_at as the anchor — the
  // lease acquisition above already updated it.
  if (lease.consecutive_failures >= CIRCUIT_BREAKER_FAILURES) {
    const lastSuccess = lease.last_success_at ? Date.parse(lease.last_success_at) : 0;
    const anchor = lastSuccess || (lease.last_polled_at ? Date.parse(lease.last_polled_at) : 0);
    if (anchor && nowFn() - anchor < CIRCUIT_BREAKER_COOLDOWN_MS) {
      await releaseMailboxLease(admin, mailbox, {});
      result.status = "skipped_breaker";
      return result;
    }
  }

  let token: GraphAccessToken;
  try {
    token = await acquireGraphToken(env, deps.graph);
  } catch (err) {
    await recordFailure(admin, mailbox, lease.consecutive_failures, err, env);
    result.status = "failed";
    result.errorCode = err instanceof GraphError ? err.code : "graph_token_failed";
    return result;
  }

  // Cursor bootstrap: reuse the persisted deltaLink, otherwise start from the
  // initial delta URL. deltaLink is treated as sensitive operational state —
  // never logged.
  let cursor: string | null = lease.delta_link ?? initialDeltaUrl(mailbox);
  let finalDeltaLink: string | null = null;
  let processingHadFailure = false;

  try {
    while (cursor && result.pagesFetched < MAX_DELTA_PAGES_PER_POLL) {
      let page: Awaited<ReturnType<typeof fetchDeltaPage>>;
      try {
        page = await fetchDeltaPage(cursor, token, deps.graph);
      } catch (err) {
        if (err instanceof GraphError && err.deltaTokenExpired) {
          // Reset cursor and try again from the beginning — but only for this
          // poll cycle. Do NOT persist the reset yet; if the subsequent
          // fetches fail we must retain a safe state.
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
        try {
          const outcome = await processSingleMessage({ admin, env, mailbox, message, token, deps });
          if (outcome.kind === "duplicate") result.duplicates += 1;
          else if (outcome.kind === "attach") result.attached += 1;
          else if (outcome.kind === "needs_review") result.needsReview += 1;
          else if (outcome.kind === "new_submission") result.newSubmissions += 1;
          else if (outcome.kind === "removed") result.removedEvents += 1;
        } catch (err) {
          // A per-message failure must not advance the durable cursor. Record
          // and abort the poll so the next tick retries the same batch.
          processingHadFailure = true;
          logOperationError({
            endpoint: "graph_intake",
            operation: "process_message",
            code: "intake_process_failed",
            status: 500,
            errorName: err instanceof Error ? err.name : "unknown",
          });
          throw err;
        }
      }

      cursor = page.nextLink;
      if (page.deltaLink) {
        finalDeltaLink = page.deltaLink;
      }
    }

    // Only advance the durable delta cursor after every page in the round has
    // processed successfully.
    if (processingHadFailure) {
      throw new Error("intake_processing_failed");
    }

    await releaseMailboxLease(admin, mailbox, {
      deltaLink: finalDeltaLink ?? lease.delta_link ?? null,
      lastError: null,
      consecutiveFailures: 0,
      lastSuccessAt: new Date(nowFn()).toISOString(),
    });
    await audit(env, {
      submissionId: null,
      action: "graph_poll_success",
      actorId: ATLAS_INTAKE_SYSTEM_ACTOR_ID,
      metadata: {
        mailbox_hash: await safeHash(mailbox),
        pages: result.pagesFetched,
        messages: result.messagesConsidered,
        duplicates: result.duplicates,
        attached: result.attached,
        needs_review: result.needsReview,
        new_submissions: result.newSubmissions,
        removed_events: result.removedEvents,
      },
    });
    result.status = "ok";
    return result;
  } catch (err) {
    await recordFailure(admin, mailbox, lease.consecutive_failures, err, env);
    result.status = "failed";
    result.errorCode = err instanceof GraphError ? err.code : "intake_processing_failed";
    return result;
  }
}

async function recordFailure(
  admin: SupabaseClient,
  mailbox: string,
  previousFailures: number,
  err: unknown,
  env: Env,
): Promise<void> {
  const nextFailures = previousFailures + 1;
  const code =
    err instanceof GraphError ? err.code :
    err instanceof Error ? "intake_processing_failed" :
    "graph_error";
  await releaseMailboxLease(admin, mailbox, {
    lastError: code,
    consecutiveFailures: nextFailures,
  });
  // Auth-class failures and reaching the breaker warrant an operational alert
  // — the transient warning of a single 5xx does not.
  const alertClass =
    err instanceof GraphError && (err.status === 401 || err.status === 403 || err.status === 404);
  if (alertClass || nextFailures >= CIRCUIT_BREAKER_FAILURES) {
    await admin.from("atlas_operational_alerts").insert(
      buildAlert({
        alertType: alertClass ? "graph_intake_auth_failure" : "graph_intake_failure_repeated",
        severity: alertClass ? "critical" : "warning",
        title: alertClass ? "Graph intake authentication failed" : "Graph intake repeatedly failing",
        message: alertClass
          ? "Atlas could not authenticate to Microsoft Graph. Check the intake app configuration."
          : "Atlas has recorded many consecutive Graph intake failures; the poller is temporarily paused.",
        metadata: {
          mailbox_hash: await safeHash(mailbox),
          consecutive_failures: nextFailures,
          error_code: code,
        },
      }),
    );
  }
  await audit(env, {
    submissionId: null,
    action: "graph_poll_failed",
    actorId: ATLAS_INTAKE_SYSTEM_ACTOR_ID,
    metadata: {
      mailbox_hash: await safeHash(mailbox),
      error_code: code,
      consecutive_failures: nextFailures,
    },
  });
}

// ---------------------------------------------------------------------------
// Scheduled entry + admin poll endpoint
// ---------------------------------------------------------------------------

export async function runGraphIntakeCycle(env: Env, deps: IntakeDeps = {}): Promise<PollResult[]> {
  if (!graphIntakeEnabled(env)) return [];
  const mailboxes = graphIntakeMailboxes(env);
  if (mailboxes.length === 0) return [];
  const admin = adminClient(env);
  const results: PollResult[] = [];
  // Sequential per-mailbox is fine at once-per-minute cadence: keeps rate
  // pressure on Graph gentle and simplifies the audit trail.
  for (const mailbox of mailboxes) {
    const result = await pollMailbox(env, admin, mailbox, deps);
    results.push(result);
  }
  return results;
}

export async function handleGraphPollNow(
  env: Env,
  user: AtlasUser,
  deps: IntakeDeps = {},
): Promise<Response> {
  if (user.role !== "admin") {
    return jsonError("permission_denied", 403, "Only administrators may trigger an on-demand intake poll.");
  }
  // Non-production only. Production activation belongs to the later live
  // integration checkpoint.
  if (env.ATLAS_ENV === "production") {
    return jsonError("permission_denied", 403, "Manual intake polling is disabled in production.");
  }
  if (!graphIntakeEnabled(env)) {
    return jsonError("validation_failed", 400, "Graph intake is not enabled in this environment.");
  }
  const results = await runGraphIntakeCycle(env, deps);
  // Response body contains counts only. No mailbox identifiers, no subjects,
  // no delta link, no tokens.
  return json({
    ok: true,
    polls: results.map((result) => ({
      status: result.status,
      pages_fetched: result.pagesFetched,
      messages_considered: result.messagesConsidered,
      duplicates: result.duplicates,
      attached: result.attached,
      needs_review: result.needsReview,
      new_submissions: result.newSubmissions,
      removed_events: result.removedEvents,
      error_code: result.errorCode ?? null,
    })),
  });
}

// ---------------------------------------------------------------------------
// Intake message read endpoint
// ---------------------------------------------------------------------------

export async function handleListSubmissionIntakeMessages(
  submissionId: string,
  env: Env,
  // Access is gated by canAccessSubmission upstream. user is accepted here so
  // future scoping decisions (e.g. broker-specific projections) can be added
  // without changing the router signature.
  _user: AtlasUser,
): Promise<Response> {
  const admin = adminClient(env);
  const { data, error } = await admin
    .from("atlas_submission_intake_messages")
    .select(
      "id, source, sender_name, sender_address, subject, body_preview, received_at, has_attachments, ingested_at, processing_state",
    )
    .eq("submission_id", submissionId)
    .order("received_at", { ascending: true })
    .limit(500);
  if (error) return jsonError("internal_error", 500, "Could not load intake messages.");
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  // Broker sees the same content shape as staff for their own submission —
  // access is already gated in the router by canAccessSubmission. We
  // deliberately do NOT expose Graph internals (mailbox, message id,
  // internet_message_id, conversation_id) here to anyone.
  return json({
    ok: true,
    intake_messages: rows.map((row) => ({
      id: row.id,
      source: row.source,
      sender: {
        name: row.sender_name ?? null,
        address: row.sender_address ?? null,
      },
      subject: row.subject ?? null,
      body_preview: row.body_preview ?? null,
      received_at: row.received_at ?? null,
      has_attachments: row.has_attachments ?? false,
      ingested_at: row.ingested_at ?? null,
      processing_state: row.processing_state ?? null,
    })),
  });
}
