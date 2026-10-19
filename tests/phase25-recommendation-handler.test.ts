/** Phase 1A remediation — handler wiring and fail-closed persistence tests. */

import type { AtlasUser } from "../worker/src/auth.js";
import type { Env } from "../worker/src/config.js";
import {
  handleGetRecommendation,
  handleRunRecommendation,
} from "../worker/src/recommendation-endpoints.js";

const runtimeGlobals = globalThis as { WebSocket?: unknown };
if (typeof runtimeGlobals.WebSocket === "undefined") runtimeGlobals.WebSocket = class UnusedWebSocket {};

type Row = Record<string, unknown>;
interface Recorded { method: string; table: string; body: unknown; url: URL }

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function eq<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function deepEq(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const SUB = "11111111-1111-1111-1111-111111111111";
const EXT = "22222222-2222-2222-2222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const MANAGER = { id: "user-1", email: "manager@example.test", role: "manager" } as AtlasUser;
const SENTINELS = [
  "PERSON_SENTINEL_9QX", "ID_SENTINEL_8QX", "PHONE_SENTINEL_7QX",
  "BANK_SENTINEL_6QX", "ADDRESS_SENTINEL_5QX", "POLICY_SENTINEL_4QX",
];

function env(): Env {
  return {
    SUPABASE_URL: "http://stub.supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
    ANTHROPIC_API_KEY: "anthropic-test-key",
  } as unknown as Env;
}

function field(value: unknown) {
  return { value, status: "extracted", confidence: 0.9, confidence_source: "provider" };
}

function reviewed(): Row {
  return {
    schema_version: "test-v1",
    extracted_client: {
      occupation_or_business_description: field(`${SENTINELS[0]} ${SENTINELS[1]} ${SENTINELS[2]} transport fleet`),
      risk_address: field(`${SENTINELS[3]} ${SENTINELS[4]}`),
      entity_type: field("Company"),
    },
    current_cover: {
      cover_sections: field(["Commercial motor"]),
      endorsements: field([SENTINELS[5]]),
      exclusions: field([]),
    },
    risk_classification: {
      product_line: field("commercial motor"),
      risk_type: field("transport"),
      primary_risk_type: field("transport fleet"),
      secondary_risk_types: field([]),
      business_sector: field("transport"),
      complexity_level: field("medium"),
    },
    red_flags: [{ issue: SENTINELS.join(" ") }],
  };
}

function rule(overrides: Row): Row {
  return {
    id: "rule-a", insurer_id: "insurer-a", insurer_name: "A Insurance",
    product_line: "commercial_motor", risk_type: "transport", appetite_level: "preferred",
    preferred_risks: ["transport fleet"], caution_risks: [], declined_risks: [],
    required_documents: ["Claims history"], referral_triggers: [], notes: "Active rule",
    rating_notes: null, line_of_business: "motor", source: "manual",
    source_document_id: "guide-a", source_file_name: "a-guide.pdf", source_page: 3,
    source_section: "Motor", source_quote: "Transport appetite", ingestion_confidence: 0.95,
    is_active: true, updated_at: "2026-10-15T00:00:00.000Z",
    ...overrides,
  };
}

function tables(): Record<string, Row[]> {
  return {
    atlas_extractions: [{
      id: EXT, submission_id: SUB, extracted_json: {}, reviewed_json: reviewed(),
      reviewed_at: "2026-10-16T08:00:00.000Z", extraction_confidence: 0.9,
    }],
    atlas_documents: [{ submission_id: SUB, document_type: "Claims history", status: "active", scan_status: "clean" }],
    atlas_insurer_appetite: [
      rule({}),
      rule({
        id: "rule-b", insurer_id: "insurer-b", insurer_name: "B Insurance",
        appetite_level: "standard", preferred_risks: [], required_documents: [],
        source_document_id: "guide-b", source_file_name: "b-guide.pdf", source_page: 9,
      }),
    ],
    atlas_insurers: [
      { id: "insurer-a", name: "A Insurance", active: true },
      { id: "insurer-b", name: "B Insurance", active: true },
      { id: "insurer-c", name: "C No Data", active: true },
    ],
    atlas_jobs: [{
      id: JOB, status: "running", cancellation_requested: false, retry_count: 0,
      max_retries: 2, job_type: "recommendation", submission_id: SUB,
    }],
  };
}

function installRestStub(seed: Record<string, Row[]>, options: { projectSelect?: boolean } = {}) {
  const original = globalThis.fetch;
  const requests: Recorded[] = [];
  const parse = (body: BodyInit | null | undefined): unknown => {
    if (typeof body !== "string") return undefined;
    try { return JSON.parse(body); } catch { return body; }
  };
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const match = url.pathname.match(/^\/rest\/v1\/([a-z_0-9]+)$/);
    if (!match) return response({ message: "unexpected request" }, 500);
    const table = match[1];
    const method = (init?.method ?? "GET").toUpperCase();
    const body = parse(init?.body);
    requests.push({ method, table, body, url });
    const headers = new Headers(init?.headers);
    const wantsObject = (headers.get("accept") ?? "").includes("vnd.pgrst.object+json");
    const wantsRepresentation = (headers.get("prefer") ?? "").includes("return=representation");

    if (method === "GET") {
      let rows = [...(seed[table] ?? [])];
      url.searchParams.forEach((raw, key) => {
        if (["select", "order", "limit", "offset"].includes(key)) return;
        if (raw.startsWith("eq.")) {
          const expected = raw.slice(3);
          rows = rows.filter((row) => String(row[key]) === expected);
        } else if (raw.startsWith("in.(") && raw.endsWith(")")) {
          const expected = raw.slice(4, -1).split(",").map((item) => item.replace(/^\"|\"$/g, ""));
          rows = rows.filter((row) => expected.includes(String(row[key])));
        }
      });
      const select = url.searchParams.get("select");
      if (options.projectSelect && select) {
        const fields = select.split(",").map((item) => item.trim()).filter(Boolean);
        rows = rows.map((row) => Object.fromEntries(fields.map((fieldSpec) => {
          const separator = fieldSpec.indexOf(":");
          const output = separator >= 0 ? fieldSpec.slice(0, separator) : fieldSpec;
          const source = separator >= 0 ? fieldSpec.slice(separator + 1) : fieldSpec;
          return [output, row[source]];
        })));
      }
      if (wantsObject) {
        return rows.length === 1 ? response(rows[0]) : response({ code: "PGRST116", message: "0 rows" }, 406);
      }
      return response(rows);
    }

    if (wantsRepresentation) {
      const inserted = Array.isArray(body) ? body[0] : body;
      const row = { id: `stub-${table}`, ...(inserted as Row) };
      return wantsObject ? response(row, 201) : response([row], 201);
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return {
    requests,
    restore: () => { globalThis.fetch = original; },
    writes: (table: string) => requests.filter((item) => item.table === table && item.method !== "GET"),
  };
}

function request() {
  return new Request("https://atlas.test/api/recommend", {
    method: "POST",
    body: JSON.stringify({ force: true, background_job_id: JOB }),
  });
}

test("1. handler persists and returns an identity-linked, privacy-safe evidence packet", async () => {
  const stub = installRestStub(tables());
  try {
    const res = await handleRunRecommendation(SUB, request(), env(), MANAGER);
    const payload = await res.json() as { recommendation_id?: string; error?: string };
    eq(res.status, 200, `handler response ${payload.error ?? "ok"}`);
    const recWrites = stub.writes("atlas_recommendations");
    eq(recWrites.length, 1, "one recommendation insert");
    const row = recWrites[0].body as Row;
    const evidence = row.evidence_json as Row;
    const provenance = evidence.provenance as Row;
    eq(row.id, provenance.recommendation_id, "row and evidence identity");
    eq(payload.recommendation_id, row.id as string, "response and row identity");

    const jobCompletion = stub.writes("atlas_jobs")
      .map((item) => item.body as Row)
      .find((body) => body.status === "completed");
    assert(jobCompletion, "job completion write exists");
    eq((jobCompletion.metadata as Row).input_fingerprint, provenance.recommendation_input_fingerprint, "same input fingerprint");

    const scored = (evidence.insurers as Row[]).filter((item) => item.status === "scored");
    const reasoning = row.reasoning_json as Row;
    const top = reasoning.top as Row;
    const persistedOrderRows = [top, ...(row.secondary_options_json as Row[]), ...(row.not_recommended_json as Row[])];
    deepEq(scored.map((item) => item.insurer_id), persistedOrderRows.map((item) => item.insurer_id), "authoritative matcher order is retained");
    deepEq(scored.map((item) => item.rank), [1, 2], "first and later matcher ranks are exact");
    deepEq(scored.map((item) => item.rank), persistedOrderRows.map((item) => item.rank), "evidence copies matcher-authored ranks");
    const firstRule = ((scored[0].rule_evidence as Row[])[0]);
    eq(firstRule.source_document_id, "guide-a", "active rule provenance persisted");
    eq(firstRule.source_page, 3, "active rule locator persisted");

    const noData = (evidence.insurers as Row[]).find((item) => item.status === "no_appetite_data");
    assert(noData, "no-data insurer is explicit");
    eq(noData.rank, null, "no-data insurer has no rank");
    eq(noData.score, null, "no fabricated score");
    for (const absent of ["manual_review_required", "senior_review_required", "matcher_notes", "confidence"]) {
      assert(!(absent in noData), `no-data omits ${absent}`);
    }

    const serialised = JSON.stringify(evidence);
    for (const sentinel of SENTINELS) assert(!serialised.includes(sentinel), `evidence redacts ${sentinel}`);
    for (const forbidden of ["storage_path", "signed_url", "service-role-test-key", "anthropic-test-key"]) {
      assert(!serialised.includes(forbidden), `evidence excludes ${forbidden}`);
    }

    const getStub = installRestStub({ atlas_recommendations: [row] }, { projectSelect: true });
    try {
      const get = await handleGetRecommendation(SUB, env(), MANAGER);
      eq(get.status, 200, "GET succeeds");
      const getBody = await get.json() as { recommendation: Row };
      const getRequest = getStub.requests.find((item) => item.method === "GET" && item.table === "atlas_recommendations");
      assert(getRequest, "recommendation GET request recorded");
      assert((getRequest.url.searchParams.get("select") ?? "").split(",").includes("evidence_json"), "GET explicitly selects evidence_json");
      deepEq(getBody.recommendation.evidence_json, evidence, "GET returns persisted evidence unchanged");
    } finally {
      getStub.restore();
    }
  } finally {
    stub.restore();
  }
});

test("2. GET explicitly selects and preserves a historical null evidence packet", async () => {
  const historical = {
    id: "historical-recommendation", submission_id: SUB, status: "completed",
    reasoning_json: {}, secondary_options_json: [], not_recommended_json: [],
    evidence_json: null,
  };
  const stub = installRestStub({ atlas_recommendations: [historical] }, { projectSelect: true });
  try {
    const get = await handleGetRecommendation(SUB, env(), MANAGER);
    eq(get.status, 200, "historical GET succeeds");
    const body = await get.json() as { recommendation: Row };
    const getRequest = stub.requests.find((item) => item.method === "GET" && item.table === "atlas_recommendations");
    assert(getRequest, "historical recommendation GET recorded");
    assert((getRequest.url.searchParams.get("select") ?? "").split(",").includes("evidence_json"), "historical GET explicitly selects evidence_json");
    eq(body.recommendation.evidence_json, null, "historical null remains valid");
  } finally {
    stub.restore();
  }
});

test("3. evidence-builder failure fails the job and performs no recommendation, audit, or completion write", async () => {
  const stub = installRestStub(tables());
  try {
    const res = await handleRunRecommendation(SUB, request(), env(), MANAGER, {
      buildEvidence: () => { throw new Error("injected sensitive builder detail"); },
    });
    const text = await res.text();
    eq(res.status, 500, "safe failure status");
    eq((JSON.parse(text) as { error: string }).error, "recommendation_evidence_failed", "stable safe code");
    assert(!text.includes("injected sensitive"), "internal detail not returned");
    eq(stub.writes("atlas_recommendations").length, 0, "no recommendation insert");
    eq(stub.writes("atlas_audit_logs").length, 0, "no success audit");
    const jobBodies = stub.writes("atlas_jobs").map((item) => item.body as Row);
    assert(jobBodies.some((body) => body.status === "failed" && body.error_code === "recommendation_evidence_failed"), "job failed safely");
    assert(!jobBodies.some((body) => body.status === "completed"), "job never completed");
  } finally {
    stub.restore();
  }
});

let failures = 0;
for (const item of tests) {
  try {
    await item.fn();
    console.log(`ok - ${item.name}`);
  } catch (error) {
    failures++;
    console.error(`not ok - ${item.name}`);
    console.error((error as Error).message);
  }
}
console.log(`\nPhase 1A recommendation handler: ${tests.length - failures} passed, ${failures} failed out of ${tests.length}`);
if (failures > 0) process.exitCode = 1;
