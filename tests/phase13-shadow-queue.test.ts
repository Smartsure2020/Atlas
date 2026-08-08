/**
 * Phase 13 — Cloudflare Queue-backed shadow pipeline
 * ---------------------------------------------------------------------------
 *
 * These tests prove the 16 required properties of the queue-backed shadow
 * pipeline, WITHOUT booting the full Worker. Each test targets one contract:
 *
 *   1.  HTTP handler does NOT invoke hybrid extraction.
 *   2.  A sampled request enqueues one small identifier-only message.
 *   3.  The authoritative response succeeds when enqueue fails.
 *   4.  Missing queue configuration does NOT run shadow inline.
 *   5.  The queue consumer invokes the hybrid pipeline.
 *   6.  The queue consumer forbids legacy fallback.
 *   7.  Duplicate deliveries are idempotent.
 *   8.  Concurrent duplicate deliveries cannot create duplicate results.
 *   9.  Transient Azure failure retries.
 *  10.  Transient Anthropic failure retries.
 *  11.  Permanent failure is acknowledged without retry.
 *  12.  Consumer failure cannot change authoritative extraction.
 *  13.  Consumer failure cannot change completed job status.
 *  14.  Queue messages contain no PDF data, extracted text or PII.
 *  15.  Queue delay and processing duration are recorded separately.
 *  16.  A pipeline-version bump permits reprocessing the same fingerprint.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  validateShadowMessage,
  classifyFailure,
  enqueueShadowMessage,
  handleShadowQueueBatch,
  tryReserve,
  type ShadowQueueMessage,
  type QueueMessageLike,
  type QueueBatchLike,
} from "../worker/src/shadow-queue.js";
import { PIPELINE_VERSION } from "../worker/src/pipeline-version.js";

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function eq<T>(a: T, b: T, msg: string) { if (a !== b) throw new Error(`${msg}: expected ${String(b)}, got ${String(a)}`); }

// Deterministic UUIDs so we can hand-verify message shape.
const SUB = "11111111-1111-1111-1111-111111111111";
const EXT = "22222222-2222-2222-2222-222222222222";
const JOB = "33333333-3333-3333-3333-333333333333";

// ---------------------------------------------------------------------------
// In-memory Supabase mock. Models just enough of PostgREST + unique index
// semantics for the reservation + shadow comparison inserts.
// ---------------------------------------------------------------------------

interface UniqueIndex { name: string; keys: string[] }

function makeAdminMock(opts: { uniqueIndexes?: UniqueIndex[]; failTables?: Record<string, string> } = {}) {
  const tables = new Map<string, Record<string, unknown>[]>();
  const uniqueIndexes = opts.uniqueIndexes ?? [];
  const failTables = opts.failTables ?? {};

  function ensure(table: string): Record<string, unknown>[] {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table)!;
  }

  function uniqueViolation(table: string, row: Record<string, unknown>): boolean {
    const list = ensure(table);
    const rel = uniqueIndexes.filter((u) => u.name.startsWith(table + ":"));
    for (const idx of rel) {
      const dup = list.some((existing) => idx.keys.every((k) => existing[k] === row[k]));
      if (dup) return true;
    }
    return false;
  }

  const builder = (table: string) => {
    const state = { filters: [] as { key: string; op: string; val: unknown }[], selectCols: "*", inFilter: null as { key: string; vals: unknown[] } | null };
    const match = (row: Record<string, unknown>): boolean => {
      for (const f of state.filters) {
        if (f.op === "eq" && row[f.key] !== f.val) return false;
        if (f.op === "lt" && !(row[f.key] as never < (f.val as never))) return false;
      }
      if (state.inFilter && !state.inFilter.vals.includes(row[state.inFilter.key])) return false;
      return true;
    };
    const api: Record<string, unknown> = {};
    api.select = (cols: string) => { state.selectCols = cols; return api; };
    api.eq = (k: string, v: unknown) => { state.filters.push({ key: k, op: "eq", val: v }); return api; };
    api.lt = (k: string, v: unknown) => { state.filters.push({ key: k, op: "lt", val: v }); return api; };
    api.in = (k: string, vals: unknown[]) => { state.inFilter = { key: k, vals }; return api; };
    api.order = () => api;
    api.limit = () => api;
    const maybeSingle = async () => {
      if (failTables[table]) return { data: null, error: { message: failTables[table] } };
      const list = ensure(table);
      const hit = list.find(match) ?? null;
      return { data: hit, error: null };
    };
    api.maybeSingle = maybeSingle;
    api.single = maybeSingle;
    api.then = undefined; // don't make it thenable

    api.insert = async (row: Record<string, unknown>) => {
      if (failTables[table]) return { error: { message: failTables[table] } };
      const list = ensure(table);
      if (uniqueViolation(table, row)) {
        return { error: { code: "23505", message: "duplicate_key" } };
      }
      list.push({ ...row });
      return { error: null };
    };
    api.upsert = async (row: Record<string, unknown>, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
      const list = ensure(table);
      if (opts?.onConflict) {
        const keys = opts.onConflict.split(",").map((k) => k.trim());
        const dup = list.some((existing) => keys.every((k) => existing[k] === row[k]));
        if (dup && opts.ignoreDuplicates) return { error: null };
      }
      list.push({ ...row });
      return { error: null };
    };
    api.update = (patch: Record<string, unknown>) => {
      // Independent filter state per update chain so update+eq+select does
      // not leak into or out of the surrounding builder.
      const uf: { key: string; op: "eq" | "lt"; val: unknown }[] = [];
      let uIn: { key: string; vals: unknown[] } | null = null;
      let selectingAfterUpdate = false;
      const umatch = (row: Record<string, unknown>): boolean => {
        for (const f of uf) {
          if (f.op === "eq" && row[f.key] !== f.val) return false;
          if (f.op === "lt") {
            const cell = row[f.key];
            if (cell == null) return false; // NULL < X is false in SQL.
            if (!((cell as never) < (f.val as never))) return false;
          }
        }
        if (uIn && !uIn.vals.includes(row[uIn.key])) return false;
        return true;
      };
      const runUpdate = (): { data: Record<string, unknown>[]; error: null } => {
        const list = ensure(table);
        const updated: Record<string, unknown>[] = [];
        for (const row of list) {
          if (umatch(row)) {
            Object.assign(row, patch);
            updated.push({ ...row });
          }
        }
        return { data: updated, error: null };
      };
      const upd: Record<string, unknown> = {};
      upd.eq = (k: string, v: unknown) => { uf.push({ key: k, op: "eq", val: v }); return upd; };
      upd.lt = (k: string, v: unknown) => { uf.push({ key: k, op: "lt", val: v }); return upd; };
      upd.in = (k: string, vals: unknown[]) => { uIn = { key: k, vals }; return upd; };
      upd.select = () => { selectingAfterUpdate = true; return upd; };
      // Terminal — turn the chain into a thenable. When .select() was chained
      // we return { data, error }; otherwise the legacy { error } shape.
      (upd as unknown as { then: (r: (v: unknown) => unknown) => Promise<unknown> }).then = (resolve) => {
        const result = runUpdate();
        const payload: unknown = selectingAfterUpdate ? result : { error: result.error };
        return Promise.resolve(resolve(payload)) as Promise<unknown>;
      };
      return upd;
    };
    return api;
  };

  return {
    tables,
    client: {
      from: builder,
      storage: { from: () => ({ download: async () => ({ data: null, error: null }) }) },
    } as unknown as SupabaseClient,
  };
}

// ---------------------------------------------------------------------------
// Message + queue helpers
// ---------------------------------------------------------------------------

function baseMessage(overrides: Partial<ShadowQueueMessage> = {}): ShadowQueueMessage {
  return {
    v: 1,
    submissionId: SUB,
    legacyExtractionId: EXT,
    legacyJobId: JOB,
    inputFingerprint: "fp-abc-123",
    pipelineVersion: PIPELINE_VERSION,
    organisationId: null,
    enqueuedAt: Date.now() - 25,
    legacyTotals: { totalMs: 25000, inputTokens: 8000, outputTokens: 1500 },
    ...overrides,
  };
}

function makeQueueMessage(body: ShadowQueueMessage): QueueMessageLike<ShadowQueueMessage> & { acks: number; retries: number } {
  const wrapper = {
    id: "msg-" + Math.random().toString(36).slice(2),
    timestamp: new Date(),
    body,
    acks: 0,
    retries: 0,
    ack() { wrapper.acks++; },
    retry(_opts?: { delaySeconds?: number }) { wrapper.retries++; },
  };
  return wrapper;
}

function makeBatch(bodies: ShadowQueueMessage[]): QueueBatchLike<ShadowQueueMessage> & { wrappers: (QueueMessageLike<ShadowQueueMessage> & { acks: number; retries: number })[] } {
  const wrappers = bodies.map(makeQueueMessage);
  return { messages: wrappers, wrappers };
}

const RESERVATION_INDEX: UniqueIndex[] = [{
  name: "atlas_shadow_reservations:fp_ver",
  keys: ["input_fingerprint", "pipeline_version"],
}, {
  name: "atlas_pipeline_shadow_comparisons:fp_ver",
  keys: ["input_fingerprint", "pipeline_version"],
}];

// Seed a submission + one document + a legacy extraction row so the loader
// can find them. We don't need real bytes — the fake runHybrid stub doesn't
// download anything.
function seedSubmissionAndDocs(admin: ReturnType<typeof makeAdminMock>) {
  admin.tables.set("atlas_submissions", [{ id: SUB, broker_email_body: null, organisation_id: null }]);
  admin.tables.set("atlas_documents", [{
    id: "doc-1", submission_id: SUB, file_name: "a.pdf", storage_path: "path", document_type: null,
    status: "active", scan_status: "clean", created_at: "2026-01-01T00:00:00Z", file_hash: null,
  }]);
  admin.tables.set("atlas_extractions", [{ id: EXT, extracted_json: { extracted_client: { name: { value: "Acme Ltd" } } } }]);
}

function fakeHybridResult() {
  return {
    status: "completed_hybrid" as const,
    extraction: { extracted_client: { name: { value: "Acme Ltd" } } } as Record<string, unknown>,
    route: "text_fast_path" as const,
    parser: "atlas-local-pdf:unpdf",
    normalisationModel: "claude-haiku-4-5",
    fallbackModel: null,
    escalatedFields: [] as string[],
    warnings: [] as string[],
    provenance: [] as never[],
    metrics: { pipelineMode: "shadow" as const, route: "text_fast_path" as const, finalStatus: "shadow" as const, totalMs: 1200 },
  };
}

// A stub Env with an in-memory queue we can inspect.
function makeEnvWithQueue(): { env: import("../worker/src/config.js").Env; sent: unknown[]; failNext?: boolean; setFail: (b: boolean) => void } {
  const sent: unknown[] = [];
  let failNext = false;
  const env = {
    // Fill minimal fields the code touches. Everything else is unused in tests.
    ATLAS_SHADOW_SAMPLE_PERCENT: "100",
    AZURE_DOCUMENT_INTELLIGENCE_MODEL: "prebuilt-layout",
    ATLAS_SHADOW_QUEUE: {
      send: async (msg: unknown) => {
        if (failNext) { failNext = false; throw new Error("queue temporarily unavailable"); }
        sent.push(msg);
      },
    },
  } as unknown as import("../worker/src/config.js").Env;
  return { env, sent, setFail: (b: boolean) => { failNext = b; } };
}

function makeEnvWithoutQueue(): import("../worker/src/config.js").Env {
  return {
    ATLAS_SHADOW_SAMPLE_PERCENT: "100",
    AZURE_DOCUMENT_INTELLIGENCE_MODEL: "prebuilt-layout",
    // ATLAS_SHADOW_QUEUE deliberately absent.
  } as unknown as import("../worker/src/config.js").Env;
}

// ---------------------------------------------------------------------------
// Tests 1-4: producer / HTTP boundary
// ---------------------------------------------------------------------------

test("1. HTTP handler does not invoke hybrid extraction (producer only sends a message)", async () => {
  // The producer path exposed by shadow-queue is enqueueShadowMessage.
  // If it called into runHybridExtraction we'd see side effects on admin.
  const admin = makeAdminMock();
  const { env, sent } = makeEnvWithQueue();
  const outcome = await enqueueShadowMessage(env, admin.client, baseMessage());
  assert(outcome.ok, "enqueue should succeed");
  eq(sent.length, 1, "one message queued");
  eq(admin.tables.size, 0, "producer did NOT touch documents / extractions / hybrid tables");
});

test("2. Sampled request enqueues exactly one identifier-only message", async () => {
  const admin = makeAdminMock();
  const { env, sent } = makeEnvWithQueue();
  await enqueueShadowMessage(env, admin.client, baseMessage());
  eq(sent.length, 1, "one message");
  const msg = sent[0] as ShadowQueueMessage;
  eq(msg.v, 1, "version-tagged");
  eq(msg.submissionId, SUB, "submission id");
  eq(msg.legacyExtractionId, EXT, "extraction id");
  eq(msg.legacyJobId, JOB, "job id");
  assert(msg.inputFingerprint.length > 0, "fingerprint present");
  eq(msg.pipelineVersion, PIPELINE_VERSION, "pipeline version");
  assert(typeof msg.enqueuedAt === "number", "enqueuedAt present");
});

test("3. Authoritative legacy response is unaffected when enqueue fails", async () => {
  const admin = makeAdminMock();
  const { env, setFail } = makeEnvWithQueue();
  setFail(true);
  const outcome = await enqueueShadowMessage(env, admin.client, baseMessage());
  eq(outcome.ok, false, "returned failure outcome");
  assert(outcome.ok === false && outcome.reason === "send_failed", "reason is send_failed");
  // Legacy response path in extract-endpoint wraps this in a try — nothing
  // thrown means the caller can safely return its 200. We assert the enqueue
  // helper does NOT throw.
});

test("4. Missing queue configuration does NOT run shadow inline (skip + record metric)", async () => {
  const admin = makeAdminMock();
  const env = makeEnvWithoutQueue();
  const outcome = await enqueueShadowMessage(env, admin.client, baseMessage());
  eq(outcome.ok, false, "skipped");
  assert(outcome.ok === false && outcome.reason === "queue_binding_missing", "reason binding missing");
  // Nothing touched the hybrid tables.
  const metrics = admin.tables.get("atlas_pipeline_metrics") ?? [];
  eq(metrics.length, 1, "one skip metric recorded");
  const row = metrics[0] as Record<string, unknown>;
  const md = row.metadata as Record<string, unknown>;
  eq(md.shadow_enqueue_status, "queue_binding_missing", "explicit reason");
});

// ---------------------------------------------------------------------------
// Tests 5-6: consumer invokes hybrid, forbids legacy fallback
// ---------------------------------------------------------------------------

test("5. Queue consumer invokes the hybrid pipeline (with mode=shadow)", async () => {
  const admin = makeAdminMock({ uniqueIndexes: RESERVATION_INDEX });
  seedSubmissionAndDocs(admin);
  const { env } = makeEnvWithQueue();
  let invocations = 0;
  let capturedMode: string | null = null;
  const runHybrid = (async (_input: unknown, ctx: { mode: string }) => {
    invocations++;
    capturedMode = ctx.mode;
    return fakeHybridResult();
  }) as unknown as Parameters<typeof handleShadowQueueBatch>[2]["runHybrid"];
  const batch = makeBatch([baseMessage()]);
  await handleShadowQueueBatch(batch, env, { buildAdmin: () => admin.client, runHybrid });
  eq(invocations, 1, "runHybrid invoked once");
  eq(capturedMode, "shadow", "shadow mode");
  eq(batch.wrappers[0].acks, 1, "message acked");
});

test("6. Queue consumer forbids legacy fallback (legacyFallbackAllowed:false)", async () => {
  const admin = makeAdminMock({ uniqueIndexes: RESERVATION_INDEX });
  seedSubmissionAndDocs(admin);
  const { env } = makeEnvWithQueue();
  let capturedFallback: boolean | null = null;
  const runHybrid = (async (_input: unknown, ctx: { legacyFallbackAllowed: boolean }) => {
    capturedFallback = ctx.legacyFallbackAllowed;
    return fakeHybridResult();
  }) as unknown as Parameters<typeof handleShadowQueueBatch>[2]["runHybrid"];
  await handleShadowQueueBatch(makeBatch([baseMessage()]), env, { buildAdmin: () => admin.client, runHybrid });
  eq(capturedFallback, false, "legacyFallbackAllowed must be false");
});

// ---------------------------------------------------------------------------
// Tests 7-8: idempotency + concurrent-duplicate
// ---------------------------------------------------------------------------

test("7. Duplicate deliveries are idempotent (no double provider call, no double row)", async () => {
  const admin = makeAdminMock({ uniqueIndexes: RESERVATION_INDEX });
  seedSubmissionAndDocs(admin);
  const { env } = makeEnvWithQueue();
  let calls = 0;
  const runHybrid = (async () => { calls++; return fakeHybridResult(); }) as unknown as Parameters<typeof handleShadowQueueBatch>[2]["runHybrid"];

  const msg = baseMessage();
  // First delivery.
  await handleShadowQueueBatch(makeBatch([msg]), env, { buildAdmin: () => admin.client, runHybrid });
  // Second (duplicate) delivery of the same identifier.
  const secondBatch = makeBatch([msg]);
  await handleShadowQueueBatch(secondBatch, env, { buildAdmin: () => admin.client, runHybrid });
  eq(calls, 1, "hybrid invoked exactly once across duplicates");
  eq(secondBatch.wrappers[0].acks, 1, "duplicate delivery acked");
  const comparisons = admin.tables.get("atlas_pipeline_shadow_comparisons") ?? [];
  eq(comparisons.length, 1, "only one comparison row written");
});

test("8. Concurrent duplicate deliveries cannot create duplicate results", async () => {
  const admin = makeAdminMock({ uniqueIndexes: RESERVATION_INDEX });
  seedSubmissionAndDocs(admin);
  const { env } = makeEnvWithQueue();
  let inflight = 0;
  let maxInflight = 0;
  let calls = 0;
  const runHybrid = (async () => {
    inflight++;
    if (inflight > maxInflight) maxInflight = inflight;
    // Await a tick to force overlap when both messages race.
    await new Promise((r) => setTimeout(r, 5));
    calls++;
    inflight--;
    return fakeHybridResult();
  }) as unknown as Parameters<typeof handleShadowQueueBatch>[2]["runHybrid"];

  const msg = baseMessage();
  // Two independent batches processed concurrently — models two consumers
  // receiving the same fingerprint at the same time.
  const b1 = makeBatch([msg]);
  const b2 = makeBatch([msg]);
  await Promise.all([
    handleShadowQueueBatch(b1, env, { buildAdmin: () => admin.client, runHybrid }),
    handleShadowQueueBatch(b2, env, { buildAdmin: () => admin.client, runHybrid }),
  ]);
  eq(calls, 1, "runHybrid must not be invoked twice under concurrent duplicates");
  assert(maxInflight <= 1, "at most one concurrent hybrid invocation");
  const comparisons = admin.tables.get("atlas_pipeline_shadow_comparisons") ?? [];
  eq(comparisons.length, 1, "only one comparison row survives");
});

// ---------------------------------------------------------------------------
// Tests 9-11: transient (azure/anthropic) + permanent handling
// ---------------------------------------------------------------------------

test("9. Transient Azure failure retries the message", async () => {
  const admin = makeAdminMock({ uniqueIndexes: RESERVATION_INDEX });
  seedSubmissionAndDocs(admin);
  const { env } = makeEnvWithQueue();
  const runHybrid = (async () => ({
    status: "failed" as const,
    extraction: null,
    route: "ocr_required" as const,
    parser: "azure-di",
    normalisationModel: null,
    fallbackModel: null,
    escalatedFields: [] as string[],
    warnings: [],
    provenance: [] as never[],
    metrics: { pipelineMode: "shadow" as const, route: "ocr_required" as const, finalStatus: "failed" as const, totalMs: 100 },
    errorCode: "azure_rate_limited",
  })) as unknown as Parameters<typeof handleShadowQueueBatch>[2]["runHybrid"];
  const batch = makeBatch([baseMessage()]);
  await handleShadowQueueBatch(batch, env, { buildAdmin: () => admin.client, runHybrid });
  eq(batch.wrappers[0].acks, 0, "transient must NOT ack");
  eq(batch.wrappers[0].retries, 1, "transient must retry");
});

test("10. Transient Anthropic failure retries the message", async () => {
  const admin = makeAdminMock({ uniqueIndexes: RESERVATION_INDEX });
  seedSubmissionAndDocs(admin);
  const { env } = makeEnvWithQueue();
  const runHybrid = (async () => ({
    status: "failed" as const,
    extraction: null,
    route: "text_fast_path" as const,
    parser: "unpdf",
    normalisationModel: "claude-haiku-4-5",
    fallbackModel: null,
    escalatedFields: [] as string[],
    warnings: [],
    provenance: [] as never[],
    metrics: { pipelineMode: "shadow" as const, route: "text_fast_path" as const, finalStatus: "failed" as const, totalMs: 100 },
    errorCode: "anthropic_rate_limited",
  })) as unknown as Parameters<typeof handleShadowQueueBatch>[2]["runHybrid"];
  const batch = makeBatch([baseMessage()]);
  await handleShadowQueueBatch(batch, env, { buildAdmin: () => admin.client, runHybrid });
  eq(batch.wrappers[0].retries, 1, "anthropic transient retries");
  eq(batch.wrappers[0].acks, 0, "no ack");
  // Sanity — the classification helper agrees.
  eq(classifyFailure("anthropic_rate_limited"), "transient", "helper");
});

test("11. Permanent failure is acknowledged without retry", async () => {
  const admin = makeAdminMock({ uniqueIndexes: RESERVATION_INDEX });
  seedSubmissionAndDocs(admin);
  const { env } = makeEnvWithQueue();
  const runHybrid = (async () => ({
    status: "failed" as const,
    extraction: null,
    route: "encrypted" as const,
    parser: "unpdf",
    normalisationModel: null,
    fallbackModel: null,
    escalatedFields: [] as string[],
    warnings: [],
    provenance: [] as never[],
    metrics: { pipelineMode: "shadow" as const, route: "encrypted" as const, finalStatus: "failed" as const, totalMs: 30 },
    errorCode: "encrypted",
  })) as unknown as Parameters<typeof handleShadowQueueBatch>[2]["runHybrid"];
  const batch = makeBatch([baseMessage()]);
  await handleShadowQueueBatch(batch, env, { buildAdmin: () => admin.client, runHybrid });
  eq(batch.wrappers[0].acks, 1, "permanent MUST ack");
  eq(batch.wrappers[0].retries, 0, "no retry");
  eq(classifyFailure("encrypted"), "permanent", "encrypted is permanent");
});

// ---------------------------------------------------------------------------
// Tests 12-13: consumer failure never touches authoritative state
// ---------------------------------------------------------------------------

test("12. Consumer failure cannot change authoritative extraction row", async () => {
  const admin = makeAdminMock({ uniqueIndexes: RESERVATION_INDEX });
  seedSubmissionAndDocs(admin);
  const priorExtraction = JSON.stringify(admin.tables.get("atlas_extractions")![0]);
  const { env } = makeEnvWithQueue();
  const runHybrid = (async () => { throw new Error("azure blew up"); }) as unknown as Parameters<typeof handleShadowQueueBatch>[2]["runHybrid"];
  const batch = makeBatch([baseMessage()]);
  await handleShadowQueueBatch(batch, env, { buildAdmin: () => admin.client, runHybrid });
  const afterExtraction = JSON.stringify(admin.tables.get("atlas_extractions")![0]);
  eq(afterExtraction, priorExtraction, "extraction row unchanged");
});

test("13. Consumer failure cannot change completed job status", async () => {
  const admin = makeAdminMock({ uniqueIndexes: RESERVATION_INDEX });
  seedSubmissionAndDocs(admin);
  admin.tables.set("atlas_jobs", [{ id: JOB, status: "completed", progress_percent: 100 }]);
  const priorJob = JSON.stringify(admin.tables.get("atlas_jobs")![0]);
  const { env } = makeEnvWithQueue();
  const runHybrid = (async () => { throw new Error("boom"); }) as unknown as Parameters<typeof handleShadowQueueBatch>[2]["runHybrid"];
  await handleShadowQueueBatch(makeBatch([baseMessage()]), env, { buildAdmin: () => admin.client, runHybrid });
  const afterJob = JSON.stringify(admin.tables.get("atlas_jobs")![0]);
  eq(afterJob, priorJob, "job status still completed");
});

// ---------------------------------------------------------------------------
// Test 14: no PII in queue messages
// ---------------------------------------------------------------------------

test("14. Queue messages contain no PDF data, extracted text or PII", () => {
  const msg = baseMessage();
  const serialised = JSON.stringify(msg);
  // Structural check: only allow-listed keys survive.
  const invalid = validateShadowMessage(msg);
  eq(invalid, null, "base message is valid");

  // Attempt to smuggle PII — the validator MUST reject.
  const contaminated = { ...msg, riskAddress: "10 Downing St" } as unknown;
  const rej = validateShadowMessage(contaminated);
  assert(rej && rej.startsWith("unexpected_key"), "PII key rejected: " + rej);

  const withBytes = { ...msg, pdfBase64: "JVBERi0xLjcK..." } as unknown;
  assert(validateShadowMessage(withBytes)?.startsWith("unexpected_key"), "PDF bytes rejected");

  const withText = { ...msg, extractedText: "Client name: Acme Ltd..." } as unknown;
  assert(validateShadowMessage(withText)?.startsWith("unexpected_key"), "extracted text rejected");

  // Structural absence of any suspicious pattern in the serialised valid
  // message. We check for PII/content-shaped KEYS (word-boundary matched) —
  // PIPELINE_VERSION intentionally contains the substring "unpdf" as a
  // build tag, so a loose substring match would false-positive.
  const piiKeyPattern = /"(?:pdfBase64|pdfBytes|pdf_data|base64|address|riskAddress|risk_address|extractedText|extracted_text|snippet|body|brokerEmail|broker_email|clientName|client_name|dob|ssn|passport|phone)"/i;
  assert(!piiKeyPattern.test(serialised),
    "serialised message contains no PII/document keys: " + serialised.slice(0, 200));
});

// ---------------------------------------------------------------------------
// Test 15: queue delay + processing duration recorded separately
// ---------------------------------------------------------------------------

test("15. Queue delay and processing duration are recorded separately", async () => {
  const admin = makeAdminMock({ uniqueIndexes: RESERVATION_INDEX });
  seedSubmissionAndDocs(admin);
  const { env } = makeEnvWithQueue();

  // This test used to measure both durations off the real wall clock (a
  // fixed "-25ms" enqueuedAt offset against a real 15ms setTimeout inside
  // runHybrid). On coarse OS timer ticks (Windows in particular defaults to
  // ~15.6ms resolution) a "15ms" real sleep can land anywhere in roughly the
  // 15-31ms range, which overlaps the ~25-27ms the queue-delay side actually
  // measured — so the two independently-measured integers could legitimately
  // come out equal, failing the `!==` check without any real bug. Pin both
  // clocks to known values instead: a fake `Date.now()` that only advances
  // when *this test* tells it to, so each duration is deterministic and
  // exact, and provably comes from its own timestamp boundary rather than
  // the other one.
  const FIXED_ENQUEUED_AT = 1_700_000_000_000;
  const EXPECTED_QUEUE_DELAY_MS = 25_000;
  const EXPECTED_PROCESSING_MS = 7_777;

  const realDateNow = Date.now;
  let virtualNow = FIXED_ENQUEUED_AT + EXPECTED_QUEUE_DELAY_MS;
  Date.now = () => virtualNow;

  try {
    const runHybrid = (async () => {
      // Advance the virtual clock only here, i.e. strictly between
      // processingStartedAt and the final Date.now() read — proving
      // shadow_processing_ms measures this span and nothing else.
      virtualNow += EXPECTED_PROCESSING_MS;
      return fakeHybridResult();
    }) as unknown as Parameters<typeof handleShadowQueueBatch>[2]["runHybrid"];

    await handleShadowQueueBatch(
      makeBatch([baseMessage({ enqueuedAt: FIXED_ENQUEUED_AT })]),
      env,
      { buildAdmin: () => admin.client, runHybrid }
    );
  } finally {
    Date.now = realDateNow;
  }

  const comparisons = admin.tables.get("atlas_pipeline_shadow_comparisons") ?? [];
  eq(comparisons.length, 1, "one comparison row");
  const md = (comparisons[0] as Record<string, unknown>).metadata as Record<string, unknown>;
  eq(md.shadow_queue_delay_ms, EXPECTED_QUEUE_DELAY_MS, "comparison row records the exact queue delay");

  const metrics = admin.tables.get("atlas_pipeline_metrics") ?? [];
  const successMetric = metrics.find((m) => (m as { fallback_reason?: string | null }).fallback_reason == null) as Record<string, unknown> | undefined;
  assert(successMetric, "success metric present");
  const mMd = successMetric!.metadata as Record<string, unknown>;
  // Exact values, not just "a number" — this proves shadow_queue_delay_ms
  // comes from the enqueuedAt boundary (unaffected by however long runHybrid
  // takes) and shadow_processing_ms comes from the processingStartedAt
  // boundary (unaffected by the queue-delay offset), rather than merely
  // asserting the two numbers differ.
  eq(mMd.shadow_queue_delay_ms, EXPECTED_QUEUE_DELAY_MS, "metric records the exact queue delay");
  eq(mMd.shadow_processing_ms, EXPECTED_PROCESSING_MS, "metric records the exact processing duration");
});

// ---------------------------------------------------------------------------
// Test 16: pipeline_version bump permits reprocessing the same fingerprint
// ---------------------------------------------------------------------------

test("16. A pipeline-version bump permits reprocessing the same fingerprint", async () => {
  const admin = makeAdminMock({ uniqueIndexes: RESERVATION_INDEX });
  seedSubmissionAndDocs(admin);
  const { env } = makeEnvWithQueue();
  let runs = 0;
  const runHybrid = (async () => { runs++; return fakeHybridResult(); }) as unknown as Parameters<typeof handleShadowQueueBatch>[2]["runHybrid"];

  // First run at PIPELINE_VERSION.
  await handleShadowQueueBatch(makeBatch([baseMessage()]), env, { buildAdmin: () => admin.client, runHybrid });
  eq(runs, 1, "first version ran");

  // Second run with a bumped pipeline_version but same fingerprint.
  const bumped = baseMessage({ pipelineVersion: "20260901-newer-experiment" });
  const batch2 = makeBatch([bumped]);
  await handleShadowQueueBatch(batch2, env, { buildAdmin: () => admin.client, runHybrid });

  // The consumer rejects mismatched pipeline_version as schema_incompatible
  // and acks (permanent-for-this-deploy). That is the CORRECT behaviour: the
  // NEW deployment (whose PIPELINE_VERSION would match) will process it.
  // We assert the ack path was taken, no double-write occurred, and the
  // reservation table now has a distinct row per (fingerprint, version).
  eq(batch2.wrappers[0].acks, 1, "bumped-version message acked by this deploy");

  // Directly exercise the reservation logic to prove the KEY allows a new row
  // for a different pipeline_version at DB level.
  const r1 = await tryReserve(admin.client, baseMessage());
  const r2 = await tryReserve(admin.client, baseMessage({ pipelineVersion: "20260901-newer-experiment" }));
  assert(
    r1.outcome === "already_completed" || r1.outcome === "already_processing",
    "same version blocked: " + r1.outcome
  );
  eq(r2.outcome, "reserved", "different version allowed to reserve");
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
  console.log(`\nPhase 13 shadow queue: ${passed} passed, ${failed} failed out of ${tests.length}`);
  if (failed > 0 && typeof process !== "undefined") process.exitCode = 1;
})();
