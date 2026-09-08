/**
 * Phase 20 — Graph attachment ingestion (Phase 5B) pure-logic tests.
 * ---------------------------------------------------------------------------
 * Exercises the deterministic filter classifier, filename sanitiser, config
 * size resolver, retry authority (Retry-After propagation), and retryability
 * classification of Phase 5B error codes. No Graph HTTP; no admin fake.
 */

import {
  classifyAttachment,
  safeAttachmentFilename,
} from "../worker/src/graph-attachment.js";
import {
  attachmentMaxBytes,
  MAX_INTAKE_ATTACHMENT_BYTES_DEFAULT,
} from "../worker/src/config.js";
import {
  nextRetryAt,
  isRetryableError,
  RETRY_AFTER_MAX_SECONDS,
} from "../worker/src/phase8-core.js";
import type { GraphAttachmentMetadata } from "../worker/src/graph-client.js";

// -----------------------------------------------------------------------
// Minimal test runner
// -----------------------------------------------------------------------

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function eq<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

// -----------------------------------------------------------------------
// Fixture builder
// -----------------------------------------------------------------------

function meta(over: Partial<GraphAttachmentMetadata> = {}): GraphAttachmentMetadata {
  return {
    id: "att-1",
    name: "policy.pdf",
    contentType: "application/pdf",
    size: 100_000,
    isInline: false,
    contentId: null,
    attachmentType: "fileAttachment",
    ...over,
  };
}

// -----------------------------------------------------------------------
// Filter classifier
// -----------------------------------------------------------------------

test("classify: eligible fileAttachment PDF within limit", () => {
  const d = classifyAttachment(meta(), 15 * 1024 * 1024);
  eq(d.initial_state, "pending", "state");
  eq(d.skip_reason, null, "reason");
});

test("classify: itemAttachment is unsupported and NEVER downloaded", () => {
  const d = classifyAttachment(meta({ attachmentType: "itemAttachment" }), 15 * 1024 * 1024);
  eq(d.initial_state, "unsupported", "state");
  eq(d.skip_reason, "item_attachment", "reason");
});

test("classify: referenceAttachment is unsupported and NEVER downloaded", () => {
  const d = classifyAttachment(meta({ attachmentType: "referenceAttachment" }), 15 * 1024 * 1024);
  eq(d.initial_state, "unsupported", "state");
  eq(d.skip_reason, "reference_attachment", "reason");
});

test("classify: unknown @odata.type is unsupported", () => {
  const d = classifyAttachment(meta({ attachmentType: "unknown" }), 15 * 1024 * 1024);
  eq(d.initial_state, "unsupported", "state");
  eq(d.skip_reason, "unknown_attachment_type", "reason");
});

test("classify: inline signature (contentId, small) is skipped", () => {
  const d = classifyAttachment(
    meta({ isInline: true, contentId: "sig-1", size: 12_000, contentType: "image/png", name: "sig.png" }),
    15 * 1024 * 1024,
  );
  eq(d.initial_state, "skipped", "state");
  eq(d.skip_reason, "inline_signature", "reason");
});

test("classify: inline image without contentId, small, is skipped", () => {
  const d = classifyAttachment(
    meta({ isInline: true, contentId: null, size: 180_000, contentType: "image/jpeg", name: "banner.jpg" }),
    15 * 1024 * 1024,
  );
  eq(d.initial_state, "skipped", "state");
  eq(d.skip_reason, "inline_image", "reason");
});

test("classify: calendar invite text/calendar is skipped", () => {
  const d = classifyAttachment(
    meta({ contentType: "text/calendar", name: "invite.ics" }),
    15 * 1024 * 1024,
  );
  eq(d.initial_state, "skipped", "state");
  eq(d.skip_reason, "calendar_invite", "reason");
});

test("classify: 14 MiB PDF is eligible", () => {
  const size = 14 * 1024 * 1024;
  const d = classifyAttachment(meta({ size }), 15 * 1024 * 1024);
  eq(d.initial_state, "pending", "state");
});

test("classify: 15 MiB PDF is eligible (inclusive)", () => {
  const size = 15 * 1024 * 1024;
  const d = classifyAttachment(meta({ size }), 15 * 1024 * 1024);
  eq(d.initial_state, "pending", "state");
});

test("classify: 15 MiB + 1 byte is skipped before download", () => {
  const size = 15 * 1024 * 1024 + 1;
  const d = classifyAttachment(meta({ size }), 15 * 1024 * 1024);
  eq(d.initial_state, "skipped", "state");
  eq(d.skip_reason, "oversize", "reason");
});

test("classify: non-PDF MIME is skipped (unsupported_mime)", () => {
  const d = classifyAttachment(
    meta({ contentType: "image/png", name: "photo.png", isInline: false }),
    15 * 1024 * 1024,
  );
  eq(d.initial_state, "skipped", "state");
  eq(d.skip_reason, "unsupported_mime", "reason");
});

test("classify: null size defers to MIME whitelist (accepted PDF stays eligible)", () => {
  const d = classifyAttachment(meta({ size: null }), 15 * 1024 * 1024);
  eq(d.initial_state, "pending", "state");
});

// -----------------------------------------------------------------------
// Filename sanitiser
// -----------------------------------------------------------------------

test("safeAttachmentFilename: path traversal stripped", () => {
  eq(safeAttachmentFilename("../../etc/passwd"), "passwd", "traversal");
});

test("safeAttachmentFilename: control chars and separators replaced", () => {
  const cleaned = safeAttachmentFilename("bad;name?with/slash.pdf");
  assert(!cleaned.includes(";"), "no semicolon");
  assert(!cleaned.includes("?"), "no question mark");
  assert(!cleaned.includes("/"), "no slash");
  assert(cleaned.endsWith(".pdf"), "extension preserved");
});

