/**
 * Powerhouse Checkpoint B — matcher v2: deterministic ordering and read-only
 * section intelligence. Scoring parity itself is asserted by
 * tests/phase25-matcher-differential.test.ts (500 random fixtures, pinned
 * hash) and baseline-v1.test.ts (the multi-section golden).
 */

import {
  MATCHER_VERSION,
  MATCHER_VERSION_V1,
  canonicalAppetiteOrder,
  matchInsurers,
  requestedSectionsOf,
  type InsurerScore,
  type MatchInputRisk,
} from "../../worker/src/matcher.js";
import type { AppetiteRow } from "../../worker/src/matcher-types.js";
import { clone, loadFixture } from "./fixture-loader.js";
import { projectV1 } from "./projection.js";

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

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function insurer(result: ReturnType<typeof matchInsurers>, id: string): InsurerScore {
  const found = result.insurers.find((item) => item.insurer_id === id);
  assert(found, `insurer ${id} present`);
  return found;
}

function baseRule(overrides: Partial<AppetiteRow>): AppetiteRow {
  return {
    id: "rule",
    insurer_id: "insurer-1",
    insurer_name: "Insurer One",
    product_line: "commercial_motor",
    risk_type: "transport",
    appetite_level: "standard",
    preferred_risks: [],
    caution_risks: [],
    declined_risks: [],
    required_documents: [],
    referral_triggers: [],
    notes: null,
    source: "manual",
    source_document_id: "doc",
    is_active: true,
    ...overrides,
  };
}

function baseRisk(overrides: Partial<MatchInputRisk> = {}): MatchInputRisk {
  return {
    product_candidates: ["commercial motor"],
    section_candidates: ["Commercial motor"],
    risk_candidates: ["transport"],
    features: [{ text: "transport fleet", source: "primary risk type" }],
    available_documents: [],
    overall_confidence: 0.9,
    overall_confidence_available: true,
    ...overrides,
  };
}

