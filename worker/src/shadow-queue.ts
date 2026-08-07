/**
 * Atlas hybrid pipeline — shadow queue producer + consumer
 * ----------------------------------------------------------------------------
 *
 * Why this module exists
 * ----------------------
 * Cloudflare HTTP `ctx.waitUntil()` allows only ~30 seconds of work after the
 * response is sent. The hybrid shadow path polls Azure Document Intelligence
 * for up to 60 seconds, and a Sonnet resolution round can take longer still,
 * so `waitUntil` can be cancelled mid-run and the shadow evidence turns up
 * partial or missing.
 *
 * Cloudflare Queues are the right primitive for this workload: the consumer
 * has a substantially longer wall-clock budget, delivery is reliable, and
 * failures can be classified and retried (or dead-lettered) without ever
 * touching the authoritative legacy response.
 *
 * Contract
 * --------
 *
 *   Producer (HTTP path):
 *     After legacy is persisted and the job is `completed`, if this
 *     fingerprint is deterministically sampled, we `await queue.send(msg)`
 *     where `msg` contains ONLY identifiers (see ShadowQueueMessage). If
 *     enqueue fails or the binding is missing we record a privacy-safe
 *     `shadow_enqueue_skipped` / `shadow_enqueue_failed` metric and return —
 *     the legacy response is never affected.
 *
 *   Consumer (Queue trigger):
 *     Reservation on (input_fingerprint, pipeline_version) prevents duplicate
 *     provider calls. The hybrid orchestrator runs with
 *     `legacyFallbackAllowed: false`. Idempotency is enforced BOTH by the
 *     reservation table AND by the (input_fingerprint, pipeline_version)
 *     unique constraint on atlas_pipeline_shadow_comparisons. Duplicate
 *     deliveries and simultaneous duplicate deliveries never write twice.
 *
 * The consumer never mutates authoritative extraction rows and never changes
 * the authoritative job status.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "./config.js";
import type {
  runHybridExtraction as runHybridExtractionRef,
  DocumentRow,
  HybridExtractionResult,
} from "./hybrid-orchestrator.js";

type RunHybridExtractionType = typeof runHybridExtractionRef;
import { compareExtractions, writeShadowComparison } from "./hybrid-shadow.js";
import { EXTRACTION_SCHEMA_VERSION } from "./extraction.js";
import { emitPipelineMetric } from "./pipeline-telemetry.js";
import { PIPELINE_VERSION } from "./pipeline-version.js";

// ---------------------------------------------------------------------------
// Message schema
// ---------------------------------------------------------------------------

/**
 * Minimum viable identifier payload. Deliberately excludes PDF bytes,
 * extracted text, client details, risk addresses, and any other PII.
 * If a field cannot be verified as safe, it does NOT go on the wire.
 */
export interface ShadowQueueMessage {
  v: 1;
  submissionId: string;
  legacyExtractionId: string;
  legacyJobId: string;
  inputFingerprint: string;
  pipelineVersion: string;
  /** For safe cross-tenant lookup if RLS ever needs it. */
  organisationId?: string | null;
  enqueuedAt: number;
  /** Redacted legacy timing/tokens so the consumer can persist a comparison
   *  without re-reading the legacy job. Numbers only — no content. */
  legacyTotals: {
    totalMs: number;
    inputTokens: number;
    outputTokens: number;
  };
}

/** Set of allow-listed keys we permit on a shadow queue message. */
const ALLOWED_MESSAGE_KEYS = new Set<keyof ShadowQueueMessage>([
  "v",
  "submissionId",
  "legacyExtractionId",
  "legacyJobId",
  "inputFingerprint",
  "pipelineVersion",
  "organisationId",
  "enqueuedAt",
  "legacyTotals",
]);
const ALLOWED_TOTALS_KEYS = new Set<keyof ShadowQueueMessage["legacyTotals"]>([
  "totalMs",
  "inputTokens",
  "outputTokens",
]);

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Validate a message BEFORE enqueue (defence in depth against accidental PII
 * inclusion) and AFTER dequeue (defence against malformed/legacy messages).
 * Returns null when the message is safe; otherwise a short reason.
 */
