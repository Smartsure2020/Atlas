import { handleTrackDetectedMissingInfo } from "../../worker/src/phase4-endpoints.js";
import { detectedMissingInfoId } from "../../worker/src/detected-missing-info.js";
import { env, installRestStub, MANAGER, SUB, type Row } from "./handler-harness.js";
import type { AtlasUser } from "../../worker/src/auth.js";

const REC = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REC2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "99999999-9999-4999-8999-999999999999";
const BROKER = { id: "broker-1", email: "broker@example.test", role: "broker" } as AtlasUser;

interface Test { name: string; fn: () => void | Promise<void> }
const tests: Test[] = [];
const test = (name: string, fn: Test["fn"]) => tests.push({ name, fn });
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function eq(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function evidence(items: Row[], schema: unknown = "recommendation-evidence-v3"): Row {
  return { schema_version: schema, completeness: { items } };
}

function doc(id = "cmp:required_document_missing:-:-:risk survey", title = "Risk survey"): Row {
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

function fact(path = "extracted_client.registration_or_id_number", id = `cmp:extraction_reported_information_missing:-:-:field:${path}`): Row {
  return {
    item_id: id,
    code: "extraction_reported_information_missing",
    scope: "fact",
    status: "missing",
    source: "reviewed_extraction",
    field_path: path,
  };
}

function sections(id = "cmp:requested_sections_not_declared:-:-:submission"): Row {
  return {
    item_id: id,
    code: "requested_sections_not_declared",
    scope: "submission",
    status: "missing",
    source: "declared_sections",
  };
}

function recommendation(id: string, createdAt: string, items: Row[], schema: unknown = "recommendation-evidence-v3", submissionId = SUB): Row {
  return { id, submission_id: submissionId, created_at: createdAt, evidence_json: schema === null ? null : evidence(items, schema) };
}

function request(detectedItemId: unknown, submissionId = SUB, extras: Row = {}) {
  return new Request(`https://atlas.test/api/submissions/${submissionId}/missing-info/detected`, {
    method: "POST",
    body: JSON.stringify({ detected_item_id: detectedItemId, ...extras }),
  });
}

async function invoke(seed: Record<string, Row[]>, detectedItemId: unknown, options: { user?: AtlasUser; submissionId?: string; extras?: Row } = {}) {
  const submissionId = options.submissionId ?? SUB;
  const res = await handleTrackDetectedMissingInfo(
    submissionId,
    request(detectedItemId, submissionId, options.extras),
    env(),
    options.user ?? MANAGER
  );
  return { res, body: await res.json() as Row };
}

function baseSeed(items: Row[], missing: Row[] = [], recommendationId = REC): Record<string, Row[]> {
  return {
    atlas_recommendations: [recommendation(recommendationId, "2026-10-26T08:00:00.000Z", items)],
    atlas_missing_info_items: missing,
  };
}

test("1. broker is rejected before evidence is read", async () => {
  const seed = baseSeed([doc()]);
  const stub = installRestStub(seed);
  try {
    const run = await invoke(seed, doc().item_id, { user: BROKER });
    eq(run.res.status, 403, "broker status");
    eq(stub.requests.length, 0, "no database read");
  } finally { stub.restore(); }
});

test("2. client-authored fields are rejected and persisted content is server-derived", async () => {
  const item = fact();
  const badSeed = baseSeed([item]);
  const badStub = installRestStub(badSeed);
  try { eq((await invoke(badSeed, item.item_id, { extras: { title: "internal contradiction text" } })).res.status, 400, "extra keys rejected"); }
  finally { badStub.restore(); }

  const seed = baseSeed([{ ...item, label: "UNTRUSTED MODEL TEXT" }]);
  const stub = installRestStub(seed);
  try {
    const run = await invoke(seed, item.item_id);
    eq(run.res.status, 201, "created");
    const writes = stub.writes("atlas_missing_info_items");
    eq(writes.length, 1, "one row");
    const row = writes[0].body as Row;
    eq([row.title, row.description, row.item_type, row.owner, row.source], [
      "Registration or ID number", "Reported as outstanding when the submission was read.", "underwriting_info", "broker", "extraction",
    ], "server-derived row");
    assert(!JSON.stringify(row).includes("UNTRUSTED") && !JSON.stringify(row).includes("contradiction"), "no unrestricted/internal text persisted");
  } finally { stub.restore(); }
});

test("A. the same item twice on the same recommendation creates one row", async () => {
  const item = doc();
  const seed = baseSeed([item]);
  const stub = installRestStub(seed);
  try {
    const first = await invoke(seed, item.item_id);
    const second = await invoke(seed, item.item_id);
    eq([first.res.status, second.res.status], [201, 200], "created then duplicate");
    eq(first.body.id, second.body.id, "same id");
    eq(second.body.duplicate, true, "duplicate flagged");
    eq(stub.writes("atlas_missing_info_items").length, 1, "only one insert");
    eq(first.body.id, detectedMissingInfoId(SUB, REC, String(item.item_id)), "deterministic primary key");
  } finally { stub.restore(); }
});

test("B. eight equivalent concurrent requests converge on one row", async () => {
  const item = doc();
  const seed = baseSeed([item]);
  const stub = installRestStub(seed);
  try {
    const runs = await Promise.all(Array.from({ length: 8 }, () => invoke(seed, item.item_id)));
    eq(runs.filter((run) => run.res.status === 201).length, 1, "one creator");
    eq(new Set(runs.map((run) => run.body.id)).size, 1, "one returned id");
    eq(seed.atlas_missing_info_items.length, 1, "one stored row");
  } finally { stub.restore(); }
});

for (const status of ["open", "requested", "received", "waived", "not_required"] as const) {
  test(`C-F. a ${status} logical item from an earlier recommendation is returned without insert`, async () => {
    const item = doc();
    const existing = { id: `existing-${status}`, submission_id: SUB, item_type: "document", title: "RISK-SURVEY", status };
    const seed = baseSeed([item], [existing], REC2);
    const stub = installRestStub(seed);
    try {
      const run = await invoke(seed, item.item_id);
      eq(run.res.status, 200, "existing returned");
      eq(run.body, { ok: true, id: existing.id, duplicate: true }, "stable duplicate response");
      eq(stub.writes("atlas_missing_info_items").length, 0, "no insert or reopen");
      eq(existing.status, status, "status unchanged");
    } finally { stub.restore(); }
  });
}

test("G. an item derived from the analysis deduplicates by exact approved type and title", async () => {
  const item = fact();
  const seed = baseSeed([item], [{ id: "existing-fact", submission_id: SUB, item_type: "underwriting_info", title: "Registration or ID number", status: "received" }], REC2);
  const stub = installRestStub(seed);
  try {
    const run = await invoke(seed, item.item_id);
    eq([run.res.status, run.body.id, stub.writes("atlas_missing_info_items").length], [200, "existing-fact", 0], "derived logical duplicate");
  } finally { stub.restore(); }
});

test("H. two different detected requirements create two rows", async () => {
  const items = [doc(), fact()];
  const seed = baseSeed(items);
  const stub = installRestStub(seed);
  try {
    const runs = [await invoke(seed, items[0].item_id), await invoke(seed, items[1].item_id)];
    eq(runs.map((run) => run.res.status), [201, 201], "both created");
    eq(new Set(runs.map((run) => run.body.id)).size, 2, "distinct ids");
    eq(seed.atlas_missing_info_items.length, 2, "two rows");
  } finally { stub.restore(); }
});

test("I. the same requirement remains independent across submissions", async () => {
  const item = doc();
  const seed: Record<string, Row[]> = {
    atlas_recommendations: [recommendation(REC2, "2026-10-26T08:00:00.000Z", [item])],
    atlas_missing_info_items: [{ id: "other-submission", submission_id: OTHER, item_type: "document", title: "Risk survey", status: "open" }],
  };
  const stub = installRestStub(seed);
  try {
    const run = await invoke(seed, item.item_id);
    eq(run.res.status, 201, "new submission row created");
    eq(seed.atlas_missing_info_items.length, 2, "other submission did not suppress it");
  } finally { stub.restore(); }
});

test("J. type and canonical document identity prevent false title collisions", async () => {
  const item = doc();
  const seed = baseSeed([item], [
    { id: "same-words-other-type", submission_id: SUB, item_type: "underwriting_info", title: "Risk survey", status: "open" },
    { id: "different-document-key", submission_id: SUB, item_type: "document", title: "Risk survey addendum", status: "open" },
  ]);
  const stub = installRestStub(seed);
  try {
    const run = await invoke(seed, item.item_id);
    eq(run.res.status, 201, "distinguishable requirements do not collapse");
    eq(seed.atlas_missing_info_items.length, 3, "new logical document added");
  } finally { stub.restore(); }
});

test("3. three approved items on one recommendation produce three distinct deterministic IDs and rows", async () => {
  const items = [doc(), fact(), sections()];
  const seed = baseSeed(items);
  const stub = installRestStub(seed);
  try {
    const runs = [];
    for (const item of items) runs.push(await invoke(seed, item.item_id));
    eq(runs.map((run) => run.res.status), [201, 201, 201], "all created");
    eq(new Set(runs.map((run) => run.body.id)).size, 3, "three IDs");
    eq(seed.atlas_missing_info_items.length, 3, "three rows");
  } finally { stub.restore(); }
});

test("4. the newest recommendation is selected, with descending order and limit one", async () => {
  const oldItem = doc("old-id", "Old document");
  const latestItem = fact();
  const seed = {
    atlas_recommendations: [recommendation("old-rec", "2026-01-01T00:00:00.000Z", [oldItem]), recommendation("latest-rec", "2026-10-26T08:00:00.000Z", [latestItem])],
    atlas_missing_info_items: [],
  };
  const stub = installRestStub(seed);
  try {
    const latest = await invoke(seed, latestItem.item_id);
    eq(latest.res.status, 201, "latest item accepted");
    const load = stub.requests.find((entry) => entry.table === "atlas_recommendations");
    assert(load, "recommendation query recorded");
    eq([load.url.searchParams.get("order"), load.url.searchParams.get("limit")], ["created_at.desc", "1"], "latest query contract");
  } finally { stub.restore(); }

  const staleSeed = {
    atlas_recommendations: [recommendation("old-rec", "2026-01-01T00:00:00.000Z", [oldItem]), recommendation("latest-rec", "2026-10-26T08:00:00.000Z", [latestItem])],
    atlas_missing_info_items: [],
  };
  const staleStub = installRestStub(staleSeed);
  try { eq((await invoke(staleSeed, oldItem.item_id)).res.status, 422, "stale detected ID rejected"); }
  finally { staleStub.restore(); }
});

test("5. recommendation selection is submission-scoped", async () => {
  const wanted = doc();
  const seed = {
    atlas_recommendations: [
      recommendation("wanted", "2026-01-01T00:00:00.000Z", [wanted]),
      recommendation("other-latest", "2026-12-01T00:00:00.000Z", [fact()], "recommendation-evidence-v3", OTHER),
    ],
    atlas_missing_info_items: [],
  };
  const stub = installRestStub(seed);
  try { eq((await invoke(seed, wanted.item_id)).res.status, 201, "other submission ignored"); }
  finally { stub.restore(); }
});

test("6. latest v1, v2, null and malformed v3 evidence fail closed", async () => {
  for (const [label, schema, items] of [
    ["v1", "recommendation-evidence-v1", [doc()]],
    ["v2", "recommendation-evidence-v2", [doc()]],
    ["null", null, [doc()]],
    ["malformed v3", "recommendation-evidence-v3", [{ ...doc(), source: "internal_diagnostic" }]],
  ] as [string, unknown, Row[]][]) {
    const seed = {
      atlas_recommendations: [
        recommendation("older-good", "2026-01-01T00:00:00.000Z", [doc()]),
        recommendation(`latest-${label}`, "2026-10-26T08:00:00.000Z", items, schema),
      ],
      atlas_missing_info_items: [],
    };
    const stub = installRestStub(seed);
    try {
      const run = await invoke(seed, doc().item_id);
      eq(run.res.status, label === "malformed v3" ? 422 : 409, `${label} rejected`);
      eq(stub.writes("atlas_missing_info_items").length, 0, `${label}: no write`);
    } finally { stub.restore(); }
  }
});

for (const [name, item] of [
  ["contradiction id", { item_id: "ctr:risk.product:x", code: "conflicting_recorded_values", scope: "submission", status: "missing" }],
  ["internal provenance limitation", { item_id: "cmp:requested_section_not_evaluated:x", code: "requested_section_not_evaluated", scope: "section", status: "missing" }],
  ["insurer quality limitation", { item_id: "cmp:insurer_appetite_data_missing:x", code: "insurer_appetite_data_missing", scope: "insurer", status: "missing" }],
  ["rule-selection tie", { item_id: "cmp:section_rule_ambiguous:x", code: "section_rule_ambiguous", scope: "section", status: "missing" }],
] as const) {
  test(`7. ${name} is not trackable`, async () => {
    const seed = baseSeed([item as Row]);
    const stub = installRestStub(seed);
    try { eq((await invoke(seed, item.item_id)).res.status, 422, "rejected"); eq(stub.writes("atlas_missing_info_items").length, 0, "no write"); }
    finally { stub.restore(); }
  });
}

test("8. unknown ID and an absent submission recommendation are rejected", async () => {
  const seed = baseSeed([doc()]);
  const stub = installRestStub(seed);
  try { eq((await invoke(seed, "cmp:unknown")).res.status, 422, "unknown"); }
  finally { stub.restore(); }

  const otherSeed = { atlas_recommendations: [recommendation(REC, "2026-10-26T08:00:00.000Z", [doc()], "recommendation-evidence-v3", OTHER)], atlas_missing_info_items: [] };
  const otherStub = installRestStub(otherSeed);
  try { eq((await invoke(otherSeed, doc().item_id)).res.status, 400, "no current recommendation for submission"); }
  finally { otherStub.restore(); }
});

let failures = 0;
for (const item of tests) {
  try { await item.fn(); console.log(`ok - ${item.name}`); }
  catch (error) { failures++; console.error(`not ok - ${item.name}`); console.error((error as Error).message); }
}
console.log(`\nDetected missing-info endpoint: ${tests.length - failures} passed, ${failures} failed out of ${tests.length}`);
if (failures) process.exitCode = 1;
