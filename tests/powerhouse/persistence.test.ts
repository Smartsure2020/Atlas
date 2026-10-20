/**
 * Powerhouse Checkpoint C — persistence contract:
 *   2.5 fingerprint includes matcher / taxonomy / evidence-schema versions
 *   2.6 appetite load is ordered and the persisted result is order-invariant
 *   2.7 reasoning_json.matcher_input no longer stores client free text
 *
 * Everything runs through the real endpoint against an in-memory stub.
 */

import { buildRecommendationFingerprint } from "../../worker/src/phase7-core.js";
import { MATCHER_VERSION, MATCHER_VERSION_V1 } from "../../worker/src/matcher.js";
import {
  MATCHER_INPUT_SNAPSHOT_MINIMISED,
  RECOMMENDATION_EVIDENCE_SCHEMA_VERSION,
} from "../../worker/src/recommendation-evidence.js";
import { TAXONOMY_VERSION } from "../../worker/src/taxonomy.js";
import {
  EXT,
  JOB,
  SUB,
  installRestStub,
  buildTables,
  env,
  MANAGER,
  forcedRequest,
  reviewedField,
  runThroughHandler,
  unforcedRequest,
  type HarnessInput,
  type Row,
} from "./handler-harness.js";
import { handleRunRecommendation } from "../../worker/src/recommendation-endpoints.js";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function eq<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function deepEq(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}:\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`);
  }
}

// Synthetic sentinels, one per class of client data the task names.
const S = {
  name: "NAME_SENTINEL_9QX",
  id: "ID_SENTINEL_8QX",
  phone: "PHONE_SENTINEL_7QX",
  bank: "BANK_SENTINEL_6QX",
  address: "ADDRESS_SENTINEL_5QX",
  policy: "POLICY_SENTINEL_4QX",
  freeText: "FREETEXT_SENTINEL_3QX",
  sector: "SECTOR_SENTINEL_2QX",
};

function reviewedWithSentinels(): Row {
  return {
    schema_version: "test-v1",
    extracted_client: {
      name: reviewedField(S.name),
      occupation_or_business_description: reviewedField(`${S.name} transport fleet ${S.id}`),
      risk_address: reviewedField(`${S.address} ${S.phone}`),
      entity_type: reviewedField(`Company ${S.bank}`),
    },
    current_cover: {
      cover_sections: reviewedField(["Commercial motor"]),
      endorsements: reviewedField([S.policy]),
      exclusions: reviewedField([S.freeText]),
    },
    risk_classification: {
      product_line: reviewedField("commercial motor"),
      risk_type: reviewedField("transport"),
      primary_risk_type: reviewedField("transport fleet"),
      secondary_risk_types: reviewedField([]),
      business_sector: reviewedField("transport"),
      complexity_level: reviewedField("medium"),
    },
    red_flags: [{ issue: `${S.phone} ${S.freeText}` }],
  };
}

function rule(overrides: Row = {}): Row {
  return {
    id: "rule-a", insurer_id: "insurer-a", insurer_name: "A Insurance",
    product_line: "commercial_motor", risk_type: "transport", appetite_level: "preferred",
    preferred_risks: ["transport fleet"], caution_risks: [], declined_risks: [],
    required_documents: ["Claims history"], referral_triggers: [], notes: "Active rule",
    rating_notes: null, line_of_business: "commercial", source: "manual",
    source_document_id: "guide-a", source_file_name: "a-guide.pdf", source_page: 3,
    source_section: "Motor", source_quote: "Transport appetite", ingestion_confidence: 0.95,
    is_active: true, updated_at: "2026-10-15T00:00:00.000Z",
    ...overrides,
  };
}

function input(overrides: Partial<HarnessInput> = {}): HarnessInput {
  return {
    reviewed: reviewedWithSentinels(),
    rules: [
      rule(),
      rule({ id: "rule-b", insurer_id: "insurer-b", insurer_name: "B Insurance", appetite_level: "standard", preferred_risks: [], required_documents: [] }),
    ],
    documents: [{ document_type: "Claims history", status: "active", scan_status: "clean" }],
    insurers: [
      { id: "insurer-a", name: "A Insurance", active: true },
      { id: "insurer-b", name: "B Insurance", active: true },
      { id: "insurer-c", name: "C No Data", active: true },
    ],
    ...overrides,
  };
}

/** Every JSON path at which `needle` occurs inside `value`. */
function pathsContaining(value: unknown, needle: string, path = "$"): string[] {
  if (typeof value === "string") return value.includes(needle) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => pathsContaining(item, needle, `${path}[${index}]`));
  if (value && typeof value === "object") {
    return Object.entries(value as Row).flatMap(([key, child]) => pathsContaining(child, needle, `${path}.${key}`));
  }
  return [];
}

const fpBase = {
  submissionId: SUB, extractionId: EXT, reviewedAt: "2026-10-16T08:00:00.000Z",
  activeRuleIds: ["rule-a:1"], availableDocuments: ["Claims history"],
  matcherVersion: MATCHER_VERSION, taxonomyVersion: TAXONOMY_VERSION,
  evidenceSchemaVersion: RECOMMENDATION_EVIDENCE_SCHEMA_VERSION,
};

// ---------------------------------------------------------------------------
// 2.5 fingerprint versioning
// ---------------------------------------------------------------------------

test("1. fingerprint changes when the matcher version changes", () => {
  assert(buildRecommendationFingerprint(fpBase) !== buildRecommendationFingerprint({ ...fpBase, matcherVersion: MATCHER_VERSION_V1 }), "matcher version is part of the key");
});

test("2. fingerprint changes when the taxonomy version changes", () => {
  assert(buildRecommendationFingerprint(fpBase) !== buildRecommendationFingerprint({ ...fpBase, taxonomyVersion: "2099-taxonomy" }), "taxonomy version is part of the key");
});

test("3. fingerprint changes when the evidence schema version changes", () => {
  assert(buildRecommendationFingerprint(fpBase) !== buildRecommendationFingerprint({ ...fpBase, evidenceSchemaVersion: "recommendation-evidence-v9" }), "evidence schema is part of the key");
});

test("4. identical inputs and versions still give an identical fingerprint (and document order is irrelevant)", () => {
  eq(buildRecommendationFingerprint(fpBase), buildRecommendationFingerprint({ ...fpBase }), "stable");
  eq(
    buildRecommendationFingerprint({ ...fpBase, availableDocuments: ["B", "A", "A"] }),
    buildRecommendationFingerprint({ ...fpBase, availableDocuments: ["A", "B"] }),
    "document set semantics retained"
  );
});

test("5. every version component is required by the type system (compile-time guard)", () => {
  // @ts-expect-error matcherVersion is required
  void (() => buildRecommendationFingerprint({ ...fpBase, matcherVersion: undefined }));
  // @ts-expect-error taxonomyVersion is required
  void (() => buildRecommendationFingerprint({ ...fpBase, taxonomyVersion: undefined }));
  // @ts-expect-error evidenceSchemaVersion is required
  void (() => buildRecommendationFingerprint({ ...fpBase, evidenceSchemaVersion: undefined }));
});

async function unforcedRunWithCompletedJob(fingerprint: string): Promise<Row> {
  // A previously completed recommendation job keyed by `fingerprint`.
  const stub = installRestStub(buildTables(input({
    extraTables: {
      atlas_jobs: [{
        id: "job-previous", status: "completed", job_type: "recommendation", submission_id: SUB,
        input_fingerprint: fingerprint, result_reference_id: "rec-previous",
        completed_at: "2026-10-16T09:00:00.000Z",
      }],
    },
  })));
  try {
    const res = await handleRunRecommendation(SUB, unforcedRequest(), env(), MANAGER);
    return (await res.json()) as Row;
  } finally {
    stub.restore();
  }
}

function liveFingerprint(overrides: Partial<typeof fpBase> = {}): string {
  const tables = buildTables(input());
  const activeRuleIds = tables.atlas_insurer_appetite.map((r) => `${r.id}:${r.updated_at ?? ""}`);
  return buildRecommendationFingerprint({ ...fpBase, activeRuleIds, ...overrides });
}

test("6. a job completed under the SAME versions is answered from cache (unchanged_input)", async () => {
  const body = await unforcedRunWithCompletedJob(liveFingerprint());
  eq(body.skipped, true, "cache hit when nothing changed");
  eq(body.reason, "unchanged_input", "reason");
});

test("7. a job completed under the PREVIOUS matcher version is NOT served from cache", async () => {
  const body = await unforcedRunWithCompletedJob(liveFingerprint({ matcherVersion: MATCHER_VERSION_V1 }));
  assert(body.skipped !== true, "stale matcher-version result must be recomputed");
});

test("8. a job completed under a different taxonomy version is NOT served from cache", async () => {
  const body = await unforcedRunWithCompletedJob(liveFingerprint({ taxonomyVersion: "2026-07-token-aliases-v0" }));
  assert(body.skipped !== true, "stale taxonomy-version result must be recomputed");
});

test("9. a job completed under a different evidence schema is NOT served from cache", async () => {
  const body = await unforcedRunWithCompletedJob(liveFingerprint({ evidenceSchemaVersion: "recommendation-evidence-v1-old" }));
  assert(body.skipped !== true, "stale evidence-schema result must be recomputed");
});

// ---------------------------------------------------------------------------
// 2.6 deterministic ordering through the endpoint
// ---------------------------------------------------------------------------

test("10. the appetite load specifies a deterministic ORDER BY", async () => {
  const run = await runThroughHandler(input());
  const load = run.requests.find((item) => item.table === "atlas_insurer_appetite" && item.method === "GET");
  assert(load, "appetite GET recorded");
  eq(load.url.searchParams.get("order"), "insurer_id.asc,id.asc", "ordered by insurer_id then id");
});

function normalise(row: Row): string {
  const clone = JSON.parse(JSON.stringify(row)) as Row;
  delete clone.id;
  delete clone.created_at;
  const evidence = clone.evidence_json as Row | null;
  if (evidence) {
    const provenance = evidence.provenance as Row;
    delete provenance.recommendation_id;
    delete provenance.generated_at;
  }
  return JSON.stringify(clone);
}

test("11. the persisted recommendation is identical for reversed and shuffled appetite rows", async () => {
  const rules = [
    rule({ id: "rule-a1", product_line: "goods_in_transit", risk_type: "transport", appetite_level: "declined" }),
    rule({ id: "rule-a2" }),
    rule({ id: "rule-b1", insurer_id: "insurer-b", insurer_name: "B Insurance", appetite_level: "preferred" }),
    rule({ id: "rule-b2", insurer_id: "insurer-b", insurer_name: "B Insurance", product_line: "commercial_motor", appetite_level: "standard" }),
    rule({ id: "rule-p", insurer_id: "insurer-b", insurer_name: "B Insurance", product_line: "*", risk_type: "*", caution_risks: ["medium"] }),
  ];
  const reviewed = reviewedWithSentinels();
  (reviewed.current_cover as Row).cover_sections = reviewedField(["Commercial motor", "Goods in transit"]);
  const variants = [rules, [...rules].reverse(), [rules[3], rules[0], rules[4], rules[2], rules[1]]];
  const rows: string[] = [];
  for (const variant of variants) {
    const run = await runThroughHandler(input({ reviewed, rules: variant }));
    assert(run.row, "row persisted");
    rows.push(normalise(run.row));
  }
  eq(rows[1], rows[0], "reversed rows");
  eq(rows[2], rows[0], "shuffled rows");
});

// ---------------------------------------------------------------------------
// 2.7 privacy of reasoning_json.matcher_input
// ---------------------------------------------------------------------------

test("12. new reasoning_json.matcher_input carries no client free text and declares its shape", async () => {
  const run = await runThroughHandler(input());
  assert(run.row, "row persisted");
  const snapshot = (run.row.reasoning_json as Row).matcher_input as Row;
  eq(snapshot.snapshot_version, MATCHER_INPUT_SNAPSHOT_MINIMISED, "shape marker");
  const features = snapshot.features as Row[];
  assert(features.length > 0, "features are still described");
  for (const feature of features) {
    deepEq(Object.keys(feature).sort(), ["ai_inferred", "source", "value_retained"], "feature keys: label only");
    eq(feature.value_retained, false, "value not retained");
    assert(!("text" in feature), "no text property");
  }
  deepEq(snapshot.available_documents, ["Claims history"], "readers of available_documents are unaffected");
  assert(Array.isArray(snapshot.product_candidates) && Array.isArray(snapshot.risk_candidates), "taxonomy candidates retained");
  eq(typeof snapshot.overall_confidence, "number", "confidence retained");
});

test("13. PRIVACY SWEEP: no sentinel (name, ID, phone, bank, address, policy, free text) appears in ANY persisted column", async () => {
  const run = await runThroughHandler(input());
  assert(run.row, "row persisted");
  for (const [label, sentinel] of Object.entries(S)) {
    if (label === "sector") continue;
    const found = pathsContaining(run.row, sentinel);
    deepEq(found, [], `${label} sentinel found in persisted row`);
  }
  // …and none of them reaches the audit log or the job metadata either.
  for (const table of ["atlas_audit_logs", "atlas_jobs", "atlas_submissions"]) {
    for (const write of run.writes(table)) {
      for (const sentinel of Object.values(S)) assert(!JSON.stringify(write.body).includes(sentinel), `${table} write leaks ${sentinel}`);
    }
  }
});

test("14. DOCUMENTED RESIDUAL: classification text becomes a taxonomy candidate — exactly these locations, no others", async () => {
  const reviewed = reviewedWithSentinels();
  (reviewed.risk_classification as Row).business_sector = reviewedField(S.sector);
  const run = await runThroughHandler(input({ reviewed }));
  assert(run.row, "row persisted");
  const found = pathsContaining(run.row, S.sector).map((path) => path.replace(/\[\d+\]/g, "[]")).sort();
  deepEq(
    [...new Set(found)],
    [
      "$.evidence_json.matcher_input.risk_candidates[]",
      "$.reasoning_json.matcher_input.risk_candidates[]",
    ],
    "business_sector is a risk candidate; it is retained as one and nowhere else"
  );
});

test("15. legacy compatibility columns keep their historical shape (no section intelligence duplicated into them)", async () => {
  const reviewed = reviewedWithSentinels();
  (reviewed.current_cover as Row).cover_sections = reviewedField(["Commercial motor", "Goods in transit"]);
  const run = await runThroughHandler(input({ reviewed }));
  assert(run.row, "row persisted");
  const legacy = [
    (run.row.reasoning_json as Row).top as Row,
    ...(run.row.secondary_options_json as Row[]),
    ...(run.row.not_recommended_json as Row[]),
  ];
  assert(legacy.length > 0, "insurers persisted");
  for (const insurer of legacy) {
    for (const key of ["selection", "section_evaluations", "considered_rules"]) {
      assert(!(key in insurer), `legacy insurer must not carry ${key}`);
    }
    assert("matched_rules" in insurer && "scoring_notes" in insurer, "historical fields still present");
  }
});

test("16. historical raw matcher_input rows are not touched by this change (shape is read, never rewritten)", async () => {
  const historical: Row = { id: "old", submission_id: SUB, reasoning_json: { matcher_input: { features: [{ text: "RAW", source: "x" }] } }, evidence_json: null };
  const copy = JSON.stringify(historical);
  const stub = installRestStub({ atlas_recommendations: [historical] }, { projectSelect: true });
  try {
    const { handleGetRecommendation } = await import("../../worker/src/recommendation-endpoints.js");
    const res = await handleGetRecommendation(SUB, env(), MANAGER);
    const body = (await res.json()) as { recommendation: Row };
    eq(JSON.stringify((body.recommendation.reasoning_json as Row)), JSON.stringify(historical.reasoning_json), "returned verbatim");
    eq(stub.writes("atlas_recommendations").length, 0, "GET writes nothing");
  } finally {
    stub.restore();
  }
  eq(JSON.stringify(historical), copy, "input object untouched");
});

void JOB;
void forcedRequest;

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
console.log(`\nPowerhouse persistence contract: ${tests.length - failures} passed, ${failures} failed out of ${tests.length}`);
if (failures > 0) process.exitCode = 1;