export function validateShadowMessage(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return "not_object";
  const msg = raw as Record<string, unknown>;
  for (const key of Object.keys(msg)) {
    if (!ALLOWED_MESSAGE_KEYS.has(key as keyof ShadowQueueMessage)) {
      return `unexpected_key:${key.slice(0, 24)}`;
    }
  }
  if (msg.v !== 1) return "unknown_version";
  if (typeof msg.submissionId !== "string" || !UUID_RE.test(msg.submissionId)) return "bad_submission_id";
  if (typeof msg.legacyExtractionId !== "string" || !UUID_RE.test(msg.legacyExtractionId)) return "bad_extraction_id";
  if (typeof msg.legacyJobId !== "string" || !UUID_RE.test(msg.legacyJobId)) return "bad_job_id";
  if (typeof msg.inputFingerprint !== "string" || msg.inputFingerprint.length === 0 || msg.inputFingerprint.length > 128) return "bad_fingerprint";
  if (typeof msg.pipelineVersion !== "string" || msg.pipelineVersion.length === 0 || msg.pipelineVersion.length > 40) return "bad_pipeline_version";
  if (msg.organisationId != null && (typeof msg.organisationId !== "string" || msg.organisationId.length > 64)) return "bad_org_id";
  if (typeof msg.enqueuedAt !== "number" || !Number.isFinite(msg.enqueuedAt)) return "bad_enqueued_at";
  const t = msg.legacyTotals as Record<string, unknown> | undefined;
  if (!t || typeof t !== "object") return "bad_totals";
  for (const key of Object.keys(t)) {
    if (!ALLOWED_TOTALS_KEYS.has(key as keyof ShadowQueueMessage["legacyTotals"])) {
      return `unexpected_totals_key:${key.slice(0, 24)}`;
    }
  }
  if (typeof t.totalMs !== "number" || typeof t.inputTokens !== "number" || typeof t.outputTokens !== "number") {
    return "bad_totals_numbers";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Producer
// ---------------------------------------------------------------------------

export type ShadowEnqueueOutcome =
  | { ok: true }
  | { ok: false; reason: "queue_binding_missing" }
  | { ok: false; reason: "invalid_message"; detail: string }
  | { ok: false; reason: "send_failed"; detail: string };

/**
 * Enqueue the shadow message. Never throws.
 *
 * If the queue binding is missing OR the send fails, we record a
 * privacy-safe metric and return an outcome. The caller MUST NOT invoke
 * `ctx.waitUntil(runShadowInBackground(...))` as a fallback — document
 * processing must happen in the queue consumer or nowhere.
 */
export async function enqueueShadowMessage(
  env: Env,
  admin: SupabaseClient,
  message: ShadowQueueMessage
): Promise<ShadowEnqueueOutcome> {
  const invalid = validateShadowMessage(message);
  if (invalid) {
    await emitPipelineMetric(admin, {
      pipelineMode: "shadow",
      route: "failed",
      finalStatus: "shadow",
      jobId: message.legacyJobId,
      submissionId: message.submissionId,
      fallbackReason: `shadow_enqueue_invalid:${invalid}`,
      metadata: { shadow_enqueue_status: "invalid_message" },
    });
    return { ok: false, reason: "invalid_message", detail: invalid };
  }

  if (!env.ATLAS_SHADOW_QUEUE || typeof env.ATLAS_SHADOW_QUEUE.send !== "function") {
    await emitPipelineMetric(admin, {
      pipelineMode: "shadow",
      route: "failed",
      finalStatus: "shadow",
      jobId: message.legacyJobId,
      submissionId: message.submissionId,
      fallbackReason: "shadow_enqueue_skipped:queue_binding_missing",
      metadata: { shadow_enqueue_status: "queue_binding_missing" },
    });
    return { ok: false, reason: "queue_binding_missing" };
  }

  try {
    await env.ATLAS_SHADOW_QUEUE.send(message, { contentType: "json" });
    return { ok: true };
  } catch (err) {
    const detail = (err as Error)?.message?.slice(0, 80) ?? "unknown";
    await emitPipelineMetric(admin, {
      pipelineMode: "shadow",
      route: "failed",
      finalStatus: "shadow",
      jobId: message.legacyJobId,
      submissionId: message.submissionId,
      fallbackReason: `shadow_enqueue_failed:${detail}`,
      metadata: { shadow_enqueue_status: "send_failed" },
    });
    return { ok: false, reason: "send_failed", detail };
  }
}

// ---------------------------------------------------------------------------
// Consumer
// ---------------------------------------------------------------------------

/** Transient failures are retryable; permanent ones are not. */
const TRANSIENT_CODES = new Set([
  "azure_rate_limited",
  "azure_server_error",
  "azure_network_failure",
  "anthropic_rate_limited",
  "anthropic_server_error",
  "anthropic_network_failure",
  "haiku_call_failed",
  "storage_unavailable",
  "database_transient",
]);

const PERMANENT_CODES = new Set([
  "document_missing",
  "invalid_identifiers",
  "cross_tenant_mismatch",
  "encrypted",
  "unsupported",
  "azure_auth_failed",
  "schema_incompatible",
  "invalid_configuration",
]);

export function classifyFailure(errorCode: string | null | undefined): "transient" | "permanent" {
  if (!errorCode) return "transient";
  if (PERMANENT_CODES.has(errorCode)) return "permanent";
  if (TRANSIENT_CODES.has(errorCode)) return "transient";
  // Unknown => treat as transient once, but rely on max_retries to bound retries.
  return "transient";
}

// Minimal shape we consume from a Cloudflare Queue message wrapper.
// Kept structural so tests can pass in a plain object.
export interface QueueMessageLike<T = unknown> {
  id: string;
  timestamp: Date | string | number;
  body: T;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface QueueBatchLike<T = unknown> {
  messages: readonly QueueMessageLike<T>[];
}

export interface ConsumerDeps {
  /** Required — index.ts passes adminClient. Kept as a dep so the consumer
   *  module has zero direct dependency on @supabase/supabase-js's runtime. */
  buildAdmin: (env: Env) => SupabaseClient;
  /** Required — index.ts passes the real orchestrator. */
  runHybrid: RunHybridExtractionType;
}

/**
 * Process one queue batch. Each message ack/retries independently so a bad
 * message does not poison the batch. Never throws — every failure path is
 * classified and acknowledged or retried by the consumer.
 */
export async function handleShadowQueueBatch(
  batch: QueueBatchLike<ShadowQueueMessage>,
  env: Env,
  deps: ConsumerDeps
): Promise<void> {
  const admin = deps.buildAdmin(env);

  for (const msg of batch.messages) {
    await processOne(msg, env, admin, deps.runHybrid);
  }
}

async function processOne(
  msg: QueueMessageLike<ShadowQueueMessage>,
  env: Env,
  admin: SupabaseClient,
  runHybrid: RunHybridExtractionType
): Promise<void> {
  const body = msg.body;
  const queueDelayMs = computeQueueDelayMs(msg, body);

  // ---- 1. Validate message shape / verify identifiers -------------------
  const invalid = validateShadowMessage(body);
  if (invalid) {
    await recordPermanentFailure(admin, body, {
      code: "invalid_identifiers",
      reason: `bad_message:${invalid}`,
      queueDelayMs,
    });
    msg.ack();
    return;
  }
  if (body.pipelineVersion !== PIPELINE_VERSION) {
    // Version mismatch → schema-incompatible for the running consumer. This is
    // a permanent condition for THIS deployment; a later deploy with the
    // matching version can re-shadow the same fingerprint.
    await recordPermanentFailure(admin, body, {
      code: "schema_incompatible",
      reason: `pipeline_version_mismatch:${body.pipelineVersion.slice(0, 24)}`,
      queueDelayMs,
    });
    msg.ack();
    return;
  }

  // ---- 2. Reservation (idempotency + concurrent-duplicate guard) --------
  const reservation = await tryReserve(admin, body);
  if (reservation.outcome === "already_completed") {
    // Duplicate delivery of a fingerprint we've already shadowed. No-op.
    msg.ack();
    return;
  }
  if (reservation.outcome === "already_failed_permanent") {
    msg.ack();
    return;
  }
  if (reservation.outcome === "already_processing") {
    // Another consumer holds a still-valid lease. DO NOT ack — that would
    // silently drop the retry if the lease-holder crashes before releasing.
    // Delay-retry so the queue redelivers after the lease could plausibly
    // expire (see LEASE_TTL_MS). The producer set enqueuedAt for us, so
    // wall-clock drift here is bounded by the queue's own backoff.
    msg.retry({ delaySeconds: RETRY_ON_ACTIVE_LEASE_SECONDS });
    return;
  }
  if (reservation.outcome === "reservation_error") {
    // Database transient; let the queue retry with backoff.
    msg.retry();
    return;
  }
  const ownerToken = reservation.ownerToken;

  // ---- 3. Load submission + documents (revalidate ownership) ------------
  const loaded = await loadDocumentsForShadow(admin, body);
  if (!loaded.ok) {
    if (loaded.classification === "permanent") {
      await recordPermanentFailure(admin, body, {
        code: loaded.code,
        reason: loaded.reason,
        queueDelayMs,
      });
      // Release the reservation to failed_permanent so retries don't spin.
      await releaseReservation(admin, body, ownerToken, "failed_permanent");
      msg.ack();
    } else {
      await releaseReservation(admin, body, ownerToken, "queued");
      msg.retry();
    }
    return;
  }

  // ---- 4. Cross-tenant check (organisationId, if provided) --------------
  if (body.organisationId && loaded.submission.organisation_id != null &&
      String(loaded.submission.organisation_id) !== body.organisationId) {
    await recordPermanentFailure(admin, body, {
      code: "cross_tenant_mismatch",
      reason: "org_id_mismatch",
      queueDelayMs,
    });
    await releaseReservation(admin, body, ownerToken, "failed_permanent");
    msg.ack();
    return;
  }

  // Legacy extraction row (needed for the field-by-field comparison).
  const legacyExtraction = await loadLegacyExtraction(admin, body.legacyExtractionId);

  // ---- 5. Run hybrid (shadow) — legacy fallback forbidden ----------------
  const processingStartedAt = Date.now();
  let hybrid: HybridExtractionResult;
  try {
    hybrid = await runHybrid(
      {
        submissionId: body.submissionId,
        brokerEmailBody: loaded.submission.broker_email_body ?? null,
        documents: loaded.docs,
      },
      {
        admin,
        env,
        jobId: body.legacyJobId,
        mode: "shadow",
        legacyFallbackAllowed: false, // ABSOLUTE — consumer must never run legacy.
        onStage: async () => {}, // do NOT mutate the completed job's stage
      }
    );
  } catch (err) {
    const detail = (err as Error)?.message?.slice(0, 80) ?? "unknown";
    const errCode = (err as { code?: string })?.code ?? "haiku_call_failed";
    const classification = classifyFailure(errCode);
    if (classification === "permanent") {
      await recordPermanentFailure(admin, body, {
        code: errCode,
        reason: `orchestrator_threw:${detail}`,
        queueDelayMs,
      });
      await releaseReservation(admin, body, ownerToken, "failed_permanent");
      msg.ack();
    } else {
      await emitPipelineMetric(admin, {
        pipelineMode: "shadow",
        route: "failed",
        model: null,
        jobId: body.legacyJobId,
        submissionId: body.submissionId,
        finalStatus: "shadow",
        totalMs: Date.now() - processingStartedAt,
        fallbackReason: `transient:${errCode}`,
        metadata: {
          shadow_queue_delay_ms: queueDelayMs,
          shadow_processing_ms: Date.now() - processingStartedAt,
        },
      });
      // Release the lease BEFORE msg.retry() so the redelivery can reacquire.
      await releaseReservation(admin, body, ownerToken, "queued");
      msg.retry();
    }
    return;
  }

  // The orchestrator returns HybridExtractionResult even on internal
  // failure. Classify by errorCode so retriable provider outages retry.
  if (hybrid.status === "failed") {
    const classification = classifyFailure(hybrid.errorCode);
    if (classification === "transient") {
      await emitPipelineMetric(admin, {
        pipelineMode: "shadow",
        route: hybrid.route,
        model: hybrid.normalisationModel ?? null,
        jobId: body.legacyJobId,
        submissionId: body.submissionId,
        finalStatus: "shadow",
        totalMs: Date.now() - processingStartedAt,
        fallbackReason: `transient:${hybrid.errorCode ?? "unknown"}`,
        metadata: {
          shadow_queue_delay_ms: queueDelayMs,
          shadow_processing_ms: Date.now() - processingStartedAt,
        },
      });
      await releaseReservation(admin, body, ownerToken, "queued");
      msg.retry();
      return;
    }
    await recordPermanentFailure(admin, body, {
      code: hybrid.errorCode ?? "invalid_configuration",
      reason: hybrid.fallbackReason ?? "hybrid_failed",
      queueDelayMs,
    });
    await releaseReservation(admin, body, ownerToken, "failed_permanent");
    msg.ack();
    return;
  }

  // ---- 6. Persist comparison + telemetry --------------------------------
  const comparison = compareExtractions(legacyExtraction ?? null, hybrid.extraction);
  await writeShadowComparison({
    admin,
    submissionId: body.submissionId,
    legacyJobId: body.legacyJobId,
    legacyExtractionId: body.legacyExtractionId,
    inputFingerprint: body.inputFingerprint,
    pipelineVersion: body.pipelineVersion,
    extractionSchemaVersion: EXTRACTION_SCHEMA_VERSION,
    parserVersion: hybrid.parser,
    normalisationModel: hybrid.normalisationModel,
    azureModel: env.AZURE_DOCUMENT_INTELLIGENCE_MODEL ?? null,
    comparison,
    hybrid,
    legacyTotalMs: body.legacyTotals.totalMs,
    legacyInputTokens: body.legacyTotals.inputTokens,
    legacyOutputTokens: body.legacyTotals.outputTokens,
    shadowQueueDelayMs: queueDelayMs,
  });

  await emitPipelineMetric(admin, {
    pipelineMode: "shadow",
    route: hybrid.route,
    model: hybrid.normalisationModel ?? null,
    jobId: body.legacyJobId,
    submissionId: body.submissionId,
    finalStatus: "shadow",
    totalMs: hybrid.metrics.totalMs ?? undefined,
    parseMs: hybrid.metrics.parseMs ?? undefined,
    ocrMs: hybrid.metrics.ocrMs ?? undefined,
    llmTotalMs: hybrid.metrics.llmTotalMs ?? undefined,
    validationMs: hybrid.metrics.validationMs ?? undefined,
    inputTokens: hybrid.metrics.inputTokens ?? undefined,
    cachedInputTokens: hybrid.metrics.cachedInputTokens ?? undefined,
    cacheWriteTokens: hybrid.metrics.cacheWriteTokens ?? undefined,
    outputTokens: hybrid.metrics.outputTokens ?? undefined,
    fallbackReason: hybrid.fallbackReason ?? undefined,
    escalatedToSonnet: hybrid.escalatedFields.length > 0,
    metadata: {
      shadow_queue_delay_ms: queueDelayMs,
      shadow_processing_ms: Date.now() - processingStartedAt,
    },
  });

  await releaseReservation(admin, body, ownerToken, "completed");
  msg.ack();
}

// ---------------------------------------------------------------------------
// Reservation helpers — models atlas_shadow_reservations
// ---------------------------------------------------------------------------
//
// Lifecycle & compare-and-set semantics
// -------------------------------------
//
// The table has a UNIQUE(input_fingerprint, pipeline_version) index so at
// most one row exists per key. State transitions:
//
//   (insert)           -> processing (with attempt_owner_token + lease)
//   processing         -> completed        (CAS on owner_token, on success)
//   processing         -> failed_permanent (CAS on owner_token)
//   processing         -> queued           (CAS on owner_token, on transient
//                                            failure — clears owner+lease)
//   queued             -> processing       (CAS on status='queued', new owner)
//   processing[stale]  -> processing       (CAS on lease_expires_at < now,
//                                            new owner — reclaim after crash)
//
// The owner_token binds a lease to a single consumer. A late/duplicate
// consumer CANNOT release another consumer's active lease — every UPDATE
// used to release includes .eq(attempt_owner_token, ownerToken). Similarly
// the stale-lease reclaim only succeeds when the CURRENT lease has expired,
// so an active lease is never stolen even if another consumer's clock
// skewed slightly.
//
// See migration 0022_shadow_reservation_lease.sql for the columns.
//
// LEASE_TTL_MS — bounds how long a single reservation can be held. Long
// enough to accommodate Azure Document Intelligence polling (up to 60s)
// plus a couple of Sonnet resolution passes with margin. Shorter values
// shrink the crash-recovery window; longer values reduce false-reclaims
// under very slow-provider tails.

export const LEASE_TTL_MS = 10 * 60_000;
/** How long to defer a redelivery when another consumer holds an active lease. */
export const RETRY_ON_ACTIVE_LEASE_SECONDS = 30;

export type ReservationResult =
  | { outcome: "reserved"; ownerToken: string }
  | { outcome: "already_processing"; leaseExpiresAt: number | null }
  | { outcome: "already_completed" }
  | { outcome: "already_failed_permanent" }
  | { outcome: "reservation_error" };

function mintOwnerToken(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function parseIsoMs(v: unknown): number | null {
  if (v == null) return null;
  const s = typeof v === "string" ? v : String(v);
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Attempt to insert or take-over a reservation.
 *
 * Returns { outcome: "reserved", ownerToken } — the caller MUST pass this
 * token to releaseReservation() to prove ownership.
 */
export async function tryReserve(
  admin: SupabaseClient,
  body: ShadowQueueMessage
): Promise<ReservationResult> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const leaseIso = new Date(nowMs + LEASE_TTL_MS).toISOString();
  const ownerToken = mintOwnerToken();

  try {
    // Path A — fresh row.
    const { error: insErr } = await admin
      .from("atlas_shadow_reservations")
      .insert({
        input_fingerprint: body.inputFingerprint,
        pipeline_version: body.pipelineVersion,
        submission_id: body.submissionId,
        legacy_job_id: body.legacyJobId,
        status: "processing",
        started_at: nowIso,
        attempt_owner_token: ownerToken,
        lease_expires_at: leaseIso,
      });
    if (!insErr) return { outcome: "reserved", ownerToken };

    // Unique-violation — inspect the existing row.
    const { data: existing, error: selErr } = await admin
      .from("atlas_shadow_reservations")
      .select("status, started_at, lease_expires_at, attempt_owner_token")
      .eq("input_fingerprint", body.inputFingerprint)
      .eq("pipeline_version", body.pipelineVersion)
      .maybeSingle();
    if (selErr || !existing) return { outcome: "reservation_error" };

    if (existing.status === "completed") return { outcome: "already_completed" };
    if (existing.status === "failed_permanent") return { outcome: "already_failed_permanent" };

    if (existing.status === "processing") {
      const leaseMs = parseIsoMs(existing.lease_expires_at);
      // Treat a NULL lease (row written by pre-lease code) as immediately
      // expired — the code that wrote it cannot still be alive with the
      // owner token, so takeover is safe.
      const leaseStillValid = leaseMs != null && leaseMs > nowMs;
      if (leaseStillValid) {
        return { outcome: "already_processing", leaseExpiresAt: leaseMs };
      }
      // Stale — CAS takeover. `.lt(lease_expires_at, nowIso)` is atomic:
      // if another consumer just refreshed the lease, our update matches
      // zero rows and we back off. When lease_expires_at is NULL, .lt fails
      // to match (NULL < X is false), so we fall through to a status-based
      // CAS below to reclaim legacy rows.
      const takenByLease = await admin
        .from("atlas_shadow_reservations")
        .update({
          attempt_owner_token: ownerToken,
          lease_expires_at: leaseIso,
          started_at: nowIso,
        })
        .eq("input_fingerprint", body.inputFingerprint)
        .eq("pipeline_version", body.pipelineVersion)
        .eq("status", "processing")
        .lt("lease_expires_at", nowIso)
        .select();
      if (takenByLease && !takenByLease.error && Array.isArray(takenByLease.data) && takenByLease.data.length > 0) {
        return { outcome: "reserved", ownerToken };
      }
      if (leaseMs == null) {
        // Legacy pre-lease row: match by owner_token being null-equivalent
        // (older schema wrote nothing). We narrow by the row's original
        // started_at so we don't stomp a lease that WAS refreshed between
        // our SELECT and this UPDATE.
        const takenLegacy = await admin
          .from("atlas_shadow_reservations")
          .update({
            attempt_owner_token: ownerToken,
            lease_expires_at: leaseIso,
            started_at: nowIso,
          })
          .eq("input_fingerprint", body.inputFingerprint)
          .eq("pipeline_version", body.pipelineVersion)
          .eq("status", "processing")
          .eq("started_at", String(existing.started_at ?? ""))
          .select();
        if (takenLegacy && !takenLegacy.error && Array.isArray(takenLegacy.data) && takenLegacy.data.length > 0) {
          return { outcome: "reserved", ownerToken };
        }
      }
      return { outcome: "already_processing", leaseExpiresAt: leaseMs };
    }

    // Path C — status='queued' (previous consumer released after transient
    // failure). Atomic CAS: only the caller who sees status='queued' at
    // UPDATE time wins the promotion to processing.
    const promoted = await admin
      .from("atlas_shadow_reservations")
      .update({
        status: "processing",
        started_at: nowIso,
        attempt_owner_token: ownerToken,
        lease_expires_at: leaseIso,
        completed_at: null,
      })
      .eq("input_fingerprint", body.inputFingerprint)
      .eq("pipeline_version", body.pipelineVersion)
      .eq("status", "queued")
      .select();
    if (promoted && !promoted.error && Array.isArray(promoted.data) && promoted.data.length > 0) {
      return { outcome: "reserved", ownerToken };
    }
    // Lost the CAS race — someone else already promoted or completed the row.
    return { outcome: "reservation_error" };
  } catch {
    return { outcome: "reservation_error" };
  }
}

/**
 * Release the reservation held by `ownerToken`.
 *
 *   - "completed"        — terminal success; comparison row is persisted.
 *   - "failed_permanent" — terminal permanent failure; do-not-retry sentinel.
 *   - "queued"           — transient failure; row becomes retryable and the
 *                          owner_token + lease are CLEARED so the next
 *                          delivery starts a clean CAS.
 *
 * Returns true when the release actually mutated the row we own — false
 * indicates the caller's lease was already expired/reclaimed or the row was
 * mutated by another consumer.
 */
export async function releaseReservation(
  admin: SupabaseClient,
  body: ShadowQueueMessage,
  ownerToken: string,
  status: "completed" | "queued" | "failed_permanent"
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> =
    status === "queued"
      ? {
          status,
          attempt_owner_token: null,
          lease_expires_at: null,
          completed_at: null,
        }
      : {
          status,
          lease_expires_at: null,
          completed_at: nowIso,
        };
  try {
    const result = await admin
      .from("atlas_shadow_reservations")
      .update(patch)
      .eq("input_fingerprint", body.inputFingerprint)
      .eq("pipeline_version", body.pipelineVersion)
      .eq("attempt_owner_token", ownerToken)
      .select();
    return Boolean(result && !result.error && Array.isArray(result.data) && result.data.length > 0);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Document loading + legacy row lookup
// ---------------------------------------------------------------------------

type LoadOutcome =
  | { ok: true; submission: { broker_email_body: string | null; organisation_id?: string | null }; docs: DocumentRow[] }
  | { ok: false; classification: "permanent"; code: string; reason: string }
  | { ok: false; classification: "transient"; code: string; reason: string };

async function loadDocumentsForShadow(
  admin: SupabaseClient,
  body: ShadowQueueMessage
): Promise<LoadOutcome> {
  try {
    const submissionQuery = await admin
      .from("atlas_submissions")
      .select("id, broker_email_body, organisation_id")
      .eq("id", body.submissionId)
      .maybeSingle();
    if (submissionQuery.error) {
      return { ok: false, classification: "transient", code: "database_transient", reason: "submissions_select_failed" };
    }
    if (!submissionQuery.data) {
      return { ok: false, classification: "permanent", code: "document_missing", reason: "submission_not_found" };
    }

    const docsQuery = await admin
      .from("atlas_documents")
      .select("id, file_name, storage_path, document_type, status, scan_status, created_at, file_hash")
      .eq("submission_id", body.submissionId)
      .eq("status", "active")
      .in("scan_status", ["clean", "not_scanned"]);

    let docs: DocumentRow[] = [];
    if (docsQuery.error) {
      // Older schemas without file_hash / scan_status. Retry with legacy columns.
      const legacyDocs = await admin
        .from("atlas_documents")
        .select("id, file_name, storage_path, document_type, status, created_at")
        .eq("submission_id", body.submissionId)
        .eq("status", "active");
      if (legacyDocs.error) {
        return { ok: false, classification: "transient", code: "database_transient", reason: "documents_select_failed" };
      }
      docs = (legacyDocs.data ?? []) as DocumentRow[];
    } else {
      docs = (docsQuery.data ?? []) as DocumentRow[];
    }
    return {
      ok: true,
      submission: {
        broker_email_body: submissionQuery.data.broker_email_body ?? null,
        organisation_id: (submissionQuery.data as { organisation_id?: string | null }).organisation_id ?? null,
      },
      docs,
    };
  } catch {
    return { ok: false, classification: "transient", code: "database_transient", reason: "loader_threw" };
  }
}

async function loadLegacyExtraction(
  admin: SupabaseClient,
  extractionId: string
): Promise<Record<string, unknown> | null> {
  try {
    const { data } = await admin
      .from("atlas_extractions")
      .select("extracted_json")
      .eq("id", extractionId)
      .maybeSingle();
    const raw = (data as { extracted_json?: unknown } | null)?.extracted_json;
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Metrics helpers
// ---------------------------------------------------------------------------

async function recordPermanentFailure(
  admin: SupabaseClient,
  body: ShadowQueueMessage,
  args: { code: string; reason: string; queueDelayMs: number | null }
): Promise<void> {
  await emitPipelineMetric(admin, {
    pipelineMode: "shadow",
    route: "failed",
    model: null,
    jobId: body.legacyJobId,
    submissionId: body.submissionId,
    finalStatus: "shadow",
    fallbackReason: `permanent:${args.code}:${args.reason}`.slice(0, 120),
    metadata: {
      shadow_queue_delay_ms: args.queueDelayMs,
      shadow_failure_class: "permanent",
    },
  });
}

function computeQueueDelayMs(
  msg: QueueMessageLike<ShadowQueueMessage>,
  body: ShadowQueueMessage
): number | null {
  const enqueuedAt = typeof body.enqueuedAt === "number" ? body.enqueuedAt : null;
  if (enqueuedAt != null) return Math.max(0, Date.now() - enqueuedAt);
  const ts = typeof msg.timestamp === "number"
    ? msg.timestamp
    : msg.timestamp instanceof Date
      ? msg.timestamp.getTime()
      : Date.parse(String(msg.timestamp));
  return Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : null;
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _internal = {
  ALLOWED_MESSAGE_KEYS,
  ALLOWED_TOTALS_KEYS,
  TRANSIENT_CODES,
  PERMANENT_CODES,
};
