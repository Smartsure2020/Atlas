import { roleCanViewManagerDashboard } from "../worker/src/phase6-hardening.js";
import {
  activeCleanupCandidates,
  applyManualRetry,
  buildAlert,
  buildExtractionFingerprintV2,
  canRetryJob,
  canaryIsSafe,
  cancellationUpdate,
  cleanupRequiresManager,
  isRetryableError,
  nextRetryAt,
  transitionAlert,
} from "../worker/src/phase8-core.js";

declare const process: { exitCode?: number };

const tests: { name: string; fn: () => void | Promise<void> }[] = [];

function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

test("transient failures are retryable with backoff", () => {
  assertEqual(isRetryableError("timeout"), true, "timeout should retry");
  assertEqual(isRetryableError("http_503"), true, "5xx errors should retry");
  assertEqual(
    nextRetryAt({
      retryCount: 0,
      retryable: true,
      nowIso: "2026-06-29T10:00:00.000Z",
      maxRetries: 2,
    }),
    "2026-06-29T10:05:00.000Z",
    "first retry should wait five minutes"
  );
});

test("validation failures are not retried", () => {
  assertEqual(isRetryableError("validation_failed"), false, "validation failures should not retry");
  assertEqual(
    canRetryJob({ status: "failed", retry_count: 0, max_retries: 2, error_code: "validation_failed" }),
    false,
    "non-transient failed jobs should not be manually retried"
  );
});

test("manual retry increments retry count and requeues the job", () => {
  const update = applyManualRetry({ retry_count: 1, max_retries: 3, error_code: "extraction_failed" });
  assertEqual(update.status, "queued", "retry should move job back to queued");
  assertEqual(update.retry_count, 2, "retry count should increment");
  assertEqual(update.max_retries, 3, "max retries should be preserved");
});

test("cancelled jobs cannot be retried", () => {
  assertEqual(
    canRetryJob({
      status: "failed",
      retry_count: 0,
      max_retries: 2,
      error_code: "timeout",
      cancellation_requested: true,
    }),
    false,
    "cancellation request should block retry"
  );
});

test("queued cancellation completes immediately", () => {
  const update = cancellationUpdate({ status: "queued" }, "user-1");
  assertEqual(update.status, "cancelled", "queued jobs should cancel immediately");
  assertEqual(update.cancellation_requested, true, "cancellation request should be recorded");
  assertEqual(update.cancellation_requested_by, "user-1", "actor should be recorded");
});

test("running cancellation records request without silently completing", () => {
  const update = cancellationUpdate({ status: "running" }, "user-1");
  assert(!("status" in update), "running jobs should remain running until worker observes cancellation");
  assertEqual(update.cancellation_requested, true, "running jobs should record cancellation request");
});

test("file hash participates in extraction fingerprint", () => {
  const base = {
    submissionId: "sub-1",
    brokerEmailPresent: true,
    documents: [
      {
        id: "doc-1",
        storage_path: "sub-1/a.pdf",
        created_at: "2026-06-29T10:00:00.000Z",
        status: "active",
        file_hash: "hash-a",
      },
    ],
  };
  const changed = buildExtractionFingerprintV2({
    ...base,
    documents: [{ ...base.documents[0], file_hash: "hash-b" }],
  });
  assert(buildExtractionFingerprintV2(base) !== changed, "hash changes should invalidate extraction cache");
});

test("old documents without hashes still fingerprint safely", () => {
  const fingerprint = buildExtractionFingerprintV2({
    submissionId: "sub-1",
    brokerEmailPresent: false,
    documents: [
      {
        id: "doc-1",
        storage_path: "sub-1/a.pdf",
        created_at: "2026-06-29T10:00:00.000Z",
        status: "active",
      },
    ],
  });
  assert(fingerprint.length > 0, "legacy documents should still produce a fingerprint");
});

test("cleanup candidates exclude active documents", () => {
  const candidates = activeCleanupCandidates([
    { id: "active", status: "active" },
    { id: "failed", status: "failed_upload" },
    { id: "expired", status: "expired" },
  ]);
  assertEqual(candidates.length, 2, "only inactive documents should be cleanup candidates");
  assert(candidates.every((doc) => doc.status !== "active"), "active docs must not be cleanup candidates");
});

test("cleanup confirmation is manager or admin only", () => {
  assertEqual(cleanupRequiresManager("consultant"), true, "consultants should need elevation");
  assertEqual(cleanupRequiresManager("readonly"), true, "readonly users should need elevation");
  assertEqual(cleanupRequiresManager("manager"), false, "managers can confirm cleanup");
  assertEqual(cleanupRequiresManager("admin"), false, "admins can confirm cleanup");
});

test("operational alert shape is safe and stable", () => {
  const alert = buildAlert({
    alertType: "job_failed",
    severity: "critical",
    title: "extraction failed",
    message: "extraction_failed",
    relatedJobId: "job-1",
    metadata: { retryable: false },
  });
  assertEqual(alert.status, "open", "new alerts should be open");
  assertEqual(alert.related_job_id, "job-1", "alert should retain job reference");
  assertEqual(alert.metadata?.retryable, false, "alert metadata should retain safe debug context");
});

test("alerts can be acknowledged and resolved", () => {
  const acknowledged = transitionAlert({ status: "open" }, "acknowledge", "manager-1");
  assertEqual(acknowledged.status, "acknowledged", "acknowledge should update status");
  assertEqual(acknowledged.acknowledged_by, "manager-1", "acknowledge should record actor");

  const resolved = transitionAlert({ status: "acknowledged" }, "resolve", "manager-1");
  assertEqual(resolved.status, "resolved", "resolve should update status");
  assertEqual(resolved.resolved_by, "manager-1", "resolve should record actor");
});

test("canary is manager/admin gated and does not expose secrets", () => {
  assertEqual(roleCanViewManagerDashboard("consultant"), false, "consultants cannot access canary");
  assertEqual(roleCanViewManagerDashboard("manager"), true, "managers can access canary");
  assertEqual(canaryIsSafe({ ok: true, checks: { database: true } }), true, "ordinary canary body is safe");
  assertEqual(
    canaryIsSafe({ ok: true, supabase_service_role_key: "secret" }),
    false,
    "canary body must reject secret-shaped keys"
  );
});

let failures = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok - ${t.name}`);
  } catch (err) {
    failures++;
    console.error(`not ok - ${t.name}`);
    console.error((err as Error).message);
  }
}

if (failures > 0) process.exitCode = 1;
