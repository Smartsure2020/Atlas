/**
 * Phase 24 — clean-only document trust boundary
 * ---------------------------------------------------------------------------
 *
 * Only documents whose scan_status is EXACTLY "clean" may feed underwriting
 * intelligence. not_scanned, pending, failed, infected, NULL, missing, unknown
 * and any future value are never trusted, and a database/query error must FAIL
 * CLOSED — it must never cause Atlas to retry a document query without the
 * scan_status predicate.
 *
 * Production readers on this boundary:
 *
 *   - extraction (and, through its loaded document set, hybrid extraction)
 *       worker/src/extract-endpoint.ts       loadSubmissionInputs / handleExtract
 *   - quote-review document completeness/evidence
 *       worker/src/quote-review-endpoints.ts loadAvailableDocuments / handleRunQuoteReview
 *   - recommendation document completeness (feeds deriveRisk -> matcher)
 *       worker/src/recommendation-endpoints.ts loadAvailableDocumentTypes / handleRunRecommendation
 *   - the queue-backed shadow pipeline
 *       worker/src/shadow-queue.ts           loadDocumentsForShadow (via handleShadowQueueBatch)
 *   - insurer guideline ingestion (storage download -> Anthropic -> appetite proposals)
 *       worker/src/insurer-endpoints.ts      handleProcessInsurerDoc
 *
 * Proof strategy (behavioural first, source guards as defence in depth):
 *   A. Loaders run against an in-memory database that really evaluates
 *      eq/in filters, so a loader that accepted `not_scanned` would be caught
 *      by the data it returns, not by string matching.
 *   B. The real endpoints run against a fetch-level PostgREST stub, so the
 *      predicate is checked on the actual wire request the Supabase client
 *      sends, and "no Anthropic call / no job / no storage download / no second
 *      documents query" is checked on the actual outbound requests.
 *   C. Source guards stop the accept-list `["clean", "not_scanned"]` and the
 *      unfiltered fallback from being reintroduced.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../worker/src/config.js";
import type { AtlasUser } from "../worker/src/auth.js";
import { handleExtract, loadSubmissionInputs } from "../worker/src/extract-endpoint.js";
import { handleRunQuoteReview, loadAvailableDocuments } from "../worker/src/quote-review-endpoints.js";
import { handleRunRecommendation, loadAvailableDocumentTypes } from "../worker/src/recommendation-endpoints.js";
import { handleProcessInsurerDoc } from "../worker/src/insurer-endpoints.js";
import {
  handleShadowQueueBatch,
  type QueueBatchLike,
  type QueueMessageLike,
  type ShadowQueueMessage,
} from "../worker/src/shadow-queue.js";
import { PIPELINE_VERSION } from "../worker/src/pipeline-version.js";
import { buildExtractionFingerprintV2 } from "../worker/src/phase8-core.js";
import {
  buildExtractionFingerprint,
  buildQuoteReviewFingerprint,
  buildRecommendationFingerprint,
  inputFingerprint,
} from "../worker/src/phase7-core.js";
import { matchInsurers } from "../worker/src/matcher.js";
import type { AppetiteRow } from "../worker/src/matcher-types.js";
import { buildQuoteReview } from "../worker/src/quote-review.js";

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function eq<T>(a: T, b: T, msg: string) {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function sameList(a: readonly string[], b: readonly string[], msg: string) {
  const x = [...a].sort();
  const y = [...b].sort();
  if (JSON.stringify(x) !== JSON.stringify(y)) {
    throw new Error(`${msg}: expected ${JSON.stringify(y)}, got ${JSON.stringify(x)}`);
  }
}

const SUB = "11111111-1111-1111-1111-111111111111";
const EXT = "22222222-2222-2222-2222-222222222222";
const JOB = "33333333-3333-3333-3333-333333333333";
const RAW_DB_ERROR = "SECRET_DB_INTERNAL_relation_atlas_documents_xyz";

type Row = Record<string, unknown>;

/** Every scan state that must NOT be trusted, with how it is represented. */
const UNTRUSTED_STATES: { label: string; scan_status?: unknown; omit?: true }[] = [
  { label: "not_scanned", scan_status: "not_scanned" },
  { label: "pending", scan_status: "pending" },
  { label: "failed", scan_status: "failed" },
  { label: "infected", scan_status: "infected" },
  { label: "null", scan_status: null },
  { label: "missing", omit: true },
  { label: "empty-string", scan_status: "" },
  { label: "unknown", scan_status: "quarantined_by_future_scanner" },
  { label: "case-variant", scan_status: "CLEAN" },
  { label: "padded", scan_status: "clean " },
];

function doc(id: string, scanStatus: unknown, extra: Row = {}, omitScan = false): Row {
  const row: Row = {
    id,
    submission_id: SUB,
    file_name: `${id}.pdf`,
    storage_path: `${SUB}/${id}.pdf`,
    document_type: `type-${id}`,
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    file_hash: null,
    ...extra,
  };
  if (!omitScan) row.scan_status = scanStatus;
  return row;
}

/** One clean document plus one document in every untrusted scan state. */
function mixedDocuments(): { rows: Row[]; cleanId: string; untrustedIds: string[] } {
  const rows: Row[] = [doc("d-clean", "clean")];
  const untrustedIds: string[] = [];
  for (const s of UNTRUSTED_STATES) {
    const id = `d-${s.label}`;
    untrustedIds.push(id);
    rows.push(doc(id, s.scan_status, {}, s.omit === true));
  }
  return { rows, cleanId: "d-clean", untrustedIds };
}

// ---------------------------------------------------------------------------
// A. In-memory database that really evaluates filters
// ---------------------------------------------------------------------------

interface Filter { op: "eq" | "neq" | "in" | "lt"; key: string; val?: unknown; vals?: unknown[] }

/** `loose`: URL query values are strings, so compare stringified (e.g. is_active=eq.true). */
function evalFilters(row: Row, filters: Filter[], loose = false): boolean {
  return filters.every((f) => {
    const cell = row[f.key];
    switch (f.op) {
      case "eq": return loose ? cell != null && String(cell) === String(f.val) : cell === f.val;
      case "neq": return cell !== f.val;
      case "in":
        return loose
          ? (f.vals ?? []).some((v) => cell != null && String(v) === String(cell))
          : (f.vals ?? []).includes(cell);
      case "lt": return cell != null && (cell as never) < (f.val as never);
    }
  });
}

interface DocumentQueryLog { filters: Filter[]; columns: string }

const UNIQUE_KEYS: Record<string, string[]> = {
  atlas_shadow_reservations: ["input_fingerprint", "pipeline_version"],
  atlas_pipeline_shadow_comparisons: ["input_fingerprint", "pipeline_version"],
};

function makeAdmin(
  seed: Record<string, Row[]>,
  opts: { failDocuments?: "first" | "all" } = {}
) {
  const tables = new Map<string, Row[]>(
    Object.entries(seed).map(([name, rows]) => [name, rows.map((r) => ({ ...r }))])
  );
  const documentQueries: DocumentQueryLog[] = [];
  const ensure = (t: string): Row[] => {
    if (!tables.has(t)) tables.set(t, []);
    return tables.get(t)!;
  };

  const from = (table: string) => {
    const q = {
      op: "select" as "select" | "insert" | "update" | "upsert",
      columns: "*",
      filters: [] as Filter[],
      payload: undefined as Row | Row[] | undefined,
      mode: "many" as "many" | "maybe" | "one",
      returning: false,
      onConflict: undefined as string | undefined,
      ignoreDuplicates: false,
    };
    const b: Record<string, unknown> = {};
    b.select = (cols = "*") => { if (q.op === "select") q.columns = cols; else q.returning = true; return b; };
    b.eq = (key: string, val: unknown) => { q.filters.push({ op: "eq", key, val }); return b; };
    b.neq = (key: string, val: unknown) => { q.filters.push({ op: "neq", key, val }); return b; };
    b.in = (key: string, vals: unknown[]) => { q.filters.push({ op: "in", key, vals }); return b; };
    b.lt = (key: string, val: unknown) => { q.filters.push({ op: "lt", key, val }); return b; };
    b.order = () => b;
    b.limit = () => b;
    b.maybeSingle = () => { q.mode = "maybe"; return b; };
    b.single = () => { q.mode = "one"; return b; };
    b.insert = (row: Row | Row[]) => { q.op = "insert"; q.payload = row; return b; };
    b.update = (patch: Row) => { q.op = "update"; q.payload = patch; return b; };
    b.upsert = (row: Row, o?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
      q.op = "upsert"; q.payload = row; q.onConflict = o?.onConflict; q.ignoreDuplicates = o?.ignoreDuplicates === true;
      return b;
    };

    const execute = (): { data: unknown; error: unknown } => {
      const rows = ensure(table);
      if (q.op === "select") {
        if (table === "atlas_documents") {
          documentQueries.push({ filters: [...q.filters], columns: q.columns });
          const n = documentQueries.length;
          if (opts.failDocuments === "all" || (opts.failDocuments === "first" && n === 1)) {
            return { data: null, error: { message: RAW_DB_ERROR, code: "57P03" } };
          }
        }
        const hits = rows.filter((r) => evalFilters(r, q.filters)).map((r) => ({ ...r }));
        if (q.mode === "many") return { data: hits, error: null };
        if (q.mode === "maybe") return { data: hits[0] ?? null, error: null };
        return hits.length === 1
          ? { data: hits[0], error: null }
          : { data: null, error: { code: "PGRST116", message: "no rows" } };
      }
      if (q.op === "insert" || q.op === "upsert") {
        const incoming = Array.isArray(q.payload) ? q.payload : [q.payload as Row];
        const keys = UNIQUE_KEYS[table];
        for (const row of incoming) {
          const dup = keys ? rows.some((e) => keys.every((k) => e[k] === row[k])) : false;
          if (dup) {
            if (q.op === "upsert" && q.ignoreDuplicates) continue;
            return { data: null, error: { code: "23505", message: "duplicate_key" } };
          }
          rows.push({ ...row });
        }
        return { data: q.returning ? incoming : null, error: null };
      }
      // update
      const updated: Row[] = [];
      for (const row of rows) {
        if (evalFilters(row, q.filters)) {
          Object.assign(row, q.payload as Row);
          updated.push({ ...row });
        }
      }
      return { data: q.returning ? updated : null, error: null };
    };
    (b as { then: unknown }).then = (resolveFn: (v: unknown) => unknown, rejectFn?: (e: unknown) => unknown) =>
      Promise.resolve().then(execute).then(resolveFn, rejectFn);
    return b;
  };

  return {
    tables,
    documentQueries,
    client: { from, storage: { from: () => ({ download: async () => ({ data: null, error: null }) }) } } as unknown as SupabaseClient,
  };
}

