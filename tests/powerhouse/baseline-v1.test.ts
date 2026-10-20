/**
 * Powerhouse Checkpoint A — forensic baseline of matcher `2026-07-token-matching-v1`.
 *
 * This file pins what production Atlas (main @ 34441a0) returns for a
 * multi-section submission BEFORE any Powerhouse change. The golden file
 * `fixtures/baseline-multi-section.v1.golden.json` was generated from that
 * code and is the permanent record; it must never be regenerated from new
 * matcher code. (Regeneration is only possible with POWERHOUSE_UPDATE_GOLDEN=1
 * and exists solely so Checkpoint A could create the file.)
 *
 * Two roles:
 *   1. Characterisation — proves the known limitation "one best product rule
 *      per insurer": a hard decline / caution / referral in a requested cover
 *      section can vanish from the recommendation and from evidence_json.
 *   2. Parity lens — later matcher work must reproduce this answer for every
 *      insurer whose outcome does not depend on undefined row order.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { MATCHER_VERSION, matchInsurers } from "../../worker/src/matcher.js";
import { buildRecommendationEvidence } from "../../worker/src/recommendation-evidence.js";
import { TAXONOMY_VERSION } from "../../worker/src/taxonomy.js";
import { clone, fixturePath, loadFixture } from "./fixture-loader.js";
import { projectV1, type V1Projection } from "./projection.js";

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

const GOLDEN = "baseline-multi-section.v1.golden.json";
const V1_MATCHER_VERSION = "2026-07-token-matching-v1";
// Widened on purpose: the live constant is a literal type that no longer
// overlaps with the v1 string, and that is exactly what these guards compare.
const LIVE_MATCHER_VERSION: string = MATCHER_VERSION;

interface Golden {
  golden_schema: "powerhouse-baseline-golden-v1";
  recorded_against: { commit: string; matcher_version: string; taxonomy_version: string };
  as_listed: V1Projection;
  reversed: V1Projection;
  evidence_v1_as_listed: Record<string, { rule_ids: string[]; effects: string[] }>;
  evidence_v1_quality_status: string;
}

function evidenceSummary(projectionSource: ReturnType<typeof matchInsurers>, risk: Parameters<typeof matchInsurers>[0], rules: Parameters<typeof matchInsurers>[1]) {
  const evidence = buildRecommendationEvidence({
    recommendationId: "baseline-rec",
    submissionId: "baseline-sub",
    extractionId: "baseline-ext",
    reviewedAt: "2026-10-16T09:00:00.000Z",
    generatedAt: "2026-10-16T10:00:00.000Z",
    matcherVersion: MATCHER_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    explanationMode: "deterministic",
    explanationSource: "deterministic",
    recommendationInputFingerprint: "fp_baseline",
    reviewed: {},
    matcherInput: risk,
    matcherResult: projectionSource,
    activeAppetite: rules,
  });
  const summary: Golden["evidence_v1_as_listed"] = {};
  for (const insurer of evidence.insurers) {
    if (insurer.status !== "scored") continue;
    summary[insurer.insurer_id] = {
      rule_ids: [...new Set(insurer.rule_evidence.map((item) => item.rule_id))].sort(),
      effects: insurer.rule_evidence.map((item) => item.effect),
    };
  }
  return { summary, qualityStatus: evidence.quality.status };
}

function runBoth() {
  const { file, rules } = loadFixture("baseline-multi-section.json");
  const asListed = matchInsurers(clone(file.risk), clone(rules));
  const reversed = matchInsurers(clone(file.risk), clone([...rules].reverse()));
  return { file, rules, asListed, reversed };
}

if (process.env.POWERHOUSE_UPDATE_GOLDEN === "1") {
  if (existsSync(fixturePath(GOLDEN))) throw new Error("golden_already_recorded: refusing to overwrite the v1 baseline");
  if (LIVE_MATCHER_VERSION !== V1_MATCHER_VERSION) throw new Error("golden_must_be_recorded_against_v1_matcher");
  const { file, rules, asListed, reversed } = runBoth();
  const evidence = evidenceSummary(asListed, clone(file.risk), clone(rules));
  const golden: Golden = {
    golden_schema: "powerhouse-baseline-golden-v1",
    recorded_against: { commit: "34441a0", matcher_version: MATCHER_VERSION, taxonomy_version: TAXONOMY_VERSION },
    as_listed: projectV1(asListed),
    reversed: projectV1(reversed),
    evidence_v1_as_listed: evidence.summary,
    evidence_v1_quality_status: evidence.qualityStatus,
  };
  writeFileSync(fixturePath(GOLDEN), `${JSON.stringify(golden, null, 2)}\n`);
  console.log(`recorded ${GOLDEN}`);
}

function golden(): Golden {
  return JSON.parse(readFileSync(fixturePath(GOLDEN), "utf8")) as Golden;
}

function byId(projection: V1Projection, insurerId: string) {
  const found = projection.insurers.find((item) => item.insurer_id === insurerId);
  assert(found, `insurer ${insurerId} present`);
  return found;
}

// ---------------------------------------------------------------------------
// Parity lens: the golden record is what v1 answered. For every insurer whose
// outcome does not hinge on undefined row order, later matchers must agree.
// ---------------------------------------------------------------------------

test("1. golden records the v1 matcher on the pinned commit", () => {
  const g = golden();
  eq(g.recorded_against.commit, "34441a0", "recorded against production baseline");
  eq(g.recorded_against.matcher_version, V1_MATCHER_VERSION, "recorded against v1 matcher");
  eq(g.recorded_against.taxonomy_version, "2026-07-token-aliases-v1", "recorded against taxonomy v1");
});

test("2. PARITY: every insurer's authoritative answer equals the v1 golden when rows arrive as listed", () => {
  const g = golden();
  const { asListed } = runBoth();
  // Full projection including position and rank: the whole v1 answer.
  deepEq(projectV1(asListed), g.as_listed, "v2 reproduces the v1 answer for the listed row order");
});

test("2b. PARITY: row-order-independent insurers match the v1 golden for reversed rows too (position/rank excluded)", () => {
  const g = golden();
  const { reversed } = runBoth();
  const now = projectV1(reversed);
  const strip = ({ position: _p, rank: _r, ...rest }: V1Projection["insurers"][number]) => rest;
  for (const insurerId of ["insurer-alpha", "insurer-beta"]) {
    deepEq(strip(byId(now, insurerId)), strip(byId(g.reversed, insurerId)), `${insurerId} reversed`);
  }
});

test("2c. INTENTIONAL DIFFERENCE: v2 is row-order invariant; v1 reversed-row Gamma (ruled out by tie accident) is now the canonical answer", () => {
  const g = golden();
  const { asListed, reversed } = runBoth();
  deepEq(projectV1(reversed), projectV1(asListed), "v2: reversing rows changes nothing");
  const gamma = byId(projectV1(reversed), "insurer-gamma");
  eq(gamma.scored_against_appetite_id, "gamma-motor", "canonical tie-break picks commercial_motor before goods_in_transit");
  eq(gamma.ruled_out, false, "gamma is not ruled out by row-order accident");
  eq(byId(g.reversed, "insurer-gamma").ruled_out, true, "the v1 golden recorded the accident");
});

// ---------------------------------------------------------------------------
// Characterisation of the known limitation (these describe v1; they are the
// reason Powerhouse Phase 2 exists).
// ---------------------------------------------------------------------------

test("3. LIMITATION: a hard-declined requested section (Goods in transit) is invisible when another section scores well", () => {
  const alpha = byId(golden().as_listed, "insurer-alpha");
  eq(alpha.ruled_out, false, "alpha is NOT ruled out");
  eq(alpha.band, "preferred", "alpha is scored preferred");
  eq(alpha.score, 100, "alpha score is the clamped motor-only preferred score (100 base + 5 preferred, clamped)");
  eq(alpha.scored_against_appetite_id, "alpha-motor", "alpha scored against the motor rule only");
  const everything = JSON.stringify(alpha);
  assert(!everything.includes("alpha-git"), "alpha's declined GIT rule appears nowhere in the v1 answer");
  deepEq(alpha.unmatched_sections, [], "no unmatched-section signal is emitted when a rule was used");
});

test("4. LIMITATION: caution and referral in the second section are never evaluated, although the features would hit them", () => {
  const beta = byId(golden().as_listed, "insurer-beta");
  eq(beta.score, 70, "beta keeps the clean standard motor score");
  eq(beta.referral_required, false, "beta raises no referral");
  const everything = JSON.stringify(beta);
  assert(!everything.includes("beta-git"), "beta's caution GIT rule appears nowhere in the v1 answer");
  assert(!everything.includes("high value cargo"), "the caution term that matches a submitted feature is never reported");
  assert(!everything.includes("cross border"), "the referral trigger that matches a submitted feature is never reported");
});

test("5. LIMITATION: with equal taxonomy quality the surviving rule depends on row order, and a decline can flip the insurer", () => {
  const g = golden();
  const listed = byId(g.as_listed, "insurer-gamma");
  const reversed = byId(g.reversed, "insurer-gamma");
  eq(listed.scored_against_appetite_id, "gamma-motor", "gamma as listed uses the first tied rule");
  eq(listed.ruled_out, false, "gamma as listed is viable");
  eq(reversed.ruled_out, true, "gamma with reversed rows is RULED OUT by the other tied rule");
  assert(listed.score !== reversed.score, "identical input, different answer");
});

test("6. LIMITATION: insurer ordering of equal scores follows row order, not a defined key", () => {
  const g = golden();
  const idsListed = g.as_listed.insurers.map((item) => item.insurer_id);
  const idsReversed = g.reversed.insurers.map((item) => item.insurer_id);
  assert(JSON.stringify(idsListed) !== JSON.stringify(idsReversed), "same insurers, different order");
});

test("7. LIMITATION: evidence v1 reports quality 'complete' although whole requested sections were never evaluated", () => {
  const g = golden();
  eq(g.evidence_v1_quality_status, "complete", "Phase 1A quality state is complete");
  for (const insurerId of ["insurer-alpha", "insurer-beta"]) {
    const ruleIds = g.evidence_v1_as_listed[insurerId].rule_ids;
    assert(ruleIds.every((id) => !id.endsWith("-git")), `${insurerId} evidence carries no Goods in transit rule`);
  }
});

// ---------------------------------------------------------------------------
// Source-level facts about the surrounding system at the baseline commit. These
// are expected to be INVERTED by Phase 2 and are asserted against git history
// in docs/powerhouse-p1b-p2-forensic-baseline.md, not here (this file keeps
// describing what v1 was). They are executed only while the v1 matcher is live.
// ---------------------------------------------------------------------------

if (LIVE_MATCHER_VERSION === V1_MATCHER_VERSION) {
  test("8. BASELINE: recommendation fingerprint ignores matcher and taxonomy versions", () => {
    const core = readFileSync("worker/src/phase7-core.ts", "utf8");
    const fingerprint = core.slice(core.indexOf("export function buildRecommendationFingerprint"), core.indexOf("export function buildQuoteReviewFingerprint"));
    assert(!/matcher/i.test(fingerprint) && !/taxonomy/i.test(fingerprint), "no version in the v1 fingerprint");
  });

  test("9. BASELINE: appetite query specifies no ordering", () => {
    const endpoint = readFileSync("worker/src/recommendation-endpoints.ts", "utf8");
    const start = endpoint.indexOf('.from("atlas_insurer_appetite")');
    const query = endpoint.slice(start, endpoint.indexOf("const appetite =", start));
    assert(!query.includes(".order("), "no ORDER BY on the appetite load");
  });

  test("10. BASELINE: reasoning_json.matcher_input stores the raw matcher input", () => {
    const endpoint = readFileSync("worker/src/recommendation-endpoints.ts", "utf8");
    assert(/matcher_input:\s*risk,/.test(endpoint), "raw derived risk is persisted verbatim");
  });
}

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
console.log(`\nPowerhouse baseline (v1 golden): ${tests.length - failures} passed, ${failures} failed out of ${tests.length}`);
if (failures > 0) process.exitCode = 1;