function shuffled<T>(values: T[], seed: number): T[] {
  const out = [...values];
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------------------

test("1. matcher version is bumped and the predecessor is nameable", () => {
  const live: string = MATCHER_VERSION;
  assert(live !== MATCHER_VERSION_V1, "version changed");
  eq(MATCHER_VERSION_V1, "2026-07-token-matching-v1", "v1 name is stable");
  eq(MATCHER_VERSION, "2026-10-section-evaluation-v2", "v2 name");
});

test("2. result is invariant under every permutation of the appetite rows (property, 200 shuffles)", () => {
  const { file, rules } = loadFixture("baseline-multi-section.json");
  const expected = JSON.stringify(matchInsurers(clone(file.risk), clone(rules)));
  for (let seed = 1; seed <= 200; seed++) {
    const actual = JSON.stringify(matchInsurers(clone(file.risk), shuffled(clone(rules), seed)));
    if (actual !== expected) throw new Error(`result differs for shuffle seed ${seed}`);
  }
});

test("3. matcher does not mutate its inputs (deep-frozen inputs succeed)", () => {
  const { file, rules } = loadFixture("baseline-multi-section.json");
  matchInsurers(deepFreeze(clone(file.risk)), deepFreeze(clone(rules)));
});

test("4. canonicalAppetiteOrder is stable, locale-independent and returns a new array", () => {
  const rows = [
    baseRule({ id: "b", insurer_id: "i2" }),
    baseRule({ id: "a", insurer_id: "i2" }),
    baseRule({ id: "z", insurer_id: "i1", product_line: "goods_in_transit" }),
    baseRule({ id: "y", insurer_id: "i1", product_line: "commercial_motor" }),
  ];
  const ordered = canonicalAppetiteOrder(rows);
  deepEq(ordered.map((row) => row.id), ["y", "z", "a", "b"], "insurer, product key, risk key, then id");
  assert(ordered !== rows, "new array");
  deepEq(rows.map((row) => row.id), ["b", "a", "z", "y"], "input untouched");
});

test("5. equal-score insurers are ordered by name then id, whatever the row order", () => {
  const rules = [
    baseRule({ id: "r-b", insurer_id: "z-id", insurer_name: "Beta Mutual" }),
    baseRule({ id: "r-a", insurer_id: "a-id", insurer_name: "Alpha Mutual" }),
    baseRule({ id: "r-c", insurer_id: "m-id", insurer_name: "Alpha Mutual" }),
  ];
  for (const order of [rules, [...rules].reverse(), shuffled(rules, 7)]) {
    const result = matchInsurers(baseRisk(), clone(order));
    deepEq(result.insurers.map((item) => item.insurer_id), ["a-id", "m-id", "z-id"], "name, then id");
    deepEq(result.insurers.map((item) => item.rank), [1, 2, 3], "ranks follow the order");
  }
});

test("6. rule tie: lowest canonical rule order wins, deterministically, and the tie is disclosed", () => {
  const rules = [
    baseRule({ id: "tie-2", product_line: "goods_in_transit", risk_type: "transport", appetite_level: "declined" }),
    baseRule({ id: "tie-1", product_line: "commercial_motor", risk_type: "transport", appetite_level: "preferred" }),
  ];
  const risk = baseRisk({
    product_candidates: ["commercial motor", "goods in transit"],
    section_candidates: ["Commercial motor", "Goods in transit"],
  });
  for (const order of [rules, [...rules].reverse()]) {
    const result = insurer(matchInsurers(risk, clone(order)), "insurer-1");
    eq(result.scored_against_appetite_id, "tie-1", "commercial_motor sorts before goods_in_transit");
    eq(result.selection?.basis, "tie_broken_by_canonical_order", "tie recorded");
    deepEq(result.selection?.tied_rule_ids, ["tie-1", "tie-2"], "tied rules listed in canonical order");
    eq(result.selection?.tied_rules_disagree, true, "preferred vs declined disagree");
  }
});

test("7. single-section submission: one evaluation, reflected in the insurer outcome, no new adverse signal", () => {
  const result = insurer(
    matchInsurers(baseRisk(), [baseRule({ id: "only", appetite_level: "preferred", preferred_risks: ["transport fleet"] })]),
    "insurer-1"
  );
  eq(result.section_evaluations?.length, 1, "one requested section");
  const section = result.section_evaluations![0];
  eq(section.status, "evaluated", "evaluated");
  eq(section.selected_rule_id, "only", "selected the scored rule");
  eq(section.reflected_in_insurer_outcome, true, "reflected");
  eq(section.outcome, "preferred", "outcome");
  eq(section.selection_basis, "only_candidate", "basis");
  eq(result.selection?.basis, "only_candidate", "insurer basis");
  eq(result.considered_rules?.length, 1, "one considered rule");
  eq(result.considered_rules![0].scored, true, "it is the scored rule");
});

test("8. multi-section fixture: the hidden Goods in transit outcomes are now visible per insurer", () => {
  const { file, rules } = loadFixture("baseline-multi-section.json");
  const result = matchInsurers(clone(file.risk), clone(rules));
  deepEq(result.requested_sections?.map((item) => item.section_key), ["commercial_motor", "goods_in_transit"], "requested sections");

  const alpha = insurer(result, "insurer-alpha");
  const alphaMotor = alpha.section_evaluations!.find((item) => item.section_key === "commercial_motor")!;
  const alphaGit = alpha.section_evaluations!.find((item) => item.section_key === "goods_in_transit")!;
  eq(alphaMotor.outcome, "preferred", "alpha motor");
  eq(alphaMotor.reflected_in_insurer_outcome, true, "alpha motor reflected");
  eq(alphaGit.selected_rule_id, "alpha-git", "alpha git rule found");
  eq(alphaGit.outcome, "hard_decline", "alpha git is a hard decline");
  eq(alphaGit.reflected_in_insurer_outcome, false, "but it is NOT reflected in the score");
  eq(alpha.ruled_out, false, "overall outcome unchanged: alpha is still not ruled out");
  eq(alpha.score, 100, "overall score unchanged");

  const beta = insurer(result, "insurer-beta");
  const betaGit = beta.section_evaluations!.find((item) => item.section_key === "goods_in_transit")!;
  eq(betaGit.outcome, "referral", "beta git: referral outranks caution in the worst-first label");
  const betaGitRule = beta.considered_rules!.find((item) => item.rule_id === "beta-git")!;
  deepEq(
    betaGitRule.conditions.map((item) => `${item.kind}:${item.origin}`),
    ["caution:caution_risks", "referral:referral_triggers"],
    "caution and referral conditions both surfaced"
  );
  deepEq(
    betaGitRule.conditions[0].matched_rule_terms,
    [{ term: "high value cargo", input_source: "endorsements" }],
    "insurer-owned term paired with its input source"
  );
  eq(beta.referral_required, false, "overall referral flag unchanged (v1 parity)");
  eq(beta.score, 70, "overall score unchanged");
});

test("9. considered rules are bounded: lower-quality risk-only matches are counted, not listed", () => {
  const rules = [
    baseRule({ id: "motor", product_line: "commercial_motor", risk_type: "transport" }),
    baseRule({ id: "risk-only-1", product_line: "cyber", risk_type: "transport" }),
    baseRule({ id: "risk-only-2", product_line: "marine", risk_type: "transport" }),
    baseRule({ id: "unrelated", product_line: "cyber", risk_type: "technology" }),
  ];
  const result = insurer(matchInsurers(baseRisk(), rules), "insurer-1");
  deepEq(result.considered_rules?.map((item) => item.rule_id), ["motor"], "only the relevant rule is listed");
  eq(result.selection?.matching_rule_count, 3, "three rules qualified");
  eq(result.selection?.omitted_risk_only_rule_count, 2, "two risk-only matches omitted but counted");
});

test("10. risk-only rules that tie for best ARE listed (they genuinely competed)", () => {
  const rules = [
    baseRule({ id: "ro-1", product_line: "cyber", risk_type: "transport" }),
    baseRule({ id: "ro-2", product_line: "marine", risk_type: "transport" }),
  ];
  const result = insurer(matchInsurers(baseRisk(), rules), "insurer-1");
  deepEq(result.considered_rules?.map((item) => item.rule_id), ["ro-1", "ro-2"], "both listed");
  eq(result.selection?.taxonomy_quality, 1, "quality 1");
  eq(result.considered_rules![1].not_scored_reason, "lost_tie_canonical_order", "reason recorded");
  eq(result.section_evaluations![0].status, "no_applicable_rule", "the requested section matched no rule");
  eq(result.section_evaluations![0].reflected_in_insurer_outcome, false, "so nothing is reflected");
});

test("11. a requested section with no applicable rule is explicit, not silently dropped", () => {
  const risk = baseRisk({
    product_candidates: ["commercial motor", "cyber"],
    section_candidates: ["Commercial motor", "Cyber"],
  });
  const result = insurer(matchInsurers(risk, [baseRule({ id: "motor" })]), "insurer-1");
  const cyber = result.section_evaluations!.find((item) => item.section_key === "cyber")!;
  eq(cyber.status, "no_applicable_rule", "cyber has no rule at this insurer");
  eq(cyber.selected_rule_id, null, "no selection");
  eq(cyber.outcome, null, "no outcome");
  deepEq(result.unmatched_sections, [], "v1 unmatched_sections semantics unchanged (empty when a rule was used)");
});

test("12. AI-inferred decline stays a soft_decline_referral at section level and never a hard decline", () => {
  const risk = baseRisk({
    features: [
      { text: "transport fleet", source: "primary risk type" },
      { text: "asbestos exposure", source: "red flag", ai_inferred: true },
    ],
  });
  const result = insurer(matchInsurers(risk, [baseRule({ id: "soft", declined_risks: ["asbestos"] })]), "insurer-1");
  eq(result.ruled_out, false, "insurer not ruled out");
  eq(result.referral_required, true, "referral required (v1 behaviour)");
  eq(result.section_evaluations![0].outcome, "soft_decline_referral", "section outcome is soft, not hard");
  deepEq(result.considered_rules![0].conditions.map((item) => item.kind), ["soft_decline_referral"], "condition kind");
});

test("13. document-derived decline is a hard decline at section level", () => {
  const risk = baseRisk({ features: [{ text: "asbestos roof", source: "occupation/business description" }] });
  const result = insurer(matchInsurers(risk, [baseRule({ id: "hard", declined_risks: ["asbestos"] })]), "insurer-1");
  eq(result.ruled_out, true, "insurer ruled out (v1 behaviour)");
  eq(result.section_evaluations![0].outcome, "hard_decline", "section outcome");
});

test("14. portfolio rules never create sections and are not 'considered' product rules", () => {
  const rules = [
    baseRule({ id: "motor" }),
    baseRule({ id: "pf", product_line: "*", risk_type: "*", caution_risks: ["transport fleet"] }),
  ];
  const result = insurer(matchInsurers(baseRisk(), rules), "insurer-1");
  deepEq(result.considered_rules?.map((item) => item.rule_id), ["motor"], "product rules only");
  eq(result.score, 60, "portfolio caution still scored exactly as v1 (70 - 10)");
});

test("15. requestedSectionsOf de-duplicates by canonical key and ignores blanks", () => {
  deepEq(
    requestedSectionsOf(baseRisk({ section_candidates: ["Commercial motor", "commercial vehicles", "  ", "Goods in transit"] })),
    [
      { section: "Commercial motor", section_key: "commercial_motor" },
      { section: "Goods in transit", section_key: "goods_in_transit" },
    ],
    "canonical identity"
  );
  deepEq(requestedSectionsOf(baseRisk({ section_candidates: undefined })), [], "legacy input without sections");
});

test("16. v1 projection of a single-section submission is unchanged by section intelligence", () => {
  const result = matchInsurers(baseRisk(), [baseRule({ id: "x", appetite_level: "preferred", preferred_risks: ["transport fleet"] })]);
  const projected = projectV1(result);
  eq(projected.insurers[0].score, 100, "100 + 5 clamped");
  eq(projected.insurers[0].scored_against_appetite_id, "x", "same rule");
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
console.log(`\nPowerhouse matcher v2: ${tests.length - failures} passed, ${failures} failed out of ${tests.length}`);
if (failures > 0) process.exitCode = 1;