function assertTrustPredicate(q: DocumentQueryLog, label: string) {
  const scan = q.filters.filter((f) => f.key === "scan_status");
  eq(scan.length, 1, `${label}: exactly one scan_status filter`);
  eq(scan[0].op, "eq", `${label}: scan_status filter is an equality`);
  eq(scan[0].val, "clean", `${label}: scan_status must equal 'clean'`);
}

// ---------------------------------------------------------------------------
// B. Fetch-level PostgREST / Storage / Anthropic stub
// ---------------------------------------------------------------------------

interface Recorded {
  method: string;
  url: URL;
  /** `rest:<table>`, `storage`, `anthropic` or `other`. */
  kind: string;
  body: unknown;
}

function installFetchStub(opts: {
  tables: Record<string, Row[]>;
  /** First atlas_documents GET fails with a raw DB error; later ones are a TRAP returning every row unfiltered. */
  failDocuments?: boolean;
  /** Same failure + trap behaviour for any other table (e.g. atlas_insurer_documents). */
  failTables?: string[];
}) {
  const requests: Recorded[] = [];
  const unsupported: string[] = [];
  const getCounts: Record<string, number> = {};
  const original = globalThis.fetch;

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : (input as { url: string }).url ?? String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }

    if (url.hostname === "api.anthropic.com") {
      requests.push({ method, url, kind: "anthropic", body });
      // Deliberately unparsable: the extraction ends in extraction_parse_failed,
      // which is all these tests need after proving what was sent.
      return jsonResponse({ content: [{ type: "text", text: "not-json" }], usage: { input_tokens: 1, output_tokens: 1 } });
    }

    if (url.pathname.startsWith("/storage/v1/")) {
      requests.push({ method, url, kind: "storage", body });
      const path = decodeURIComponent(url.pathname.replace(/^\/storage\/v1\/object\/(authenticated\/)?[^/]+\//, ""));
      return new Response(new TextEncoder().encode(`%PDF-1.4 bytes-of:${path}`), { status: 200 });
    }

    const m = url.pathname.match(/^\/rest\/v1\/([a-z_0-9]+)$/);
    if (!m) {
      requests.push({ method, url, kind: "other", body });
      return jsonResponse({ message: "stub: unexpected request" }, 500);
    }
    const table = m[1];
    requests.push({ method, url, kind: `rest:${table}`, body });
    const wantsObject = (headers.get("accept") ?? "").includes("vnd.pgrst.object+json");
    const wantsRepresentation = (headers.get("prefer") ?? "").includes("return=representation");

    if (method === "GET") {
      const filters: Filter[] = [];
      url.searchParams.forEach((value, key) => {
        if (["select", "order", "limit", "offset"].includes(key)) return;
        if (value.startsWith("eq.")) filters.push({ op: "eq", key, val: value.slice(3) });
        else if (value.startsWith("in.(") && value.endsWith(")")) {
          filters.push({ op: "in", key, vals: value.slice(4, -1).split(",").map((v) => v.replace(/^"|"$/g, "")) });
        } else {
          unsupported.push(`${table}.${key}=${value}`);
        }
      });
      let rows = opts.tables[table] ?? [];
      getCounts[table] = (getCounts[table] ?? 0) + 1;
      const failing = (table === "atlas_documents" && opts.failDocuments === true) || (opts.failTables ?? []).includes(table);
      if (failing && getCounts[table] === 1) {
        return jsonResponse({ code: "57P03", message: RAW_DB_ERROR, details: null, hint: null }, 500);
      }
      // Second and later queries to a failing table are the forbidden "legacy
      // fallback": answer with EVERY row so a fallback would be visible.
      if (!failing) rows = rows.filter((r) => evalFilters(r, filters, true));
      if (wantsObject) {
        return rows.length === 1
          ? jsonResponse(rows[0])
          : jsonResponse({ code: "PGRST116", details: "0 rows", hint: null, message: "JSON object requested, multiple (or no) rows returned" }, 406);
      }
      return jsonResponse(rows);
    }

    // Writes (jobs, audits, metrics, alerts…): acknowledge generically.
    if (wantsRepresentation) {
      return wantsObject ? jsonResponse({ id: `stub-${table}` }, 201) : jsonResponse([{ id: `stub-${table}` }], 201);
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  return {
    requests,
    unsupported,
    restore: () => { globalThis.fetch = original; },
    of: (kind: string) => requests.filter((r) => r.kind === kind),
    writes: (table: string) => requests.filter((r) => r.kind === `rest:${table}` && r.method !== "GET"),
  };
}

function stubEnv(): Env {
  return {
    SUPABASE_URL: "http://stub.supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
    ANTHROPIC_API_KEY: "anthropic-test-key",
  } as unknown as Env;
}

const MANAGER: AtlasUser = { id: "user-1", email: "manager@example.test", role: "manager" };

function jsonRequest(body: unknown): Request {
  return new Request("https://atlas.test/api/x", { method: "POST", body: JSON.stringify(body) });
}

/** Run `fn` with console.error captured, so logs can be asserted on. */
async function withCapturedErrors<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")); };
  try {
    return { result: await fn(), logs: lines.join("\n") };
  } finally {
    console.error = original;
  }
}

// ---------------------------------------------------------------------------
// Shadow queue scaffolding
// ---------------------------------------------------------------------------

function shadowMessage(): ShadowQueueMessage {
  return {
    v: 1,
    submissionId: SUB,
    legacyExtractionId: EXT,
    legacyJobId: JOB,
    inputFingerprint: "fp-trust-1",
    pipelineVersion: PIPELINE_VERSION,
    organisationId: null,
    enqueuedAt: Date.now() - 25,
    legacyTotals: { totalMs: 25000, inputTokens: 8000, outputTokens: 1500 },
  };
}

function makeBatch(body: ShadowQueueMessage) {
  const wrapper = {
    id: "msg-1",
    timestamp: new Date(),
    body,
    acks: 0,
    retries: 0,
    ack() { wrapper.acks++; },
    retry() { wrapper.retries++; },
  };
  const batch: QueueBatchLike<ShadowQueueMessage> = { messages: [wrapper as QueueMessageLike<ShadowQueueMessage>] };
  return { batch, wrapper };
}

type RunHybrid = Parameters<typeof handleShadowQueueBatch>[2]["runHybrid"];

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
    metrics: { pipelineMode: "shadow" as const, route: "text_fast_path" as const, finalStatus: "shadow" as const, totalMs: 10 },
  };
}

function shadowSeed(documents: Row[]): Record<string, Row[]> {
  return {
    atlas_submissions: [{ id: SUB, broker_email_body: null, organisation_id: null }],
    atlas_documents: documents,
    atlas_extractions: [{ id: EXT, extracted_json: { extracted_client: { name: { value: "Acme Ltd" } } } }],
  };
}

const shadowEnv = { ATLAS_SHADOW_SAMPLE_PERCENT: "100", AZURE_DOCUMENT_INTELLIGENCE_MODEL: "prebuilt-layout" } as unknown as Env;

// ---------------------------------------------------------------------------
// 1-2. Extraction loader: includes clean, excludes every other state
// ---------------------------------------------------------------------------

test("1. extraction loader includes a clean document", async () => {
  const admin = makeAdmin({
    atlas_submissions: [{ id: SUB, broker_email_body: "Please quote" }],
    atlas_documents: [doc("d-clean", "clean")],
  });
  const out = await loadSubmissionInputs(admin.client, SUB);
  assert(out.ok, "loader should succeed");
  sameList(out.loaded.docs.map((d) => d.id), ["d-clean"], "clean document loaded");
  eq(out.loaded.submissionBrokerEmail, "Please quote", "broker email preserved");
});