test("safeAttachmentFilename: null / empty falls back to attachment.pdf", () => {
  eq(safeAttachmentFilename(null), "attachment.pdf", "null");
  eq(safeAttachmentFilename(""), "attachment.pdf", "empty");
  eq(safeAttachmentFilename("   "), "attachment.pdf", "whitespace");
});

test("safeAttachmentFilename: length capped at 120", () => {
  const long = "a".repeat(300) + ".pdf";
  const cleaned = safeAttachmentFilename(long);
  assert(cleaned.length <= 120, `length ${cleaned.length}`);
});

// -----------------------------------------------------------------------
// Size resolver
// -----------------------------------------------------------------------

test("attachmentMaxBytes: absent env => default (15 MiB)", () => {
  const v = attachmentMaxBytes({} as never);
  eq(v, MAX_INTAKE_ATTACHMENT_BYTES_DEFAULT, "default");
});

test("attachmentMaxBytes: lower env is honored", () => {
  const v = attachmentMaxBytes({ ATLAS_INTAKE_ATTACHMENT_MAX_BYTES: "1048576" } as never);
  eq(v, 1_048_576, "1 MiB");
});

test("attachmentMaxBytes: env > 15 MiB is clamped to 15 MiB", () => {
  const v = attachmentMaxBytes({ ATLAS_INTAKE_ATTACHMENT_MAX_BYTES: String(50 * 1024 * 1024) } as never);
  eq(v, MAX_INTAKE_ATTACHMENT_BYTES_DEFAULT, "clamped");
});

test("attachmentMaxBytes: garbage env falls back to default", () => {
  const v = attachmentMaxBytes({ ATLAS_INTAKE_ATTACHMENT_MAX_BYTES: "not-a-number" } as never);
  eq(v, MAX_INTAKE_ATTACHMENT_BYTES_DEFAULT, "garbage default");
});

// -----------------------------------------------------------------------
// Retry authority
// -----------------------------------------------------------------------

test("isRetryableError: Phase 5B retryable codes", () => {
  for (const code of [
    "graph_throttled",
    "graph_server_error",
    "graph_bytes_failed",
    "graph_unauthorized",
    "storage_upload_failed",
    "hash_register_failed",
    "sha256_failed",
    "discovery_transport_failed",
    "discovery_commit_failed",
    "mark_uploaded_failed",
    "create_document_failed",
  ]) {
    assert(isRetryableError(code), `retryable: ${code}`);
  }
});

test("isRetryableError: Phase 5B non-retryable codes", () => {
  for (const code of [
    "graph_forbidden",
    "graph_attachment_gone",
    "graph_message_gone_before_attachment_discovery",
    "discovery_missing_intake_id",
    "attachment_hash_changed",
    "size_mismatch",
    "graph_config_missing",
  ]) {
    assert(!isRetryableError(code), `non-retryable: ${code}`);
  }
});

test("nextRetryAt: retryAfterSeconds propagates when retryable", () => {
  const nowIso = "2026-01-01T00:00:00.000Z";
  const at = nextRetryAt({ retryCount: 0, retryable: true, retryAfterSeconds: 42, nowIso });
  eq(at, "2026-01-01T00:00:42.000Z", "42s honored");
});

test("nextRetryAt: Retry-After 120s is honored verbatim (never shortened)", () => {
  const nowIso = "2026-01-01T00:00:00.000Z";
  const at = nextRetryAt({ retryCount: 0, retryable: true, retryAfterSeconds: 120, nowIso });
  const delta = (Date.parse(at ?? "") - Date.parse(nowIso)) / 1000;
  assert(delta >= 120, `expected >= 120s, got ${delta}`);
});

test("nextRetryAt: Retry-After 3600s is honored verbatim (never shortened to 30min)", () => {
  const nowIso = "2026-01-01T00:00:00.000Z";
  const at = nextRetryAt({ retryCount: 0, retryable: true, retryAfterSeconds: 3600, nowIso });
  const delta = (Date.parse(at ?? "") - Date.parse(nowIso)) / 1000;
  assert(delta >= 3600, `expected >= 3600s, got ${delta}`);
  // Defensive: also NOT the old 1800s ceiling.
  assert(delta !== 1800, "must not be the old 1800s clamp");
});

test("nextRetryAt: pathological Retry-After above 24h is clamped defensively", () => {
  const nowIso = "2026-01-01T00:00:00.000Z";
  const huge = 72 * 60 * 60; // 3 days
  const at = nextRetryAt({ retryCount: 0, retryable: true, retryAfterSeconds: huge, nowIso });
  const delta = (Date.parse(at ?? "") - Date.parse(nowIso)) / 1000;
  eq(delta, RETRY_AFTER_MAX_SECONDS, "clamped to 24h ceiling");
});

test("nextRetryAt: retryAfterSeconds ignored when not retryable", () => {
  const at = nextRetryAt({ retryCount: 0, retryable: false, retryAfterSeconds: 5 });
  eq(at, null, "null on non-retryable");
});

test("nextRetryAt: retryAfterSeconds ignored when retries exhausted", () => {
  const at = nextRetryAt({ retryCount: 2, retryable: true, retryAfterSeconds: 5, maxRetries: 2 });
  eq(at, null, "null on exhausted");
});

test("nextRetryAt: without retryAfterSeconds, uses default schedule (5m on first attempt)", () => {
  const nowIso = "2026-01-01T00:00:00.000Z";
  const at = nextRetryAt({ retryCount: 0, retryable: true, nowIso });
  eq(at, "2026-01-01T00:05:00.000Z", "5-minute default");
});

// -----------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------

async function main() {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok  ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL ${t.name}`);
      console.error("  " + (err as Error).message);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exit(1);
}
void main();
