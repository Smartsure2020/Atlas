import { handleGenerateMissingInfo, handleTrackDetectedMissingInfo } from "../../worker/src/phase4-endpoints.js";
import { env, installRestStub, MANAGER, SUB, type Row } from "./handler-harness.js";

const REC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REC2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REVIEW = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "99999999-9999-4999-8999-999999999999";

interface Test { name: string; fn: () => void | Promise<void> }
const tests: Test[] = [];
const test = (name: string, fn: Test["fn"]) => tests.push({ name, fn });
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function eq(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function doc(id = "cmp:required_document_missing:-:-:risk survey", title = "Risk Survey"): Row {
  return {
    item_id: id,
    code: "required_document_missing",
    scope: "document",
    status: "missing",
    source: "required_document_outcome",
    trust_basis: "active_exact_clean",
    document_type: title,
    document_key: title.toLowerCase().replace(/[_/-]+/g, " ").replace(/\s+/g, " ").trim(),
  };
}

function fact(path = "extracted_client.registration_or_id_number"): Row {
  return {
    item_id: `cmp:extraction_reported_information_missing:-:-:field:${path}`,
    code: "extraction_reported_information_missing",
    scope: "fact",
    status: "missing",
    source: "reviewed_extraction",
    field_path: path,
  };
}

function recommendation(id: string, createdAt: string, items: Row[], submissionId = SUB): Row {
  return { id, submission_id: submissionId, created_at: createdAt, evidence_json: { schema_version: "recommendation-evidence-v3", completeness: { items } } };
}

function review(fields: { field: string; reason_required?: string }[] = []): Row {
  return {
    id: REVIEW,
    submission_id: SUB,
    created_at: "2026-10-26T07:00:00.000Z",
    review_snapshot: { reviewed_json: { missing_information: fields } },
  };
}

function section(documents: string[]): Row {
  return {
    id: "section-1",
    quote_review_id: REVIEW,
    section_key: "commercial_motor",
    section_name: "Commercial motor",
    matched_rule_id: null,
    missing_documents: documents,
    findings: [],
    rating_findings: [],
    excess_findings: [],
    warranty_findings: [],
  };
}

function seedFor(item: Row, options: { fields?: { field: string; reason_required?: string }[]; documents?: string[] } = {}): Record<string, Row[]> {
  return {
    atlas_recommendations: [recommendation(REC, "2026-10-26T08:00:00.000Z", [item])],
    atlas_quote_reviews: [review(options.fields)],
    atlas_quote_review_sections: options.documents ? [section(options.documents)] : [],
    atlas_missing_info_items: [],
  };
}

function trackRequest(itemId: unknown) {
  return new Request(`https://atlas.test/api/submissions/${SUB}/missing-info/detected`, {
    method: "POST",
    body: JSON.stringify({ detected_item_id: itemId }),
  });
}

async function derive(seed: Record<string, Row[]>) {
  const res = await handleGenerateMissingInfo(SUB, env(), MANAGER);
  return { res, body: await res.json() as Row, rows: seed.atlas_missing_info_items };
}

async function track(seed: Record<string, Row[]>, item: Row) {
  const res = await handleTrackDetectedMissingInfo(SUB, trackRequest(item.item_id), env(), MANAGER);
  return { res, body: await res.json() as Row, rows: seed.atlas_missing_info_items };
}

async function withStub(seed: Record<string, Row[]>, fn: (stub: ReturnType<typeof installRestStub>) => Promise<void>, failTables: string[] = []) {
  const stub = installRestStub(seed, { failTables });
  try { await fn(stub); } finally { stub.restore(); }
}

test("1. DOCUMENT real workflows: Derive -> Track, Track -> Derive and Derive -> Derive each keep one row", async () => {
  const item = doc();

  const deriveTrack = seedFor(item, { documents: ["risk survey"] });
  await withStub(deriveTrack, async () => {
    eq((await derive(deriveTrack)).body.generated_count, 1, "derive created document");
    const existingId = deriveTrack.atlas_missing_info_items[0].id;
    const tracked = await track(deriveTrack, item);
    eq([tracked.res.status, tracked.body.id, tracked.body.duplicate, tracked.rows.length], [200, existingId, true, 1], "derive then track");
  });

  const trackDerive = seedFor(item, { documents: ["RISK-SURVEY"] });
  await withStub(trackDerive, async () => {
    eq((await track(trackDerive, item)).res.status, 201, "track created document");
    const generated = await derive(trackDerive);
    eq([generated.body.generated_count, generated.rows.length], [0, 1], "track then derive");
  });

  const deriveDerive = seedFor(item, { documents: ["Risk Survey"] });
  await withStub(deriveDerive, async () => {
    eq((await derive(deriveDerive)).body.generated_count, 1, "first derive");
    eq([(await derive(deriveDerive)).body.generated_count, deriveDerive.atlas_missing_info_items.length], [0, 1], "second derive");
  });
});

test("2. FACT real workflows: raw Derive key and friendly Track label share the canonical schema path", async () => {
  const item = fact();
  const extractionMissing = [{ field: "registration_or_id_number", reason_required: "Please provide it." }];

  const deriveTrack = seedFor(item, { fields: extractionMissing });
  await withStub(deriveTrack, async () => {
    eq((await derive(deriveTrack)).body.generated_count, 1, "derive created fact");
    eq(deriveTrack.atlas_missing_info_items[0].title, "registration_or_id_number", "real Derive raw title");
    const existingId = deriveTrack.atlas_missing_info_items[0].id;
    const tracked = await track(deriveTrack, item);
    eq([tracked.res.status, tracked.body.id, tracked.body.duplicate, tracked.rows.length], [200, existingId, true, 1], "derive then track");
  });

  const trackDerive = seedFor(item, { fields: extractionMissing });
  await withStub(trackDerive, async () => {
    eq((await track(trackDerive, item)).res.status, 201, "track created friendly fact");
    eq(trackDerive.atlas_missing_info_items[0].title, "Registration or ID number", "Track friendly label");
    const generated = await derive(trackDerive);
    eq([generated.body.generated_count, generated.rows.length], [0, 1], "track then derive");
  });

  const deriveDerive = seedFor(item, { fields: extractionMissing });
  await withStub(deriveDerive, async () => {
    eq((await derive(deriveDerive)).body.generated_count, 1, "first derive");
    eq([(await derive(deriveDerive)).body.generated_count, deriveDerive.atlas_missing_info_items.length], [0, 1], "second derive");
  });
});

for (const [label, item, options] of [
  ["document", doc(), { documents: ["Risk Survey"] }],
  ["fact", fact(), { fields: [{ field: "registration_or_id_number" }] }],
] as [string, Row, { documents?: string[]; fields?: { field: string }[] }][]) {
  test(`3. ${label} Track -> Track across a recommendation rerun keeps one row`, async () => {
    const seed = seedFor(item, options);
    await withStub(seed, async () => {
      const first = await track(seed, item);
      eq(first.res.status, 201, "first track");
      seed.atlas_recommendations.push(recommendation(REC2, "2026-10-26T09:00:00.000Z", [item]));
      const second = await track(seed, item);
      eq([second.res.status, second.body.id, second.body.duplicate, second.rows.length], [200, first.body.id, true, 1], "rerun reuses row");
    });
  });
}

test("4. every real status remains status-blind and is never reopened or mutated", async () => {
  const item = fact();
  for (const status of ["open", "requested", "received", "waived", "not_required"] as const) {
    const seed = seedFor(item, { fields: [{ field: "registration_or_id_number" }] });
    await withStub(seed, async (stub) => {
      await derive(seed);
      seed.atlas_missing_info_items[0].status = status;
      const id = seed.atlas_missing_info_items[0].id;
      const beforeWrites = stub.writes("atlas_missing_info_items").length;
      const run = await track(seed, item);
      eq([run.res.status, run.body.id, run.body.duplicate], [200, id, true], `${status}: existing returned`);
      eq(seed.atlas_missing_info_items[0].status, status, `${status}: unchanged`);
      eq(stub.writes("atlas_missing_info_items").length, beforeWrites, `${status}: no insert/update`);
    });
  }
});

test("5. unknown free-text facts are neither fuzzily merged nor invented as a structured fact", async () => {
  const item = fact();
  const seed = seedFor(item, { fields: [
    { field: "Unknown fact-code", reason_required: "A" },
    { field: "Unknown fact code", reason_required: "A" },
  ] });
  await withStub(seed, async () => {
    const generated = await derive(seed);
    eq([generated.body.generated_count, generated.rows.length], [2, 2], "similar unknown text remains two exact rows");
    const tracked = await track(seed, item);
    eq([tracked.res.status, tracked.rows.length], [201, 3], "structured Track item matches neither unknown row");
  });
});

test("6. supported distinct requirements are not over-deduplicated", async () => {
  const item = fact();
  const seed = seedFor(item, {
    documents: ["Risk survey", "Claims history", "RISK-SURVEY"],
    fields: [{ field: "registration_or_id_number" }, { field: "extracted_client.occupation_or_business_description" }],
  });
  await withStub(seed, async () => {
    const generated = await derive(seed);
    eq([generated.body.generated_count, generated.rows.length], [4, 4], "two canonical docs + two canonical fact paths");
    eq(new Set(generated.rows.map((row) => `${row.item_type}|${row.title}`)).size, 4, "four distinct stored requirements");
  });
});

test("7. deterministic ordering chooses the oldest equivalent legacy row, then the lowest id", async () => {
  const item = doc();
  const seed = seedFor(item);
  seed.atlas_missing_info_items = [
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", submission_id: SUB, item_type: "document", title: "risk-survey", description: "old duplicate", status: "waived", created_at: "2026-01-01T00:00:00.000Z" },
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", submission_id: SUB, item_type: "document", title: "RISK SURVEY", description: "old duplicate", status: "received", created_at: "2026-01-01T00:00:00.000Z" },
    { id: "00000000-0000-4000-8000-000000000000", submission_id: SUB, item_type: "document", title: "Risk survey", description: "newer duplicate", status: "open", created_at: "2026-02-01T00:00:00.000Z" },
  ];
  await withStub(seed, async (stub) => {
    const first = await track(seed, item);
    const second = await track(seed, item);
    eq([first.body.id, second.body.id], ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"], "stable winner");
    const loads = stub.requests.filter((entry) => entry.table === "atlas_missing_info_items" && entry.method === "GET" && entry.url.searchParams.has("order"));
    assert(loads.length >= 2, "ordered logical lookups recorded");
    assert(loads.every((entry) => entry.url.searchParams.get("order") === "created_at.asc,id.asc"), "created_at then id ordering");
  });
});

test("8. Track and Derive both fail closed when the existing-logical-item lookup fails", async () => {
  const item = fact();
  const trackSeed = seedFor(item);
  await withStub(trackSeed, async (stub) => {
    const run = await track(trackSeed, item);
    eq(run.res.status, 500, "Track fails closed");
    eq(stub.writes("atlas_missing_info_items").length, 0, "Track does not insert");
  }, ["atlas_missing_info_items"]);

  const deriveSeed = seedFor(item, { fields: [{ field: "registration_or_id_number" }] });
  await withStub(deriveSeed, async (stub) => {
    const run = await derive(deriveSeed);
    eq(run.res.status, 500, "Derive fails closed");
    eq(stub.writes("atlas_missing_info_items").length, 0, "Derive does not insert");
  }, ["atlas_missing_info_items"]);
});

test("9. the same logical requirement remains independent across submissions", async () => {
  const item = fact();
  const seed = seedFor(item);
  seed.atlas_missing_info_items.push({ id: "other", submission_id: OTHER, item_type: "underwriting_info", title: "registration_or_id_number", status: "open", created_at: "2026-01-01T00:00:00.000Z" });
  await withStub(seed, async () => {
    const run = await track(seed, item);
    eq([run.res.status, run.rows.length], [201, 2], "other submission does not suppress insert");
  });
});

let failures = 0;
for (const item of tests) {
  try { await item.fn(); console.log(`ok - ${item.name}`); }
  catch (error) { failures++; console.error(`not ok - ${item.name}`); console.error((error as Error).message); }
}
console.log(`\nMissing-info interoperability: ${tests.length - failures} passed, ${failures} failed out of ${tests.length}`);
if (failures) process.exitCode = 1;
