import { handleTrackDetectedMissingInfo } from "../../worker/src/phase4-endpoints.js";
import { detectedMissingInfoId } from "../../worker/src/detected-missing-info.js";
import { env, installRestStub, MANAGER, SUB, type Row } from "./handler-harness.js";
import type { AtlasUser } from "../../worker/src/auth.js";

const REC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "99999999-9999-4999-8999-999999999999";
const BROKER = { id: "broker-1", email: "broker@example.test", role: "broker" } as AtlasUser;

interface Test { name: string; fn: () => void | Promise<void> }
const tests: Test[] = [];
const test = (name: string, fn: Test["fn"]) => tests.push({ name, fn });
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function eq(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function evidence(items: Row[], schema = "recommendation-evidence-v3"): Row {
  return { schema_version: schema, completeness: { items } };
}

function doc(id = "cmp:required_document_missing:-:-:risk survey"): Row {
  return {
    item_id: id,
    code: "required_document_missing",
    scope: "document",
    status: "missing",
    source: "required_document_outcome",
    trust_basis: "active_exact_clean",
    document_type: "Risk survey",
    document_key: "risk survey",
  };
}

function fact(id = "cmp:extraction_reported_information_missing:-:-:field:extracted_client.registration_or_id_number"): Row {
  return {
    item_id: id,
    code: "extraction_reported_information_missing",
    scope: "fact",
    status: "missing",
    source: "reviewed_extraction",
    field_path: "extracted_client.registration_or_id_number",
  };
}

function request(body: unknown) {
  return new Request(`https://atlas.test/api/submissions/${SUB}/missing-info/detected`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function call(items: Row[], body: unknown, options: { schema?: string; user?: AtlasUser; recommendationSubmission?: string } = {}) {
  const seed: Record<string, Row[]> = {
    atlas_recommendations: [{
      id: REC,
      submission_id: options.recommendationSubmission ?? SUB,
      created_at: "2026-10-26T08:00:00.000Z",
      evidence_json: evidence(items, options.schema),
    }],
    atlas_missing_info_items: [],
  };
  const stub = installRestStub(seed);
  try {
    const res = await handleTrackDetectedMissingInfo(SUB, request(body), env(), options.user ?? MANAGER);
    return { res, body: await res.json() as Row, stub, seed };
  } catch (error) {
    stub.restore();
    throw error;
  }
}

test("1. broker is rejected before evidence is read", async () => {
  const run = await call([doc()], { detected_item_id: doc().item_id }, { user: BROKER });
  try {
    eq(run.res.status, 403, "broker status");
    eq(run.stub.requests.length, 0, "no database read");
  } finally { run.stub.restore(); }
});

test("2. the server derives broker-safe content and ignores no client-authored content because extras are rejected", async () => {
  const item = fact();
  const bad = await call([item], { detected_item_id: item.item_id, title: "internal contradiction text" });
  try { eq(bad.res.status, 400, "extra keys rejected"); } finally { bad.stub.restore(); }

  const run = await call([{ ...item, label: "UNTRUSTED MODEL TEXT" }], { detected_item_id: item.item_id });
  try {
    eq(run.res.status, 201, "created");
    const writes = run.stub.writes("atlas_missing_info_items");
    eq(writes.length, 1, "one row");
    const row = writes[0].body as Row;
    eq(row.title, "Registration or ID number", "schema-derived title");
    eq(row.description, "Reported as outstanding when the submission was read.", "fixed description");
    eq(row.item_type, "underwriting_info", "fixed type");
    eq(row.owner, "broker", "fixed owner");
    eq(row.source, "extraction", "safe source");
    assert(!JSON.stringify(row).includes("UNTRUSTED") && !JSON.stringify(row).includes("contradiction"), "no unrestricted/internal text persisted");
  } finally { run.stub.restore(); }
});

test("3. repeated tracking is idempotent for the same current recommendation", async () => {
  const item = doc();
  const seed: Record<string, Row[]> = {
    atlas_recommendations: [{ id: REC, submission_id: SUB, created_at: "2026-10-26T08:00:00Z", evidence_json: evidence([item]) }],
    atlas_missing_info_items: [],
  };
  const stub = installRestStub(seed);
  try {
    const first = await handleTrackDetectedMissingInfo(SUB, request({ detected_item_id: item.item_id }), env(), MANAGER);
    const firstBody = await first.json() as Row;
    const second = await handleTrackDetectedMissingInfo(SUB, request({ detected_item_id: item.item_id }), env(), MANAGER);
    const secondBody = await second.json() as Row;
    eq(first.status, 201, "first created");
    eq(second.status, 200, "second existing");
    eq(firstBody.id, secondBody.id, "same id");
    eq(secondBody.duplicate, true, "duplicate flagged");
    eq(stub.writes("atlas_missing_info_items").length, 1, "only one insert");
    eq(firstBody.id, detectedMissingInfoId(SUB, REC, String(item.item_id)), "deterministic primary key");
  } finally { stub.restore(); }
});

for (const [name, item] of [
  ["contradiction id", { item_id: "ctr:risk.product:x", code: "conflicting_recorded_values", scope: "submission", status: "missing" }],
  ["internal provenance limitation", { item_id: "cmp:requested_section_not_evaluated:x", code: "requested_section_not_evaluated", scope: "section", status: "missing" }],
  ["insurer quality limitation", { item_id: "cmp:insurer_appetite_data_missing:x", code: "insurer_appetite_data_missing", scope: "insurer", status: "missing" }],
  ["rule-selection tie", { item_id: "cmp:section_rule_ambiguous:x", code: "section_rule_ambiguous", scope: "section", status: "missing" }],
] as const) {
  test(`4. ${name} is not trackable`, async () => {
    const run = await call([item as Row], { detected_item_id: item.item_id });
    try { eq(run.res.status, 422, "rejected"); eq(run.stub.writes("atlas_missing_info_items").length, 0, "no write"); } finally { run.stub.restore(); }
  });
}

test("5. unknown id and an item from another submission are rejected", async () => {
  const unknown = await call([doc()], { detected_item_id: "cmp:unknown" });
  try { eq(unknown.res.status, 422, "unknown"); } finally { unknown.stub.restore(); }
  const other = await call([doc()], { detected_item_id: doc().item_id }, { recommendationSubmission: OTHER });
  try { eq(other.res.status, 400, "other submission has no current recommendation"); eq(other.stub.writes("atlas_missing_info_items").length, 0, "no write"); } finally { other.stub.restore(); }
});

test("6. historical v1/v2 and malformed v3 items are rejected", async () => {
  for (const schema of ["recommendation-evidence-v1", "recommendation-evidence-v2"]) {
    const run = await call([doc()], { detected_item_id: doc().item_id }, { schema });
    try { eq(run.res.status, 409, `${schema} rejected`); } finally { run.stub.restore(); }
  }
  const malformed = await call([{ ...doc(), source: "internal_diagnostic" }], { detected_item_id: doc().item_id });
  try { eq(malformed.res.status, 422, "malformed v3 rejected"); eq(malformed.stub.writes("atlas_missing_info_items").length, 0, "no write"); } finally { malformed.stub.restore(); }
});

let failures = 0;
for (const item of tests) {
  try { await item.fn(); console.log(`ok - ${item.name}`); }
  catch (error) { failures++; console.error(`not ok - ${item.name}`); console.error((error as Error).message); }
}
console.log(`\nDetected missing-info endpoint: ${tests.length - failures} passed, ${failures} failed out of ${tests.length}`);
if (failures) process.exitCode = 1;