test("2. extraction loader excludes not_scanned, pending, failed, infected, null, missing and unknown", async () => {
  const { rows, cleanId, untrustedIds } = mixedDocuments();
  assert(untrustedIds.length >= 10, "every untrusted state is represented");
  const admin = makeAdmin({
    atlas_submissions: [{ id: SUB, broker_email_body: null }],
    atlas_documents: rows,
  });
  const out = await loadSubmissionInputs(admin.client, SUB);
  assert(out.ok, "loader should succeed");
  sameList(out.loaded.docs.map((d) => d.id), [cleanId], "ONLY the exact-clean document is loaded");
  eq(admin.documentQueries.length, 1, "exactly one documents query");
  assertTrustPredicate(admin.documentQueries[0], "extraction");
  assert(
    !admin.documentQueries[0].filters.some((f) => f.op === "in" && f.key === "scan_status"),
    "no scan_status allow-list"
  );
});

test("2b. extraction loader still excludes clean documents that are not active", async () => {
  const admin = makeAdmin({
    atlas_submissions: [{ id: SUB, broker_email_body: null }],
    atlas_documents: [doc("d-clean", "clean"), doc("d-expired", "clean", { status: "expired" })],
  });
  const out = await loadSubmissionInputs(admin.client, SUB);
  assert(out.ok, "loader should succeed");
  sameList(out.loaded.docs.map((d) => d.id), ["d-clean"], "expired clean document not loaded");
});

test("3. extraction fingerprint is built only from the clean-only loaded set", async () => {
  const withUntrusted = makeAdmin({
    atlas_submissions: [{ id: SUB, broker_email_body: "x" }],
    atlas_documents: [doc("d-clean", "clean"), doc("d-legacy", "not_scanned"), doc("d-pending", "pending")],
  });
  const cleanOnly = makeAdmin({
    atlas_submissions: [{ id: SUB, broker_email_body: "x" }],
    atlas_documents: [doc("d-clean", "clean")],
  });
  const a = await loadSubmissionInputs(withUntrusted.client, SUB);
  const b = await loadSubmissionInputs(cleanOnly.client, SUB);
  assert(a.ok && b.ok, "both loads succeed");
  const fp = (docs: Row[]) => buildExtractionFingerprintV2({ submissionId: SUB, brokerEmailPresent: true, documents: docs as never });
  eq(fp(a.loaded.docs as unknown as Row[]), fp(b.loaded.docs as unknown as Row[]), "untrusted documents do not influence the fingerprint");
});

test("4. extraction loader: zero clean documents is a successful empty result (broker-email-only stays possible)", async () => {
  const admin = makeAdmin({
    atlas_submissions: [{ id: SUB, broker_email_body: "Broker email text" }],
    atlas_documents: [doc("d-legacy", "not_scanned"), doc("d-pending", "pending")],
  });
  const out = await loadSubmissionInputs(admin.client, SUB);
  assert(out.ok, "an empty clean set is NOT a failure");
  eq(out.loaded.docs.length, 0, "no documents");
  eq(out.loaded.submissionBrokerEmail, "Broker email text", "email retained");
});

test("5. extraction loader: unknown submission is reported as submission_not_found", async () => {
  const admin = makeAdmin({ atlas_submissions: [], atlas_documents: [] });
  const out = await loadSubmissionInputs(admin.client, SUB);
  assert(!out.ok && out.reason === "submission_not_found", "not found");
  eq(admin.documentQueries.length, 0, "documents never queried for a missing submission");
});

// ---------------------------------------------------------------------------
// 6-7. Extraction loader: query failure fails closed, no fallback query
// ---------------------------------------------------------------------------

test("6. extraction loader: a failed document query fails closed with NO unfiltered second query", async () => {
  const { rows } = mixedDocuments();
  // 'first': a legacy-columns / unfiltered retry WOULD succeed and return every row.
  const admin = makeAdmin(
    { atlas_submissions: [{ id: SUB, broker_email_body: "x" }], atlas_documents: rows },
    { failDocuments: "first" }
  );
  const out = await loadSubmissionInputs(admin.client, SUB);
  assert(!out.ok && out.reason === "documents_query_failed", "fails closed");
  eq(admin.documentQueries.length, 1, "no second (fallback) documents query was issued");
  assertTrustPredicate(admin.documentQueries[0], "extraction");
});

test("7. extraction loader: fails closed when every document query errors", async () => {
  const { rows } = mixedDocuments();
  const admin = makeAdmin(
    { atlas_submissions: [{ id: SUB, broker_email_body: "x" }], atlas_documents: rows },
    { failDocuments: "all" }
  );
  const out = await loadSubmissionInputs(admin.client, SUB);
  assert(!out.ok && out.reason === "documents_query_failed", "fails closed");
  eq(admin.documentQueries.length, 1, "still exactly one documents query");
});

// ---------------------------------------------------------------------------
// 8-10. handleExtract end to end against the fetch stub
// ---------------------------------------------------------------------------

/**
 * The request shape the background job runner uses (phase4-background): an
 * already-claimed job is passed as `background_job_id`, so handleExtract goes
 * straight to processing instead of just queueing a job.
 */
function backgroundExtractRequest(): Request {
  return jsonRequest({ force: true, background_job_id: JOB });
}

function extractionTables(documents: Row[]): Record<string, Row[]> {
  return {
    atlas_submissions: [{ id: SUB, broker_email_body: "BROKER-EMAIL-BODY-TEXT" }],
    atlas_documents: documents,
    atlas_jobs: [{ id: JOB, status: "running", cancellation_requested: false }],
  };
}

test("8. handleExtract: document query failure -> 503, no Anthropic, no job, no download, no second documents query", async () => {
  const { rows } = mixedDocuments();
  const stub = installFetchStub({ tables: extractionTables(rows), failDocuments: true });
  try {
    const { result: res, logs } = await withCapturedErrors(() =>
      handleExtract(SUB, backgroundExtractRequest(), stubEnv(), MANAGER)
    );
    const text = await res.text();
    eq(res.status, 503, "safe operational status");
    eq((JSON.parse(text) as { error: string }).error, "document_trust_check_unavailable", "stable error code");
    assert(!text.includes(RAW_DB_ERROR), "raw database error must not reach the response");
    assert(!logs.includes(RAW_DB_ERROR), "raw database error must not reach the logs");
    assert(logs.includes("document_trust_check_unavailable"), "operational log carries the stable code");

    const docsRequests = stub.of("rest:atlas_documents");
    eq(docsRequests.length, 1, "exactly one documents request (no fallback)");
    eq(docsRequests[0].url.searchParams.get("scan_status"), "eq.clean", "wire request filters scan_status=eq.clean");
    eq(docsRequests[0].url.searchParams.get("status"), "eq.active", "wire request still filters status=eq.active");
    eq(stub.of("anthropic").length, 0, "Anthropic never called");
    eq(stub.of("storage").length, 0, "no document downloaded");
    eq(stub.of("rest:atlas_jobs").length, 0, "no job created or touched");
    eq(stub.of("rest:atlas_extractions").length, 0, "nothing persisted");
    eq(stub.unsupported.length, 0, "stub understood every filter: " + stub.unsupported.join(","));
  } finally {
    stub.restore();
  }
});

test("9. handleExtract: only clean PDFs reach Anthropic; untrusted documents are never downloaded", async () => {
  const { rows, cleanId, untrustedIds } = mixedDocuments();
  // A clean non-PDF stays ignored by the legacy PDF path (unchanged behaviour).
  rows.push(doc("d-clean-xlsx", "clean", { file_name: "sheet.xlsx", storage_path: `${SUB}/sheet.xlsx` }));
  const stub = installFetchStub({ tables: extractionTables(rows) });
  try {
    const { result: res } = await withCapturedErrors(() => handleExtract(SUB, backgroundExtractRequest(), stubEnv(), MANAGER));
    await res.text();

    const anthropic = stub.of("anthropic");
    eq(anthropic.length, 1, "Anthropic called once");
    const payload = JSON.stringify(anthropic[0].body);
    assert(payload.includes(`document_id: ${cleanId}`), "clean PDF is attached");
    for (const id of untrustedIds) {
      assert(!payload.includes(`document_id: ${id}`), `untrusted document ${id} must not be attached`);
    }
    assert(!payload.includes("d-clean-xlsx"), "clean non-PDF stays ignored by the legacy PDF path");

    const downloads = stub.of("storage").map((r) => decodeURIComponent(r.url.pathname));
    eq(downloads.length, 1, "exactly one document downloaded");
    assert(downloads[0].endsWith(`${cleanId}.pdf`), "only the clean PDF is downloaded: " + downloads[0]);

    const docsRequests = stub.of("rest:atlas_documents");
    eq(docsRequests.length, 1, "single documents query");
    eq(docsRequests[0].url.searchParams.get("scan_status"), "eq.clean", "wire request filters scan_status=eq.clean");
    eq(stub.unsupported.length, 0, "stub understood every filter: " + stub.unsupported.join(","));
  } finally {
    stub.restore();
  }
});

