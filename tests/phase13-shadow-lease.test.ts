/**
 * Phase 13.1 — Shadow queue reservation LEASE + CAS lifecycle
 * ---------------------------------------------------------------------------
 *
 * The queue consumer holds a reservation while running the hybrid pipeline
 * against Azure Document Intelligence + Anthropic. Two subtle correctness
 * properties must hold for the shadow pilot to be safe under real-world
 * transient failures and crashed consumers:
 *
 *   1. TRANSIENT-RETRY LIFECYCLE — on delivery attempt 1, if a transient
 *      Azure/Anthropic/storage failure occurs, the reservation must be
 *      demoted OUT of `processing` (to `queued`) BEFORE msg.retry() runs, so
 *      the next delivery can atomically reacquire it. Delivery 2 must then
 *      successfully complete and write EXACTLY ONE comparison row.
 *
 *   2. CRASHED-CONSUMER LEASE — if a consumer takes the reservation and
 *      dies before releasing it, a redelivery arriving BEFORE the lease
 *      expires must NOT ack (which would silently drop the work); it must
 *      msg.retry with a delay. Once the lease has expired, a later
 *      delivery must reclaim the reservation via CAS and complete the work,
 *      producing exactly one comparison row.
 *
 * We prove both here without booting the full Worker. See
 * ../worker/src/shadow-queue.ts for the SUT.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  handleShadowQueueBatch,
  tryReserve,
  releaseReservation,
  LEASE_TTL_MS,
  RETRY_ON_ACTIVE_LEASE_SECONDS,
  type ShadowQueueMessage,
  type QueueMessageLike,
  type QueueBatchLike,
} from "../worker/src/shadow-queue.js";
import { PIPELINE_VERSION } from "../worker/src/pipeline-version.js";

// ---------------------------------------------------------------------------
// Test scaffolding — mirrors the mock in phase13-shadow-queue.test.ts.
// The mock intentionally supports .update(...).eq(...).select() so the CAS
// updates in shadow-queue.ts can confirm rowcount atomically.
// ---------------------------------------------------------------------------

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function eq<T>(a: T, b: T, msg: string) { if (a !== b) throw new Error(`${msg}: expected ${String(b)}, got ${String(a)}`); }

const SUB = "44444444-4444-4444-4444-444444444444";
const EXT = "55555555-5555-5555-5555-555555555555";
const JOB = "66666666-6666-6666-6666-666666666666";
const FP = "fp-lease-lifecycle";

interface UniqueIndex { name: string; keys: string[] }

function makeAdminMock(opts: { uniqueIndexes?: UniqueIndex[] } = {}) {
  const tables = new Map<string, Record<string, unknown>[]>();
  const uniqueIndexes = opts.uniqueIndexes ?? [];
  function ensure(table: string): Record<string, unknown>[] {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table)!;
  }
  function uniqueViolation(table: string, row: Record<string, unknown>): boolean {
    const list = ensure(table);
    const rel = uniqueIndexes.filter((u) => u.name.startsWith(table + ":"));
    for (const idx of rel) {
      if (list.some((existing) => idx.keys.every((k) => existing[k] === row[k]))) return true;
    }
    return false;
  }
  const builder = (table: string) => {
    const state = {
      filters: [] as { key: string; op: "eq" | "lt"; val: unknown }[],
      inFilter: null as { key: string; vals: unknown[] } | null,
    };
    const match = (row: Record<string, unknown>): boolean => {
      for (const f of state.filters) {
        if (f.op === "eq" && row[f.key] !== f.val) return false;
        if (f.op === "lt") {
          const cell = row[f.key];
          if (cell == null) return false;
          if (!((cell as never) < (f.val as never))) return false;
        }
      }
      if (state.inFilter && !state.inFilter.vals.includes(row[state.inFilter.key])) return false;
      return true;
    };
    const api: Record<string, unknown> = {};
    api.select = () => api;
    api.eq = (k: string, v: unknown) => { state.filters.push({ key: k, op: "eq", val: v }); return api; };
    api.lt = (k: string, v: unknown) => { state.filters.push({ key: k, op: "lt", val: v }); return api; };
    api.in = (k: string, vals: unknown[]) => { state.inFilter = { key: k, vals }; return api; };
    api.order = () => api;
    api.limit = () => api;
    const maybeSingle = async () => {
      const list = ensure(table);
      return { data: list.find(match) ?? null, error: null };
    };
    api.maybeSingle = maybeSingle;
    api.single = maybeSingle;
    api.insert = async (row: Record<string, unknown>) => {
      const list = ensure(table);
      if (uniqueViolation(table, row)) return { error: { code: "23505", message: "duplicate_key" } };
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
      const uf: { key: string; op: "eq" | "lt"; val: unknown }[] = [];
      let uIn: { key: string; vals: unknown[] } | null = null;
      let selecting = false;
      const umatch = (row: Record<string, unknown>): boolean => {
        for (const f of uf) {
          if (f.op === "eq" && row[f.key] !== f.val) return false;
          if (f.op === "lt") {
            const cell = row[f.key];
            if (cell == null) return false;
            if (!((cell as never) < (f.val as never))) return false;
          }
        }
        if (uIn && !uIn.vals.includes(row[uIn.key])) return false;
        return true;
      };
      const runUpdate = () => {
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
      upd.select = () => { selecting = true; return upd; };
      (upd as unknown as { then: (r: (v: unknown) => unknown) => Promise<unknown> }).then = (resolve) => {
        const result = runUpdate();
        const payload = selecting ? result : { error: result.error };
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

const RESERVATION_INDEX: UniqueIndex[] = [
  { name: "atlas_shadow_reservations:fp_ver", keys: ["input_fingerprint", "pipeline_version"] },
  { name: "atlas_pipeline_shadow_comparisons:fp_ver", keys: ["input_fingerprint", "pipeline_version"] },
];

function baseMessage(overrides: Partial<ShadowQueueMessage> = {}): ShadowQueueMessage {
  return {
    v: 1,
    submissionId: SUB,
    legacyExtractionId: EXT,
    legacyJobId: JOB,
    inputFingerprint: FP,
    pipelineVersion: PIPELINE_VERSION,
    organisationId: null,
    enqueuedAt: Date.now() - 15,
    legacyTotals: { totalMs: 25000, inputTokens: 8000, outputTokens: 1500 },
    ...overrides,
  };
}

function makeQueueMessage(body: ShadowQueueMessage): QueueMessageLike<ShadowQueueMessage> & {
  acks: number; retries: number; retryDelays: (number | undefined)[];
} {
  const wrapper = {
    id: "msg-" + Math.random().toString(36).slice(2),
    timestamp: new Date(),
    body,
    acks: 0,
    retries: 0,
    retryDelays: [] as (number | undefined)[],
    ack() { wrapper.acks++; },
    retry(opts?: { delaySeconds?: number }) { wrapper.retries++; wrapper.retryDelays.push(opts?.delaySeconds); },
  };
  return wrapper;
}

function makeBatch(bodies: ShadowQueueMessage[]) {
  const wrappers = bodies.map(makeQueueMessage);
  return { messages: wrappers, wrappers } as QueueBatchLike<ShadowQueueMessage> & { wrappers: ReturnType<typeof makeQueueMessage>[] };
}

function seedSubmissionAndDocs(admin: ReturnType<typeof makeAdminMock>) {
  admin.tables.set("atlas_submissions", [{ id: SUB, broker_email_body: null, organisation_id: null }]);
  admin.tables.set("atlas_documents", [{
    id: "doc-lease-1", submission_id: SUB, file_name: "a.pdf", storage_path: "path", document_type: null,
    status: "active", scan_status: "clean", created_at: "2026-01-01T00:00:00Z", file_hash: null,
  }]);
  admin.tables.set("atlas_extractions", [{ id: EXT, extracted_json: { extracted_client: { name: { value: "Acme Ltd" } } } }]);
}

function fakeHybridSuccess() {
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

function fakeHybridTransient(errorCode = "azure_rate_limited") {
  return {
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
    errorCode,
  };
}

function envWithQueue(): import("../worker/src/config.js").Env {
  return {
    ATLAS_SHADOW_SAMPLE_PERCENT: "100",
    AZURE_DOCUMENT_INTELLIGENCE_MODEL: "prebuilt-layout",
    ATLAS_SHADOW_QUEUE: { send: async () => {} },
  } as unknown as import("../worker/src/config.js").Env;
}

function reservationRow(admin: ReturnType<typeof makeAdminMock>): Record<string, unknown> | undefined {
  return (admin.tables.get("atlas_shadow_reservations") ?? [])[0];
}

// ---------------------------------------------------------------------------
// TEST A — the full transient retry sequence.
// ---------------------------------------------------------------------------

test("A. Transient failure on attempt 1 releases the reservation; attempt 2 reacquires and completes exactly once", async () => {
  const admin = makeAdminMock({ uniqueIndexes: RESERVATION_INDEX });
  seedSubmissionAndDocs(admin);
  const env = envWithQueue();

  // Attempt 1 — transient Azure failure.
  let call = 0;
  const runHybrid = (async () => {
    call++;
    if (call === 1) return fakeHybridTransient("azure_rate_limited");
    return fakeHybridSuccess();
  }) as unknown as Parameters<typeof handleShadowQueueBatch>[2]["runHybrid"];

  const msg = baseMessage();
  const batch1 = makeBatch([msg]);
  await handleShadowQueueBatch(batch1, env, { buildAdmin: () => admin.client, runHybrid });

  // Post-attempt-1 assertions.
  eq(batch1.wrappers[0].acks, 0, "attempt 1 must NOT ack a transient failure");
  eq(batch1.wrappers[0].retries, 1, "attempt 1 must call msg.retry() exactly once");

  const row1Live = reservationRow(admin);
  assert(row1Live, "reservation row exists after attempt 1");
  // Snapshot — the mock row is mutated in place by later updates, and we
  // want to prove the STATE AT THIS MOMENT was queued+cleared.
  const row1 = { ...row1Live };
  eq(row1.status, "queued", "reservation MUST NOT remain in processing after transient retry");
  eq(row1.attempt_owner_token, null, "attempt 1's owner token is cleared on release-to-queued");
  eq(row1.lease_expires_at, null, "attempt 1's lease is cleared on release-to-queued");

  // Attempt 2 — same fingerprint + pipeline version, hybrid succeeds.
  const batch2 = makeBatch([msg]);
  await handleShadowQueueBatch(batch2, env, { buildAdmin: () => admin.client, runHybrid });

  eq(batch2.wrappers[0].acks, 1, "attempt 2 must ack after successful comparison");
  eq(batch2.wrappers[0].retries, 0, "attempt 2 must not retry");
  eq(call, 2, "runHybrid invoked exactly twice across the two attempts (once per delivery)");

  const comparisons = admin.tables.get("atlas_pipeline_shadow_comparisons") ?? [];
  eq(comparisons.length, 1, "comparison written exactly once");

  const row2 = reservationRow(admin);
  assert(row2, "reservation row still exists after attempt 2");
  eq(row2!.status, "completed", "reservation MUST become completed");
  assert(row2!.attempt_owner_token != null, "attempt 2 recorded an owner token");
  // row1 is a snapshot taken while status was queued (owner_token === null),
  // so any non-null attempt-2 token proves a fresh CAS won the promotion.
  assert(row2!.attempt_owner_token !== row1.attempt_owner_token,
    "attempt 2's token differs from attempt 1's cleared state (fresh lease was minted)");
  eq(row2!.lease_expires_at, null, "lease cleared on completion");
});

// ---------------------------------------------------------------------------
// TEST B — retry cannot be silently acked while an ACTIVE lease is held.
// ---------------------------------------------------------------------------

test("B. Retry arriving while a valid lease is held is msg.retry()-ed with delay, not acked", async () => {
  const admin = makeAdminMock({ uniqueIndexes: RESERVATION_INDEX });
  seedSubmissionAndDocs(admin);
  const env = envWithQueue();

  // Simulate a live consumer that has taken the reservation but not released.
  const holderResult = await tryReserve(admin.client, baseMessage());
  assert(holderResult.outcome === "reserved", "holder acquired reservation");

  // A retry arrives WHILE the lease is still valid.
  const retryBatch = makeBatch([baseMessage()]);
  let hybridCalls = 0;
  const runHybrid = (async () => { hybridCalls++; return fakeHybridSuccess(); }) as unknown as Parameters<typeof handleShadowQueueBatch>[2]["runHybrid"];
  await handleShadowQueueBatch(retryBatch, env, { buildAdmin: () => admin.client, runHybrid });

  eq(retryBatch.wrappers[0].acks, 0, "MUST NOT ack while another consumer holds a valid lease — that would drop the work");
  eq(retryBatch.wrappers[0].retries, 1, "MUST msg.retry() so the queue redelivers after the lease could plausibly expire");
  eq(retryBatch.wrappers[0].retryDelays[0], RETRY_ON_ACTIVE_LEASE_SECONDS, "retry MUST be delayed so we don't spin");
  eq(hybridCalls, 0, "hybrid was not invoked while an active lease was held");

  const comparisons = admin.tables.get("atlas_pipeline_shadow_comparisons") ?? [];
  eq(comparisons.length, 0, "no comparison written yet");

  const row = reservationRow(admin);
  assert(row, "reservation row present");
  eq(row!.status, "processing", "the holder's processing lease is still intact");
  eq(row!.attempt_owner_token, holderResult.ownerToken, "the retry did NOT overwrite the holder's owner token");
});

// ---------------------------------------------------------------------------
// TEST C — after lease expiry, a later delivery takes over and completes.
// Only one comparison row exists.
// ---------------------------------------------------------------------------

test("C. Crashed consumer scenario: retry pre-expiry does not discard; post-expiry a later delivery takes over and completes once", async () => {
  const admin = makeAdminMock({ uniqueIndexes: RESERVATION_INDEX });
  seedSubmissionAndDocs(admin);
  const env = envWithQueue();

  // Phase 1 — consumer A takes the reservation, then "crashes" without releasing.
  const holder = await tryReserve(admin.client, baseMessage());
  assert(holder.outcome === "reserved", "holder acquired reservation");
  const holderToken = holder.ownerToken;

  // Phase 2 — retry BEFORE lease expiry. Must NOT ack; must msg.retry.
  const preBatch = makeBatch([baseMessage()]);
  let calls = 0;
  const runHybrid = (async () => { calls++; return fakeHybridSuccess(); }) as unknown as Parameters<typeof handleShadowQueueBatch>[2]["runHybrid"];
  await handleShadowQueueBatch(preBatch, env, { buildAdmin: () => admin.client, runHybrid });
  eq(preBatch.wrappers[0].acks, 0, "pre-expiry retry MUST NOT ack — that silently discards work");
  eq(preBatch.wrappers[0].retries, 1, "pre-expiry retry MUST msg.retry()");
  eq(calls, 0, "hybrid was not invoked while the crashed consumer's lease was still valid");

  // Phase 3 — simulate wall-clock advancing past the lease. In the real DB
  // this is just Date.now() ticking; here we adjust the mock row directly.
  const row = reservationRow(admin)!;
  const expiredIso = new Date(Date.now() - 1_000).toISOString();
  row.lease_expires_at = expiredIso;
  assert(LEASE_TTL_MS > 0, "sanity: lease TTL is positive"); // ensure the constant is exported and finite

  // Phase 4 — a new delivery arrives. CAS takeover succeeds; hybrid runs.
  const postBatch = makeBatch([baseMessage()]);
  await handleShadowQueueBatch(postBatch, env, { buildAdmin: () => admin.client, runHybrid });
  eq(postBatch.wrappers[0].acks, 1, "post-expiry delivery completes and acks");
  eq(postBatch.wrappers[0].retries, 0, "post-expiry delivery does not retry");
  eq(calls, 1, "hybrid invoked exactly once by the recovery consumer");

  const comparisons = admin.tables.get("atlas_pipeline_shadow_comparisons") ?? [];
  eq(comparisons.length, 1, "exactly ONE comparison row across the entire lifecycle");

  const finalRow = reservationRow(admin)!;
  eq(finalRow.status, "completed", "reservation transitioned to completed");
  assert(finalRow.attempt_owner_token !== holderToken,
    "the crashed consumer's owner token was overwritten by the recovery consumer");
});

// ---------------------------------------------------------------------------
// TEST D — token safety: one consumer cannot release another consumer's lease.
// ---------------------------------------------------------------------------

test("D. releaseReservation() is a no-op when called with the wrong owner token", async () => {
  const admin = makeAdminMock({ uniqueIndexes: RESERVATION_INDEX });
  const holder = await tryReserve(admin.client, baseMessage());
  assert(holder.outcome === "reserved", "holder acquired reservation");

  // Attempt to release with a bogus token — must NOT mutate the row.
  const releasedWrong = await releaseReservation(admin.client, baseMessage(), "someone-elses-token", "queued");
  eq(releasedWrong, false, "release with wrong token returns false");

  const row = reservationRow(admin)!;
  eq(row.status, "processing", "row is still processing (wrong-token release was a no-op)");
  eq(row.attempt_owner_token, holder.ownerToken, "owner token is untouched");

  // Correct token succeeds.
  const releasedRight = await releaseReservation(admin.client, baseMessage(), holder.ownerToken, "completed");
  eq(releasedRight, true, "release with correct token succeeds");
  eq(reservationRow(admin)!.status, "completed", "row now completed");
});

// ---------------------------------------------------------------------------
// TEST E — completed / failed_permanent reservations are safe no-ops for
// any later delivery (they neither retry nor overwrite).
// ---------------------------------------------------------------------------

test("E. Completed and failed_permanent reservations are safe no-ops for later deliveries", async () => {
  const admin = makeAdminMock({ uniqueIndexes: RESERVATION_INDEX });
  seedSubmissionAndDocs(admin);
  const env = envWithQueue();

  // Prime a completed row (as if a prior consumer wrote the comparison).
  const first = await tryReserve(admin.client, baseMessage());
  assert(first.outcome === "reserved", "first reservation");
  await releaseReservation(admin.client, baseMessage(), first.ownerToken, "completed");

  const batch = makeBatch([baseMessage()]);
  const runHybrid = (async () => { throw new Error("must not be called"); }) as unknown as Parameters<typeof handleShadowQueueBatch>[2]["runHybrid"];
  await handleShadowQueueBatch(batch, env, { buildAdmin: () => admin.client, runHybrid });
  eq(batch.wrappers[0].acks, 1, "completed → ack");
  eq(batch.wrappers[0].retries, 0, "completed → no retry");

  // Same for failed_permanent.
  const admin2 = makeAdminMock({ uniqueIndexes: RESERVATION_INDEX });
  seedSubmissionAndDocs(admin2);
  const second = await tryReserve(admin2.client, baseMessage());
  assert(second.outcome === "reserved", "second reservation");
  await releaseReservation(admin2.client, baseMessage(), second.ownerToken, "failed_permanent");
  const batch2 = makeBatch([baseMessage()]);
  await handleShadowQueueBatch(batch2, env, { buildAdmin: () => admin2.client, runHybrid });
  eq(batch2.wrappers[0].acks, 1, "failed_permanent → ack");
  eq(batch2.wrappers[0].retries, 0, "failed_permanent → no retry");
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async () => {
  let passed = 0, failed = 0;
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
  console.log(`\nPhase 13 shadow lease lifecycle: ${passed} passed, ${failed} failed out of ${tests.length}`);
  if (failed > 0 && typeof process !== "undefined") process.exitCode = 1;
})();
