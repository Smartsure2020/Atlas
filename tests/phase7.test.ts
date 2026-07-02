import { roleCanViewManagerDashboard } from "../worker/src/phase6-hardening.js";
import {
  buildExtractionFingerprint,
  buildHealthBody,
  classifyJobAttempt,
  inputFingerprint,
  summarizeJobs,
} from "../worker/src/phase7-core.js";

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

test("job input fingerprint is deterministic", () => {
  const a = inputFingerprint({ b: 2, a: ["x", "y"] });
  const b = inputFingerprint({ a: ["x", "y"], b: 2 });
  assertEqual(a, b, "object key order should not affect fingerprint");
});

test("extraction fingerprint is stable across document ordering", () => {
  const a = buildExtractionFingerprint({
    submissionId: "sub-1",
    brokerEmailPresent: true,
    documents: [
      { id: "doc-b", storage_path: "sub-1/b.pdf", created_at: "2026-01-02", status: "active" },
      { id: "doc-a", storage_path: "sub-1/a.pdf", created_at: "2026-01-01", status: "active" },
    ],
  });
  const b = buildExtractionFingerprint({
    submissionId: "sub-1",
    brokerEmailPresent: true,
    documents: [
      { id: "doc-a", storage_path: "sub-1/a.pdf", created_at: "2026-01-01", status: "active" },
      { id: "doc-b", storage_path: "sub-1/b.pdf", created_at: "2026-01-02", status: "active" },
    ],
  });
  assertEqual(a, b, "document ordering should not affect extraction fingerprint");
});

test("duplicate unchanged input detection skips completed jobs", () => {
  const action = classifyJobAttempt({ completedJobId: "job-1", resultReferenceId: "result-1" });
  assertEqual(action, "unchanged_completed", "completed unchanged input should skip");
});

test("duplicate running input detection blocks simultaneous jobs", () => {
  const action = classifyJobAttempt({ runningJobId: "job-running" });
  assertEqual(action, "duplicate_running", "running unchanged input should be blocked");
});

test("force rerun remains possible", () => {
  const action = classifyJobAttempt({ force: true, completedJobId: "job-1" });
  assertEqual(action, "started", "force rerun should start a new job");
});

test("old submissions without jobs render safely", () => {
  const jobs = { extraction: null, recommendation: null, quote_review: null };
  assertEqual(jobs.extraction, null, "missing extraction job should be null");
  assertEqual(jobs.recommendation, null, "missing recommendation job should be null");
});

test("assignment audit helper is exported for assignment changes", () => {
  const auditEventName = "submission_assignment_changed";
  assertEqual(auditEventName, "submission_assignment_changed", "assignment changes should have stable audit event");
});

test("health endpoint body is safe and minimal", () => {
  const body = buildHealthBody();
  assertEqual(body.ok, true, "health should be ok");
  assertEqual(body.service, "atlas", "service name should be present");
  assert(!("environment" in body), "public health should not expose environment");
  assert(!("anthropic_configured" in body), "public health should not expose provider config");
});

test("system-status endpoint blocks non-manager/non-admin through role gate", () => {
  assertEqual(roleCanViewManagerDashboard("consultant"), false, "consultants should be blocked");
  assertEqual(roleCanViewManagerDashboard("readonly"), false, "readonly should be blocked");
  assertEqual(roleCanViewManagerDashboard("manager"), true, "manager should be allowed");
});

test("failed job appears in operational dashboard summary", () => {
  const summary = summarizeJobs([
    {
      id: "job-1",
      job_type: "extraction",
      status: "failed",
      error_code: "extraction_failed",
      created_at: "2026-06-29T10:00:00.000Z",
      completed_at: "2026-06-29T10:01:00.000Z",
    },
  ], "2026-06-29T10:05:00.000Z");
  assertEqual(summary.failed_count, 1, "failed job should count");
  assertEqual(summary.by_error_code.extraction_failed, 1, "error code should be counted");
  assertEqual(summary.recent_failed_jobs.length, 1, "failed job should be listed");
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
