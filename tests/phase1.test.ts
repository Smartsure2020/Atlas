import {
  collectUnavailablePdfDocuments,
  validateAndNormalizeExtraction,
} from "../worker/src/extraction.js";
import { diffFieldPaths } from "../worker/src/review-diff.js";
import { parseReviewFieldValue } from "../src/lib/review-edit.js";
import { putSignedUpload } from "../src/lib/upload.js";


const tests: { name: string; fn: () => void | Promise<void> }[] = [];

function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function field(value: unknown, confidence = 0.9) {
  return {
    value,
    status: value === null ? "not_found" : "extracted",
    confidence,
    source: {
      document_id: "doc-1",
      file_name: "schedule.pdf",
      page: 2,
      section: "Schedule",
      snippet: "Client schedule excerpt",
    },
    notes: null,
  };
}

function validExtraction() {
  return {
    schema_version: "2026-06-phase1-evidence",
    consultant_summary: "Commercial motor and liability risk.",
    extracted_client: {
      name: field("ABC Contractors"),
      entity_type: field("Company"),
      registration_or_id_number: field(null, 0),
      occupation_or_business_description: field("Electrical contractor"),
      contact_details: field(null, 0),
      risk_address: field("1 Main Road"),
    },
    broker: {
      name: field("Broker Person"),
      email: field("broker@example.com"),
      brokerage: field("Brokerage"),
    },
    current_cover: {
      current_insurer: field("Current Insurer"),
      renewal_date: field("2026-07-01"),
      current_premium: field("R10,000"),
      cover_sections: field(["Motor", "Public Liability"]),
      sums_insured: field([{ section: "Motor", value: "R500,000" }]),
      excesses: field([{ section: "Motor", value: "R5,000" }]),
      warranties: field([]),
      endorsements: field([]),
      exclusions: field([]),
      required_documents: field(["claims history"]),
    },
    risk_classification: {
      primary_risk_type: field("Commercial"),
      product_line: field("motor"),
      risk_type: field("commercial_motor"),
      secondary_risk_types: field(["Public Liability"]),
      business_sector: field("Construction"),
      complexity_level: field("medium"),
    },
    claims: {
      claims_history_available: field(false),
      claims_summary: field(null, 0),
      loss_ratio_available: field(false),
    },
    assumptions: [],
    conflicts: [],
    missing_information: [
      { field: "claims_history", reason_required: "Required to quote", priority: "high" },
    ],
    red_flags: [],
    document_notes: [{ document_id: "doc-1", document: "schedule.pdf", note: "Readable" }],
    overall_confidence: 0.82,
  };
}

test("valid extraction schema passes and normalizes", () => {
  const result = validateAndNormalizeExtraction(validExtraction());
  assertEqual(result.ok, true, "valid extraction should pass");
  assertEqual(result.value?.schema_version, "2026-06-phase1-evidence", "schema version should persist");
});

test("malformed extraction schema fails", () => {
  const result = validateAndNormalizeExtraction({ missing_information: [] });
  assertEqual(result.ok, false, "malformed extraction should fail");
  assert(/extracted_client section is required/.test(result.errors.join("\n")), "expected missing section error");
});

test("confidence outside 0..1 fails", () => {
  const sample = validExtraction();
  sample.extracted_client.name.confidence = 1.5;
  const result = validateAndNormalizeExtraction(sample);
  assertEqual(result.ok, false, "invalid confidence should fail");
  assert(/confidence must be between 0 and 1/.test(result.errors.join("\n")), "expected confidence error");
});

test("invalid field status fails", () => {
  const sample = validExtraction();
  sample.extracted_client.name.status = "guessed";
  const result = validateAndNormalizeExtraction(sample);
  assertEqual(result.ok, false, "invalid status should fail");
  assert(/status is invalid/.test(result.errors.join("\n")), "expected status error");
});

test("failed PDF download blocks extraction helper", async () => {
  const unavailable = await collectUnavailablePdfDocuments(
    [
      { id: "1", file_name: "ok.pdf", storage_path: "a" },
      { id: "2", file_name: "bad.pdf", storage_path: "b" },
      { id: "3", file_name: "note.txt", storage_path: "c" },
    ],
    async (doc) => doc.id !== "2"
  );
  assertDeepEqual(unavailable, [{ id: "2", file_name: "bad.pdf" }], "only failed PDF should be unavailable");
});

test("signed upload PUT failure is surfaced", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
  let rejected = false;
  try {
    await putSignedUpload(
        { url: "https://upload.example", path: "x/file.pdf", token: "token" },
        new Blob(["pdf"], { type: "application/pdf" }) as File,
        "application/pdf"
      );
  } catch (err) {
    rejected = /upload_failed:503:x\/file\.pdf/.test((err as Error).message);
  }
  globalThis.fetch = originalFetch;
  assert(rejected, "upload failure should reject with useful context");
});

test("array manual correction remains an array", () => {
  const parsed = parseReviewFieldValue(["Motor"], "[\"Motor\", \"Liability\"]");
  assertEqual(parsed.ok, true, "array edit should parse");
  if (parsed.ok) assertDeepEqual(parsed.value, ["Motor", "Liability"], "array should remain an array");
});

test("object manual correction remains an object", () => {
  const parsed = parseReviewFieldValue({ section: "Motor" }, "{\"section\":\"Property\"}");
  assertEqual(parsed.ok, true, "object edit should parse");
  if (parsed.ok) assertDeepEqual(parsed.value, { section: "Property" }, "object should remain an object");
});

test("review diff reports corrected field paths, names only", () => {
  const before = validExtraction();
  const after = validExtraction();
  (after.extracted_client.name as { value: unknown }).value = "ABC Contractors (Pty) Ltd";
  (after.current_cover.cover_sections as { value: unknown }).value = ["Motor", "Public Liability", "SASRIA"];
  const diff = diffFieldPaths(before, after);
  assertDeepEqual(
    diff.changed_paths,
    ["current_cover.cover_sections", "extracted_client.name"],
    "changed field paths should be reported"
  );
  assert(
    !JSON.stringify(diff).includes("ABC Contractors"),
    "diff output must contain field names only, never values"
  );
});

test("review diff is empty when nothing changed, regardless of key order", () => {
  const before = validExtraction();
  const after = JSON.parse(JSON.stringify(validExtraction()));
  const diff = diffFieldPaths(before, after);
  assertEqual(diff.changed_paths.length, 0, "identical documents should produce no diff");
  assertEqual(diff.truncated, false, "no truncation expected");
});

test("review diff caps the number of reported paths", () => {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (let i = 0; i < 80; i++) {
    before[`field_${i}`] = { value: "a", status: "extracted" };
    after[`field_${i}`] = { value: "b", status: "extracted" };
  }
  const diff = diffFieldPaths(before, after, 50);
  assertEqual(diff.changed_paths.length, 50, "paths should cap at the limit");
  assertEqual(diff.truncated, true, "cap should be reported as truncation");
});

test("legacy extraction data normalizes without crashing", () => {
  const sample = validExtraction() as Record<string, any>;
  delete sample.schema_version;
  delete sample.current_cover.warranties;
  sample.extracted_client.name = { value: "Legacy Client", confidence: 0.7 };
  const result = validateAndNormalizeExtraction(sample);
  assertEqual(result.ok, true, "legacy extraction should normalize");
  assertEqual((result.value?.extracted_client as any).name.status, "extracted", "legacy field gets status");
  assertDeepEqual((result.value?.current_cover as any).warranties.value, [], "missing new array defaults to array");
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

if (failures > 0) {
  process.exitCode = 1;
}