test("10. handleExtract: broker-email-only extraction still runs when there are zero clean documents", async () => {
  const stub = installFetchStub({
    tables: extractionTables([doc("d-legacy", "not_scanned"), doc("d-pending", "pending"), doc("d-null", null)]),
  });
  try {
    const { result: res } = await withCapturedErrors(() => handleExtract(SUB, backgroundExtractRequest(), stubEnv(), MANAGER));
    await res.text();
    assert(res.status !== 400 && res.status !== 503, "not rejected as nothing_to_extract / trust-check failure: " + res.status);

    const anthropic = stub.of("anthropic");
    eq(anthropic.length, 1, "Anthropic called from the broker email");
    const payload = JSON.stringify(anthropic[0].body);
    assert(payload.includes("BROKER-EMAIL-BODY-TEXT"), "broker email sent");
    assert(!payload.includes('"type":"document"'), "no document blocks attached");
    eq(stub.of("storage").length, 0, "no document downloaded");
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// 11-13. Quote review
// ---------------------------------------------------------------------------

test("11. quote review counts only clean documents as available evidence", async () => {
  const { rows, cleanId, untrustedIds } = mixedDocuments();
  const admin = makeAdmin({ atlas_documents: rows });
  const out = await loadAvailableDocuments(admin.client, SUB);
  assert(out.ok, "loader should succeed");
  sameList(out.availableDocuments, [`type-${cleanId}`, `${cleanId}.pdf`], "only the clean document's type and name");
  for (const id of untrustedIds) {
    assert(!out.availableDocuments.some((n) => n.includes(id)), `untrusted document ${id} must not count`);
  }
  eq(admin.documentQueries.length, 1, "single documents query");
  assertTrustPredicate(admin.documentQueries[0], "quote review");
});

test("12. quote review: a failed document query is { ok:false }, never an empty availability list", async () => {
  const { rows } = mixedDocuments();
  const first = makeAdmin({ atlas_documents: rows }, { failDocuments: "first" });
  const out = await loadAvailableDocuments(first.client, SUB);
  assert(!out.ok, "fails closed");
  eq(first.documentQueries.length, 1, "no fallback query");

  // A SUCCESSFUL empty result is a different, valid outcome.
  const empty = makeAdmin({ atlas_documents: [doc("d-legacy", "not_scanned")] });
  const none = await loadAvailableDocuments(empty.client, SUB);
  assert(none.ok && none.availableDocuments.length === 0, "zero clean documents is ok:true with an empty list");
});

test("13. handleRunQuoteReview: document query failure -> 503, no job, no quote review persisted", async () => {
  const { rows } = mixedDocuments();
  const stub = installFetchStub({
    failDocuments: true,
    tables: {
      atlas_extractions: [{ id: EXT, submission_id: SUB, reviewed_json: { schema_version: "t" }, extraction_confidence: 0.9 }],
      atlas_documents: rows,
    },
  });
  try {
    const { result: res, logs } = await withCapturedErrors(() =>
      handleRunQuoteReview(SUB, jsonRequest({ insurer_id: "insurer-1" }), stubEnv(), MANAGER)
    );
    const text = await res.text();
    eq(res.status, 503, "safe operational status");
    eq((JSON.parse(text) as { error: string }).error, "document_trust_check_unavailable", "stable error code");
    assert(!text.includes(RAW_DB_ERROR), "raw database error must not reach the response");
    assert(!logs.includes(RAW_DB_ERROR), "raw database error must not reach the logs");

    const docsRequests = stub.of("rest:atlas_documents");
    eq(docsRequests.length, 1, "exactly one documents request (no fallback)");
    eq(docsRequests[0].url.searchParams.get("scan_status"), "eq.clean", "wire request filters scan_status=eq.clean");
    eq(docsRequests[0].url.searchParams.get("status"), "eq.active", "wire request still filters status=eq.active");
    eq(stub.of("rest:atlas_jobs").length, 0, "no job created");
    eq(stub.of("rest:atlas_quote_reviews").length, 0, "no quote review persisted");
    eq(stub.of("rest:atlas_quote_review_sections").length, 0, "no quote review sections persisted");
    eq(stub.of("rest:atlas_insurer_appetite").length, 0, "review did not continue to appetite matching");
    eq(stub.unsupported.length, 0, "stub understood every filter: " + stub.unsupported.join(","));
  } finally {
    stub.restore();
  }
});

test("13b. handleRunQuoteReview positive control: with a healthy documents query the review proceeds past the gate", async () => {
  const { rows } = mixedDocuments();
  const stub = installFetchStub({
    tables: {
      atlas_extractions: [{ id: EXT, submission_id: SUB, reviewed_json: { schema_version: "t" }, extraction_confidence: 0.9 }],
      atlas_documents: rows,
    },
  });
  try {
    // The review itself may stop later on the minimal fixture; only the gate matters here.
    await withCapturedErrors(async () => {
      try { await (await handleRunQuoteReview(SUB, jsonRequest({ insurer_id: "insurer-1" }), stubEnv(), MANAGER)).text(); } catch { /* downstream fixture limits */ }
    });
    assert(stub.of("rest:atlas_insurer_appetite").length > 0, "review continued to appetite matching (so the 503 above is the gate, not a fixture problem)");
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// 14-17. Shadow queue
// ---------------------------------------------------------------------------

test("14. shadow loader passes only clean documents to hybrid", async () => {
  const { rows, cleanId } = mixedDocuments();
  const admin = makeAdmin(shadowSeed(rows));
  const seen: { ids: string[] | null } = { ids: null };
  const runHybrid = (async (input: { documents: { id: string }[] }) => {
    seen.ids = input.documents.map((d) => d.id);
    return fakeHybridResult();
  }) as unknown as RunHybrid;
  const { batch, wrapper } = makeBatch(shadowMessage());
  await handleShadowQueueBatch(batch, shadowEnv, { buildAdmin: () => admin.client, runHybrid });

  assert(seen.ids !== null, "hybrid was invoked");
  sameList(seen.ids, [cleanId], "hybrid received ONLY the clean document");
  eq(admin.documentQueries.length, 1, "single documents query");
  assertTrustPredicate(admin.documentQueries[0], "shadow");
  assert(
    !admin.documentQueries[0].filters.some((f) => f.op === "in" && f.key === "scan_status"),
    "no scan_status allow-list"
  );
  eq(wrapper.acks, 1, "message acked");
});

test("15. shadow: zero clean documents is not a query failure (continues through existing orchestration)", async () => {
  const admin = makeAdmin(shadowSeed([doc("d-legacy", "not_scanned"), doc("d-pending", "pending")]));
  const seen: { count: number | null } = { count: null };
  const runHybrid = (async (input: { documents: unknown[] }) => {
    seen.count = input.documents.length;
    return fakeHybridResult();
  }) as unknown as RunHybrid;
  const { batch, wrapper } = makeBatch(shadowMessage());
  await handleShadowQueueBatch(batch, shadowEnv, { buildAdmin: () => admin.client, runHybrid });
  eq(seen.count, 0, "hybrid invoked with an empty trusted set");
  eq(wrapper.acks, 1, "acked, not retried");
  eq(wrapper.retries, 0, "no retry");
});

async function runShadowWithFailingDocuments(mode: "first" | "all") {
  const { rows } = mixedDocuments();
  const admin = makeAdmin(shadowSeed(rows), { failDocuments: mode });
  let hybridCalls = 0;
  const runHybrid = (async () => { hybridCalls++; return fakeHybridResult(); }) as unknown as RunHybrid;
  const { batch, wrapper } = makeBatch(shadowMessage());
  await handleShadowQueueBatch(batch, shadowEnv, { buildAdmin: () => admin.client, runHybrid });
  return { admin, wrapper, hybridCalls };
}

test("16. shadow: a failed clean-document query does not run hybrid and issues NO unfiltered fallback query", async () => {
  const { admin, hybridCalls } = await runShadowWithFailingDocuments("first");
  eq(hybridCalls, 0, "runHybrid must not be invoked");
  eq(admin.documentQueries.length, 1, "no second (legacy/unfiltered) documents query");
  assertTrustPredicate(admin.documentQueries[0], "shadow");
});

test("17. shadow: a failed clean-document query stays transient and retryable under existing queue semantics", async () => {
  for (const mode of ["first", "all"] as const) {
    const { admin, wrapper, hybridCalls } = await runShadowWithFailingDocuments(mode);
    eq(hybridCalls, 0, `[${mode}] hybrid not invoked`);
    eq(wrapper.retries, 1, `[${mode}] message retried`);
    eq(wrapper.acks, 0, `[${mode}] message NOT acked (a DB outage must not become permanent)`);
    const reservation = (admin.tables.get("atlas_shadow_reservations") ?? [])[0];
    eq(reservation?.status, "queued", `[${mode}] reservation released back to queued, not failed_permanent`);
    const metrics = (admin.tables.get("atlas_pipeline_metrics") ?? []).map((m) => JSON.stringify(m));
    assert(!metrics.some((m) => m.includes("permanent:")), `[${mode}] no permanent-failure metric recorded`);
    assert(!JSON.stringify([...admin.tables.values()]).includes(RAW_DB_ERROR), `[${mode}] raw database error not persisted`);
  }
});

// ---------------------------------------------------------------------------
// 18-21. Static / regression guards (defence in depth)
// ---------------------------------------------------------------------------

const WORKER_SRC = resolve(process.cwd(), "worker/src");
const read = (file: string) => readFileSync(resolve(WORKER_SRC, file), "utf8");

/** Drop comments so guards look at code, not at prose describing the rule. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const TRUST_PATHS = ["extract-endpoint.ts", "quote-review-endpoints.ts", "recommendation-endpoints.ts", "shadow-queue.ts"];

test("18. trust paths never accept ['clean', 'not_scanned'] or any scan_status allow-list", () => {
  for (const file of TRUST_PATHS) {
    const code = stripComments(read(file));
    assert(!/\.in\(\s*["']scan_status["']/.test(code), `${file}: .in("scan_status", …) allow-list reintroduced`);
    assert(!/["']clean["']\s*,\s*["']not_scanned["']/.test(code), `${file}: ["clean", "not_scanned"] reintroduced`);
    assert(!/["']not_scanned["']/.test(code), `${file}: not_scanned must not appear in a processing path`);
    assert(/\.eq\(\s*["']scan_status["']\s*,\s*["']clean["']\s*\)/.test(code), `${file}: exact .eq("scan_status", "clean") predicate missing`);
  }
});

test("19. trust paths read atlas_documents exactly once (no legacy / unfiltered fallback query)", () => {
  for (const file of TRUST_PATHS) {
    const code = stripComments(read(file));
    const reads = code.match(/\.from\(\s*["']atlas_documents["']\s*\)/g) ?? [];
    eq(reads.length, 1, `${file}: atlas_documents read count`);
  }
});

test("20. no worker source anywhere accepts a scan_status allow-list that includes not_scanned", () => {
  for (const file of readdirSync(WORKER_SRC).filter((f) => f.endsWith(".ts"))) {
    const code = stripComments(read(file));
    assert(!/\.in\(\s*["']scan_status["']/.test(code), `${file}: .in("scan_status", …) found`);
    assert(!/["']clean["']\s*,\s*["']not_scanned["']|["']not_scanned["']\s*,\s*["']clean["']/.test(code), `${file}: clean/not_scanned allow-list found`);
  }
});

test("21. hybrid extraction receives only the clean-only loaded set and never reads atlas_documents itself", () => {
  const extract = stripComments(read("extract-endpoint.ts"));
  assert(/documents:\s*params\.loaded\.docs/.test(extract), "runHybridExtraction input is params.loaded.docs");
  assert(/const loaded = inputs\.loaded;/.test(extract), "handleExtract's `loaded` comes only from the trust-checked loader");
  for (const file of readdirSync(WORKER_SRC).filter((f) => /^(hybrid|section|parser|pipeline-router)/.test(f) && f.endsWith(".ts"))) {
    assert(!/atlas_documents/.test(stripComments(read(file))), `${file}: must not read atlas_documents directly`);
  }
});

// ---------------------------------------------------------------------------
// 22-26. Recommendation document completeness
// ---------------------------------------------------------------------------

/** mixedDocuments() plus a clean document that is no longer active. */
function recommendationDocuments(): { rows: Row[]; cleanId: string } {
  const { rows, cleanId } = mixedDocuments();
  rows.push(doc("d-expired-clean", "clean", { status: "expired" }));
  return { rows, cleanId };
}

function assertActiveFilter(q: DocumentQueryLog, label: string) {
  const status = q.filters.filter((f) => f.key === "status");
  eq(status.length, 1, `${label}: exactly one status filter`);
  eq(status[0].op, "eq", `${label}: status filter is an equality`);
  eq(status[0].val, "active", `${label}: status must equal 'active'`);
}

test("22. recommendation loader counts only active + clean documents", async () => {
  const { rows, cleanId } = recommendationDocuments();
  const admin = makeAdmin({ atlas_documents: rows });
  const out = await loadAvailableDocumentTypes(admin.client, SUB);
  assert(out.ok, "loader should succeed");
  sameList(out.availableDocs, [`type-${cleanId}`], "only the active clean document's type counts");
  assert(!out.availableDocs.includes("type-d-expired-clean"), "an inactive clean document does not count");
  eq(admin.documentQueries.length, 1, "single documents query");
  assertTrustPredicate(admin.documentQueries[0], "recommendation");
  assertActiveFilter(admin.documentQueries[0], "recommendation");
});

test("23. recommendation loader: a failed query is { ok:false } (never []), no fallback; zero clean documents is ok:true", async () => {
  const { rows } = recommendationDocuments();
  for (const mode of ["first", "all"] as const) {
    const admin = makeAdmin({ atlas_documents: rows }, { failDocuments: mode });
    const out = await loadAvailableDocumentTypes(admin.client, SUB);
    assert(!out.ok, `[${mode}] fails closed`);
    eq(admin.documentQueries.length, 1, `[${mode}] no fallback documents query`);
  }
  const none = makeAdmin({ atlas_documents: [doc("d-legacy", "not_scanned"), doc("d-pending", "pending")] });
  const empty = await loadAvailableDocumentTypes(none.client, SUB);
  assert(empty.ok && empty.availableDocs.length === 0, "zero clean documents is a valid empty result");
});

const RULE_PORTFOLIO: Row = {
  id: "rule-1", insurer_id: "insurer-1", insurer_name: "Acme Insurance", product_line: "*", risk_type: "*",
  appetite_level: "standard", preferred_risks: [], caution_risks: [], declined_risks: [],
  required_documents: ["Policy schedule"], referral_triggers: [], notes: null, source: "manual",
  source_document_id: null, is_active: true, updated_at: "2026-01-01T00:00:00Z",
};

function recommendationTables(documents: Row[]): Record<string, Row[]> {
  return {
    atlas_extractions: [{
      id: EXT, submission_id: SUB, extracted_json: {}, reviewed_json: { schema_version: "t" },
      reviewed_at: "2026-01-02T00:00:00Z", extraction_confidence: 0.9,
    }],
    atlas_documents: documents,
    atlas_insurer_appetite: [RULE_PORTFOLIO],
    atlas_jobs: [{ id: JOB, status: "running", cancellation_requested: false }],
  };
}

const backgroundRequest = () => jsonRequest({ force: true, background_job_id: JOB });

function persistedAvailableDocuments(stub: ReturnType<typeof installFetchStub>): string[] {
  const writes = stub.writes("atlas_recommendations");
  eq(writes.length, 1, "exactly one recommendation persisted");
  const row = writes[0].body as { reasoning_json: { matcher_input: { available_documents: string[] } } };
  return row.reasoning_json.matcher_input.available_documents;
}

test("24. handleRunRecommendation: document query failure -> 503 before any job, matching, reasoning or persistence", async () => {
  const { rows } = recommendationDocuments();
  const stub = installFetchStub({ tables: recommendationTables(rows), failDocuments: true });
  try {
    const { result: res, logs } = await withCapturedErrors(() =>
      handleRunRecommendation(SUB, backgroundRequest(), stubEnv(), MANAGER)
    );
    const text = await res.text();
    eq(res.status, 503, "safe operational status");
    eq((JSON.parse(text) as { error: string }).error, "document_trust_check_unavailable", "stable error code");
    assert(!text.includes(RAW_DB_ERROR), "raw database error must not reach the response");
    assert(!logs.includes(RAW_DB_ERROR), "raw database error must not reach the logs");

    const docsRequests = stub.of("rest:atlas_documents");
    eq(docsRequests.length, 1, "exactly one documents request (no fallback)");
    eq(docsRequests[0].url.searchParams.get("scan_status"), "eq.clean", "wire request filters scan_status=eq.clean");
    eq(docsRequests[0].url.searchParams.get("status"), "eq.active", "wire request filters status=eq.active");
    eq(stub.requests.filter((r) => r.method !== "GET").length, 0, "no write of any kind (no job, recommendation, status change or audit)");
    for (const table of ["atlas_insurer_appetite", "atlas_jobs", "atlas_recommendations", "atlas_insurers", "atlas_submissions"]) {
      eq(stub.of(`rest:${table}`).length, 0, `${table} untouched`);
    }
    eq(stub.of("anthropic").length, 0, "no AI reasoning call");
    eq(stub.unsupported.length, 0, "stub understood every filter: " + stub.unsupported.join(","));
  } finally {
    stub.restore();
  }
});

test("25. handleRunRecommendation: only active clean documents reach the matcher input that is persisted", async () => {
  const { rows, cleanId } = recommendationDocuments();
  const stub = installFetchStub({ tables: recommendationTables(rows) });
  try {
    const { result: res } = await withCapturedErrors(() =>
      handleRunRecommendation(SUB, backgroundRequest(), stubEnv(), MANAGER)
    );
    const text = await res.text();
    eq(res.status, 200, "recommendation created: " + text);
    sameList(persistedAvailableDocuments(stub), [`type-${cleanId}`], "matcher saw ONLY the active clean document");
    const docsRequests = stub.of("rest:atlas_documents");
    eq(docsRequests.length, 1, "single documents query");
    eq(docsRequests[0].url.searchParams.get("scan_status"), "eq.clean", "wire request filters scan_status=eq.clean");
    eq(stub.unsupported.length, 0, "stub understood every filter: " + stub.unsupported.join(","));
  } finally {
    stub.restore();
  }
});

test("26. handleRunRecommendation: zero clean documents keeps existing behaviour (recommendation runs with an empty set)", async () => {
  const stub = installFetchStub({
    tables: recommendationTables([doc("d-legacy", "not_scanned"), doc("d-failed", "failed"), doc("d-null", null)]),
  });
  try {
    const { result: res } = await withCapturedErrors(() =>
      handleRunRecommendation(SUB, backgroundRequest(), stubEnv(), MANAGER)
    );
    const text = await res.text();
    eq(res.status, 200, "not rejected as a trust-check failure: " + text);
    eq(persistedAvailableDocuments(stub).length, 0, "empty availableDocs");
  } finally {
    stub.restore();
  }
});

// ---------------------------------------------------------------------------
// 27-31. Insurer guideline ingestion (handleProcessInsurerDoc)
// ---------------------------------------------------------------------------

const GDOC = "44444444-4444-4444-4444-444444444444";
const GINS = "55555555-5555-5555-5555-555555555555";

function guidelineTables(scan: { scan_status?: unknown; omit?: true }): Record<string, Row[]> {
  const row: Row = {
    id: GDOC, insurer_id: GINS, file_name: "guide.pdf", storage_path: `${GINS}/guide.pdf`,
    processing_status: "awaiting_processing",
  };
  if (!scan.omit) row.scan_status = scan.scan_status;
  return {
    atlas_insurer_documents: [row],
    atlas_insurers: [{ id: GINS, name: "Acme Insurance" }],
    atlas_jobs: [{ id: JOB, status: "running", cancellation_requested: false }],
  };
}

const processGuideline = () => handleProcessInsurerDoc(GDOC, backgroundRequest(), stubEnv(), MANAGER);

test("27. guideline ingestion: an exact clean document proceeds to download and Anthropic", async () => {
  const stub = installFetchStub({ tables: guidelineTables({ scan_status: "clean" }) });
  try {
    const { result: res } = await withCapturedErrors(processGuideline);
    await res.text();
    assert(![404, 409, 503].includes(res.status), "not blocked by the trust gate: " + res.status);
    eq(stub.of("storage").length, 1, "guideline downloaded");
    assert(decodeURIComponent(stub.of("storage")[0].url.pathname).includes("atlas-insurer-docs"), "from the insurer docs bucket");
    eq(stub.of("anthropic").length, 1, "sent to Anthropic");
  } finally {
    stub.restore();
  }
});

const BLOCKED_GUIDELINE_STATES: { label: string; scan: { scan_status?: unknown; omit?: true }; error: string }[] = [
  { label: "pending", scan: { scan_status: "pending" }, error: "malware_scan_pending" },
  { label: "infected", scan: { scan_status: "infected" }, error: "malware_detected" },
  { label: "failed", scan: { scan_status: "failed" }, error: "document_not_trusted" },
  { label: "not_scanned", scan: { scan_status: "not_scanned" }, error: "document_not_trusted" },
  { label: "null", scan: { scan_status: null }, error: "document_not_trusted" },
  { label: "missing", scan: { omit: true }, error: "document_not_trusted" },
  { label: "empty-string", scan: { scan_status: "" }, error: "document_not_trusted" },
  { label: "unknown", scan: { scan_status: "quarantined_by_future_scanner" }, error: "document_not_trusted" },
  { label: "case-variant", scan: { scan_status: "CLEAN" }, error: "document_not_trusted" },
  { label: "padded", scan: { scan_status: "clean " }, error: "document_not_trusted" },
];

test("28. guideline ingestion: every non-clean scan state is blocked with zero download, zero Anthropic, zero writes", async () => {
  for (const s of BLOCKED_GUIDELINE_STATES) {
    const stub = installFetchStub({ tables: guidelineTables(s.scan) });
    try {
      const { result: res } = await withCapturedErrors(processGuideline);
      const text = await res.text();
      eq(res.status, 409, `[${s.label}] blocked`);
      eq((JSON.parse(text) as { error: string }).error, s.error, `[${s.label}] stable error code`);
      eq(stub.of("storage").length, 0, `[${s.label}] no storage download`);
      eq(stub.of("anthropic").length, 0, `[${s.label}] no Anthropic request`);
      eq(stub.requests.filter((r) => r.method !== "GET").length, 0, `[${s.label}] no write of any kind (no job, appetite or status change)`);
      eq(stub.requests.length, 1, `[${s.label}] only the document lookup was made`);
      eq(stub.requests[0].kind, "rest:atlas_insurer_documents", `[${s.label}] that lookup was the document row`);
    } finally {
      stub.restore();
    }
  }
});

test("29. guideline ingestion: a database error is a 503, never document_not_found, and nothing proceeds", async () => {
  // Seed a CLEAN document: if the code retried the lookup, the trap would hand it back and processing would continue.
  const stub = installFetchStub({ tables: guidelineTables({ scan_status: "clean" }), failTables: ["atlas_insurer_documents"] });
  try {
    const { result: res, logs } = await withCapturedErrors(processGuideline);
    const text = await res.text();
    eq(res.status, 503, "safe operational status");
    eq((JSON.parse(text) as { error: string }).error, "document_trust_check_unavailable", "stable error code");
    assert(!text.includes(RAW_DB_ERROR) && !logs.includes(RAW_DB_ERROR), "raw database error not exposed");
    eq(stub.requests.length, 1, "no retry, no further request of any kind");
    eq(stub.of("storage").length + stub.of("anthropic").length, 0, "no download, no Anthropic");
  } finally {
    stub.restore();
  }
});

test("30. guideline ingestion: genuine absence is still a 404", async () => {
  const stub = installFetchStub({ tables: { atlas_insurer_documents: [] } });
  try {
    const { result: res } = await withCapturedErrors(processGuideline);
    const text = await res.text();
    eq(res.status, 404, "not found");
    eq((JSON.parse(text) as { error: string }).error, "document_not_found", "document_not_found");
    eq(stub.requests.length, 1, "only the lookup");
  } finally {
    stub.restore();
  }
});

test("31. guideline ingestion: source order — the exact-clean gate precedes download and the Anthropic call", () => {
  const code = stripComments(read("insurer-endpoints.ts"));
  const start = code.indexOf("export async function handleProcessInsurerDoc");
  assert(start > 0, "handler found");
  const body = code.slice(start);
  const gate = body.indexOf('doc.scan_status !== "clean"');
  const download = body.indexOf(".download(doc.storage_path)");
  const anthropic = body.indexOf("fetch(ANTHROPIC_URL");
  assert(gate > 0 && download > 0 && anthropic > 0, "gate, download and Anthropic call all present");
  assert(gate < download && gate < anthropic, "gate comes first");
  assert(/\.maybeSingle\(\)/.test(body.slice(0, gate)) && /docError/.test(body.slice(0, gate)), "document lookup distinguishes error from absence");
});

// ---------------------------------------------------------------------------
// 32-33. Reader inventory: a NEW reader of client/guideline documents must be classified
// ---------------------------------------------------------------------------

const WORKER_FILES = () => readdirSync(WORKER_SRC).filter((f) => f.endsWith(".ts"));

/**
 * Files that read atlas_documents. TRUSTED ones feed underwriting
 * intelligence and enforce exact scan_status = 'clean' (guarded above).
 * NON_UNDERWRITING ones only move metadata (upload/registration, scan and
 * retention lifecycle, UI summaries) and never send document content to AI.
 */
const CLIENT_DOC_READERS = {
  trusted: ["extract-endpoint.ts", "quote-review-endpoints.ts", "recommendation-endpoints.ts", "shadow-queue.ts"],
  nonUnderwriting: [
    "cleanup-reference.ts", "index.ts", "phase4-background.ts", "phase7-endpoints.ts",
    "pipeline-endpoints.ts", "submission-endpoints.ts",
  ],
};

test("32. every reader of atlas_documents is classified; non-underwriting readers never call Anthropic", () => {
  const known = new Set([...CLIENT_DOC_READERS.trusted, ...CLIENT_DOC_READERS.nonUnderwriting]);
  for (const file of WORKER_FILES()) {
    const code = stripComments(read(file));
    if (!/\.from\(\s*["']atlas_documents["']\s*\)/.test(code)) continue;
    assert(known.has(file), `${file} reads atlas_documents but is not classified — decide whether it feeds underwriting and, if so, enforce scan_status = 'clean'`);
    if (CLIENT_DOC_READERS.nonUnderwriting.includes(file)) {
      assert(!/api\.anthropic\.com|ANTHROPIC_URL|anthropic-client/.test(code), `${file}: classified non-underwriting but calls Anthropic`);
    }
  }
});

test("33. every Worker file that calls Anthropic is classified; insurer guideline rows are read only behind the gate or for lifecycle", () => {
  const AI_CALLERS = [
    "anthropic-client.ts", "email-endpoints.ts", "extract-endpoint.ts", "hybrid-llm.ts",
    "hybrid-orchestrator.ts", "insurer-endpoints.ts", "recommendation-endpoints.ts", "section-extractor.ts",
  ];
  const actual = WORKER_FILES().filter((f) => /api\.anthropic\.com|anthropic-version|ANTHROPIC_URL|from "\.\/anthropic-client/.test(stripComments(read(f))));
  sameList(actual, AI_CALLERS, "set of files that call Anthropic (a new one must be reviewed for document trust)");

  const guidelineReaders = WORKER_FILES().filter((f) => /\.from\(\s*["']atlas_insurer_documents["']\s*\)/.test(stripComments(read(f))));
  sameList(guidelineReaders, ["cleanup-reference.ts", "insurer-endpoints.ts", "phase4-background.ts"], "readers of atlas_insurer_documents");
});
// ---------------------------------------------------------------------------
// 34-45. Fingerprints include the trusted document evidence set
// ---------------------------------------------------------------------------
//
// buildRecommendationFingerprint / buildQuoteReviewFingerprint key the
// "unchanged_input" cache. Their outputs depend on the trusted (active +
// exact-clean) document evidence, so that evidence must be part of the key —
// otherwise a document turning clean, being added, or expiring would be
// answered with a stale cached result.

const RULES = ["rule-1:2026-01-01T00:00:00Z", "rule-2:2026-01-02T00:00:00Z"];
const DOCS = ["Policy schedule", "Claims history"];

const recFp = (over: Partial<Parameters<typeof buildRecommendationFingerprint>[0]> = {}) =>
  buildRecommendationFingerprint({
    submissionId: SUB, extractionId: EXT, reviewedAt: "2026-01-02T00:00:00Z",
    activeRuleIds: RULES, availableDocuments: DOCS, ...over,
  });

const qrFp = (over: Partial<Parameters<typeof buildQuoteReviewFingerprint>[0]> = {}) =>
  buildQuoteReviewFingerprint({
    submissionId: SUB, extractionId: EXT, recommendationId: "rec-1", insurerId: "insurer-1",
    activeRuleIds: RULES, availableDocuments: DOCS, ...over,
  });

const BUILDERS = [
  { name: "recommendation", fp: recFp },
  { name: "quote review", fp: qrFp },
];

test("34. both fingerprints: the same trusted document set in any order, with duplicates, is the same key", () => {
  for (const b of BUILDERS) {
    const base = b.fp();
    eq(b.fp({ availableDocuments: ["Claims history", "Policy schedule"] }), base, `${b.name}: order is irrelevant`);
    eq(b.fp({ availableDocuments: ["Policy schedule", "Claims history", "Policy schedule"] }), base, `${b.name}: duplicates are irrelevant (set semantics)`);
    // Case is deliberately NOT folded: a spurious miss only recomputes.
    assert(b.fp({ availableDocuments: ["policy schedule", "Claims history"] }) !== base, `${b.name}: exact strings are preserved`);
  }
});

test("35. both fingerprints: changing the trusted document set changes the key (add, remove, replace, empty)", () => {
  for (const b of BUILDERS) {
    const base = b.fp();
    const variants: [string, string[]][] = [
      ["a document added", [...DOCS, "Financial statements"]],
      ["a document removed", ["Policy schedule"]],
      ["a document replaced", ["Policy schedule", "Financial statements"]],
      ["all documents removed", []],
    ];
    const seen = new Set<string>([base]);
    for (const [label, docs] of variants) {
      const fp = b.fp({ availableDocuments: docs });
      assert(fp !== base, `${b.name}: ${label} must change the key`);
      assert(!seen.has(fp), `${b.name}: ${label} must be distinct from the other variants`);
      seen.add(fp);
    }
  }
});

test("36. both fingerprints: every pre-existing input still changes the key (rules, extraction, review time, submission, scope)", () => {
  for (const b of BUILDERS) {
    const base = b.fp();
    eq(b.fp({ activeRuleIds: [...RULES].reverse() }), base, `${b.name}: rule order is irrelevant (unchanged)`);
    assert(b.fp({ activeRuleIds: ["rule-1:2026-01-01T00:00:00Z", "rule-2:2026-02-02T00:00:00Z"] }) !== base, `${b.name}: a rule update changes the key`);
    assert(b.fp({ activeRuleIds: [...RULES, "rule-3:2026-01-03T00:00:00Z"] }) !== base, `${b.name}: a new rule changes the key`);
    assert(b.fp({ activeRuleIds: [RULES[0]] }) !== base, `${b.name}: a removed rule changes the key`);
    assert(b.fp({ extractionId: "another-extraction" }) !== base, `${b.name}: a new extraction changes the key`);
    assert(b.fp({ submissionId: "another-submission" }) !== base, `${b.name}: another submission changes the key`);
  }
  assert(recFp({ reviewedAt: "2026-03-03T00:00:00Z" }) !== recFp(), "recommendation: a re-review changes the key");
  assert(recFp({ reviewedAt: null }) !== recFp(), "recommendation: reviewedAt is part of the key");
  assert(qrFp({ recommendationId: "rec-2" }) !== qrFp(), "quote review: a new recommendation changes the key");
  assert(qrFp({ recommendationId: null }) !== qrFp(), "quote review: recommendationId is part of the key");
  assert(qrFp({ insurerId: "insurer-2" }) !== qrFp(), "quote review: another insurer changes the key");
  assert(recFp() !== qrFp(), "the two job types never share a key");
});

test("37. compatibility: new keys never equal the old document-blind shape, so no pre-change cached result can be returned", () => {
  const oldRec = inputFingerprint({
    type: "recommendation", submission_id: SUB, extraction_id: EXT,
    reviewed_at: "2026-01-02T00:00:00Z", active_rule_ids: [...RULES].sort(),
  });
  const oldQr = inputFingerprint({
    type: "quote_review", submission_id: SUB, extraction_id: EXT, recommendation_id: "rec-1",
    insurer_id: "insurer-1", active_rule_ids: [...RULES].sort(),
  });
  for (const docs of [DOCS, []]) {
    assert(recFp({ availableDocuments: docs }) !== oldRec, `recommendation key differs from the old shape (${docs.length} docs)`);
    assert(qrFp({ availableDocuments: docs }) !== oldQr, `quote review key differs from the old shape (${docs.length} docs)`);
  }
});

test("38. extraction fingerprints are unchanged (golden values) and still ignore document order", () => {
  const docs = [
    { id: "doc-b", storage_path: "sub/doc-b.pdf", created_at: "2026-01-02T00:00:00Z", status: "active", file_hash: "hash-b" },
    { id: "doc-a", storage_path: "sub/doc-a.pdf", created_at: "2026-01-01T00:00:00Z", status: "active", file_hash: null },
  ];
  eq(buildExtractionFingerprint({ submissionId: SUB, brokerEmailPresent: true, documents: docs }), "fp_71a140ab", "v1 extraction fingerprint");
  eq(buildExtractionFingerprintV2({ submissionId: SUB, brokerEmailPresent: true, documents: docs }), "fp_9c8ec7b9", "v2 extraction fingerprint");
  eq(
    buildExtractionFingerprintV2({ submissionId: SUB, brokerEmailPresent: true, documents: [...docs].reverse() }),
    "fp_9c8ec7b9",
    "v2 extraction fingerprint is order independent"
  );
});

const CONSUMER_RULE: AppetiteRow = {
  id: "rule-1", insurer_id: "insurer-1", insurer_name: "Acme Insurance", product_line: "*", risk_type: "*",
  appetite_level: "standard", preferred_risks: [], caution_risks: [], declined_risks: [],
  required_documents: ["Policy schedule"], referral_triggers: [], notes: null, source: "manual",
  source_document_id: null, is_active: true,
};

test("39. the canonicalisation matches the consumers: order/duplicates never change output, a required document does", () => {
  const recommend = (docs: string[]) =>
    JSON.stringify(matchInsurers({
      product_candidates: [], section_candidates: [], risk_candidates: [], features: [],
      available_documents: docs, overall_confidence: 0.9, overall_confidence_available: true,
    }, [CONSUMER_RULE]));
  const quote = (docs: string[]) =>
    JSON.stringify(buildQuoteReview({
      reviewed: { current_cover: { cover_sections: { value: "Fire" } } },
      appetite: [CONSUMER_RULE], availableDocuments: docs,
    }));
  for (const [label, run] of [["matcher", recommend], ["quote review", quote]] as const) {
    const base = run(["Policy schedule", "Claims history"]);
    eq(run(["Claims history", "Policy schedule"]), base, `${label}: order does not change the output`);
    eq(run(["Policy schedule", "Claims history", "Policy schedule"]), base, `${label}: duplicates do not change the output`);
    assert(run(["Claims history"]) !== base, `${label}: removing the required document DOES change the output`);
    assert(run([]) !== base, `${label}: an empty set DOES change the output`);
  }
});

// ---- endpoint level: the real job cache (beginJob) ----

const CACHED_JOB = "99999999-9999-9999-9999-999999999999";
const RULE_STAMP = "rule-1:2026-01-01T00:00:00Z";

function completedJob(jobType: string, fingerprint: string): Row {
  return {
    id: CACHED_JOB, job_type: jobType, input_fingerprint: fingerprint, status: "completed",
    result_reference_id: "cached-result", completed_at: "2026-01-03T00:00:00Z",
  };
}

/** What the handler records for the job it just evaluated (queued, skipped…). */
function jobWrite(stub: ReturnType<typeof installFetchStub>): { status: unknown } | null {
  const w = stub.writes("atlas_jobs").find((r) => r.method === "POST");
  return w ? (w.body as { status: unknown }) : null;
}

function recommendationCacheTables(documents: Row[], cachedFor: { docs: string[]; over?: Partial<Parameters<typeof buildRecommendationFingerprint>[0]> }): Record<string, Row[]> {
  const fp = buildRecommendationFingerprint({
    submissionId: SUB, extractionId: EXT, reviewedAt: "2026-01-02T00:00:00Z",
    activeRuleIds: [RULE_STAMP], availableDocuments: cachedFor.docs, ...cachedFor.over,
  });
  return { ...recommendationTables(documents), atlas_jobs: [completedJob("recommendation", fp)] };
}

async function unforcedRecommendation(tables: Record<string, Row[]>) {
  const stub = installFetchStub({ tables });
  try {
    const { result: res } = await withCapturedErrors(() => handleRunRecommendation(SUB, jsonRequest({}), stubEnv(), MANAGER));
    const body = (await res.json()) as Record<string, unknown>;
    return { res, body, jobStatus: jobWrite(stub)?.status ?? null, stub };
  } finally {
    stub.restore();
  }
}

test("40. recommendation cache: unchanged trusted evidence is still answered from the cache (untrusted/inactive documents are invisible)", async () => {
  const trusted = doc("d-trusted", "clean", { document_type: "Policy schedule" });
  const noise = [
    doc("d-legacy", "not_scanned", { document_type: "Noise A" }),
    doc("d-pending", "pending", { document_type: "Noise B" }),
    doc("d-failed", "failed", { document_type: "Noise C" }),
    doc("d-infected", "infected", { document_type: "Noise D" }),
    doc("d-null", null, { document_type: "Noise E" }),
    doc("d-expired", "clean", { status: "expired", document_type: "Noise F" }),
  ];
  const control = await unforcedRecommendation(recommendationCacheTables([trusted], { docs: ["Policy schedule"] }));
  eq(control.res.status, 200, "control: cached");
  eq(control.body.reason, "unchanged_input", "control: unchanged_input");
  eq(control.body.recommendation_id, "cached-result", "control: cached result returned");

  const withNoise = await unforcedRecommendation(recommendationCacheTables([trusted, ...noise], { docs: ["Policy schedule"] }));
  eq(withNoise.body.reason, "unchanged_input", "untrusted and inactive documents do not defeat the cache");
  eq(withNoise.jobStatus, "skipped", "recorded as a skipped job");
});

test("41. recommendation cache: adding, removing or qualifying a trusted document forces a NEW job, not unchanged_input", async () => {
  const a = doc("d-a", "clean", { document_type: "Policy schedule" });
  const b = doc("d-b", "clean", { document_type: "Claims history" });

  // cached for {A}; now {A, B} (a clean + active document was added)
  const added = await unforcedRecommendation(recommendationCacheTables([a, b], { docs: ["Policy schedule"] }));
  eq(added.res.status, 202, "added: queued, not answered from the cache");
  eq(added.body.queued, true, "added: queued");
  assert(added.body.skipped !== true, "added: not skipped");
  eq(added.jobStatus, "queued", "added: a new job was recorded");

  // cached for {A, B}; now {A} (a previously trusted document was removed / expired)
  const removed = await unforcedRecommendation(recommendationCacheTables([a], { docs: ["Policy schedule", "Claims history"] }));
  eq(removed.body.queued, true, "removed: queued");
  eq(removed.jobStatus, "queued", "removed: a new job was recorded");

  // cached for {A}; B existed but was pending, and has now become clean
  const becameClean = await unforcedRecommendation(recommendationCacheTables([a, b], { docs: ["Policy schedule"] }));
  eq(becameClean.body.queued, true, "pending -> clean: queued");

  // cached for {A, B}; B is now expired (clean but inactive) or infected (no longer qualifies)
  for (const stale of [doc("d-b", "clean", { document_type: "Claims history", status: "expired" }), doc("d-b", "infected", { document_type: "Claims history" })]) {
    const dropped = await unforcedRecommendation(recommendationCacheTables([a, stale], { docs: ["Policy schedule", "Claims history"] }));
    eq(dropped.body.queued, true, `no longer qualifying (${String(stale.scan_status)}/${String(stale.status)}): queued`);
  }
});

test("42. recommendation cache: extraction, review time and rule changes still force a new job (behaviour unchanged)", async () => {
  const a = doc("d-a", "clean", { document_type: "Policy schedule" });
  for (const over of [
    { extractionId: "an-older-extraction" },
    { reviewedAt: "2025-12-31T00:00:00Z" },
    { activeRuleIds: ["rule-1:2025-12-31T00:00:00Z"] },
  ]) {
    const r = await unforcedRecommendation(recommendationCacheTables([a], { docs: ["Policy schedule"], over }));
    eq(r.body.queued, true, `${Object.keys(over)[0]} changed: queued`);
  }
});

async function quoteReviewTables(documents: Row[], cachedEvidence: string[], over: Partial<Parameters<typeof buildQuoteReviewFingerprint>[0]> = {}): Promise<Record<string, Row[]>> {
  const fp = buildQuoteReviewFingerprint({
    submissionId: SUB, extractionId: EXT, recommendationId: null, insurerId: "insurer-1",
    activeRuleIds: [], availableDocuments: cachedEvidence, ...over,
  });
  return {
    atlas_extractions: [{ id: EXT, submission_id: SUB, reviewed_json: { schema_version: "t" }, extraction_confidence: 0.9 }],
    atlas_documents: documents,
    atlas_jobs: [completedJob("quote_review", fp)],
  };
}

/** The exact evidence strings the loader would hand to buildQuoteReview for these rows. */
async function evidenceOf(rows: Row[]): Promise<string[]> {
  const out = await loadAvailableDocuments(makeAdmin({ atlas_documents: rows }).client, SUB);
  assert(out.ok, "loader succeeds");
  return out.availableDocuments;
}

async function unforcedQuoteReview(tables: Record<string, Row[]>) {
  const stub = installFetchStub({ tables });
  try {
    const { result: res } = await withCapturedErrors(() =>
      handleRunQuoteReview(SUB, jsonRequest({ insurer_id: "insurer-1" }), stubEnv(), MANAGER)
    );
    const body = (await res.json()) as Record<string, unknown>;
    return { res, body, jobStatus: jobWrite(stub)?.status ?? null };
  } finally {
    stub.restore();
  }
}

test("43. quote-review cache: unchanged trusted evidence is cached; untrusted/inactive documents are invisible", async () => {
  const trusted = doc("d-trusted", "clean");
  const noise = [
    doc("d-legacy", "not_scanned"), doc("d-pending", "pending"), doc("d-failed", "failed"),
    doc("d-infected", "infected"), doc("d-null", null), doc("d-expired", "clean", { status: "expired" }),
  ];
  const evidence = await evidenceOf([trusted]);
  const control = await unforcedQuoteReview(await quoteReviewTables([trusted], evidence));
  eq(control.res.status, 200, "control: cached");
  eq(control.body.reason, "unchanged_input", "control: unchanged_input");
  eq(control.body.quote_review_id, "cached-result", "control: cached result returned");

  const withNoise = await unforcedQuoteReview(await quoteReviewTables([trusted, ...noise], evidence));
  eq(withNoise.body.reason, "unchanged_input", "untrusted and inactive documents do not defeat the cache");
  eq(withNoise.jobStatus, "skipped", "recorded as a skipped job");
});

test("44. quote-review cache: adding, removing or qualifying a trusted document forces a NEW job, not unchanged_input", async () => {
  const a = doc("d-a", "clean");
  const b = doc("d-b", "clean");
  const evA = await evidenceOf([a]);
  const evAB = await evidenceOf([a, b]);

  const added = await unforcedQuoteReview(await quoteReviewTables([a, b], evA));
  eq(added.res.status, 202, "added: queued, not answered from the cache");
  eq(added.body.queued, true, "added: queued");
  assert(added.body.skipped !== true, "added: not skipped");
  eq(added.jobStatus, "queued", "added: a new job was recorded");

  const removed = await unforcedQuoteReview(await quoteReviewTables([a], evAB));
  eq(removed.body.queued, true, "removed: queued");

  const becameClean = await unforcedQuoteReview(await quoteReviewTables([a, b], evA));
  eq(becameClean.body.queued, true, "pending -> clean: queued");

  for (const stale of [doc("d-b", "clean", { status: "expired" }), doc("d-b", "infected")]) {
    const dropped = await unforcedQuoteReview(await quoteReviewTables([a, stale], evAB));
    eq(dropped.body.queued, true, `no longer qualifying (${String(stale.scan_status)}/${String(stale.status)}): queued`);
  }
});

test("45. quote-review cache: extraction, recommendation, insurer and rule changes still force a new job (behaviour unchanged)", async () => {
  const a = doc("d-a", "clean");
  const ev = await evidenceOf([a]);
  for (const over of [
    { extractionId: "an-older-extraction" },
    { recommendationId: "a-recommendation" },
    { insurerId: "another-insurer" },
    { activeRuleIds: ["rule-9:2026-01-01T00:00:00Z"] },
  ]) {
    const r = await unforcedQuoteReview(await quoteReviewTables([a], ev, over));
    eq(r.body.queued, true, `${Object.keys(over)[0]} changed: queued`);
  }
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
  console.log(`\nPhase 24 clean-only document trust: ${passed} passed, ${failed} failed out of ${tests.length}`);
  if (failed > 0 && typeof process !== "undefined") process.exitCode = 1;
})();
