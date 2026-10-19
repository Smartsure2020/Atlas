/** Baseline-vs-remediated matcher differential with new descriptive fields projected away. */

import { createHash } from "node:crypto";
import { matchInsurers, type MatchInputRisk, type MatchResult } from "../worker/src/matcher.js";
import type { AppetiteLevel, AppetiteRow } from "../worker/src/matcher-types.js";

const BASELINE_SHA256 = "b14d992783a2fad9585d388869bc6462bc6710205828a191f3857e4488839a36";
let seed = 0x51a7cafe;
const next = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
};
const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)];

function rule(index: number, insurer: number, portfolio = false): AppetiteRow {
  return {
    id: `rule-${index}`,
    insurer_id: `insurer-${insurer}`,
    insurer_name: `Insurer ${insurer}`,
    product_line: portfolio ? "*" : pick(["commercial_motor", "buildings", "cyber"]),
    risk_type: portfolio ? "*" : pick(["transport", "property", "technology"]),
    appetite_level: pick<AppetiteLevel>(["preferred", "standard", "caution", "declined"]),
    preferred_risks: next() < 0.55 ? [pick(["fleet", "sprinkler", "backup"])] : [],
    caution_risks: next() < 0.55 ? [pick(["old roof", "high value", "remote"])] : [],
    declined_risks: next() < 0.35 ? [pick(["asbestos", "war", "unlicensed"])] : [],
    required_documents: next() < 0.65 ? [pick(["Claims history", "Policy schedule", "Risk survey"])] : [],
    referral_triggers: next() < 0.5 ? [pick(["high value", "remote", "fleet"])] : [],
    notes: null,
    source: "manual",
    source_document_id: null,
    is_active: true,
  };
}

function project(result: MatchResult) {
  return {
    insurers: result.insurers.map((insurer) => ({
      insurer_id: insurer.insurer_id,
      insurer_name: insurer.insurer_name,
      score: insurer.score,
      band: insurer.band,
      rule_status: insurer.rule_status,
      confidence: insurer.confidence,
      confidence_available: insurer.confidence_available,
      referral_required: insurer.referral_required,
      manual_review_required: insurer.manual_review_required,
      senior_review_required: insurer.senior_review_required,
      ruled_out: insurer.ruled_out,
      scored_against_appetite_id: insurer.scored_against_appetite_id,
      matched_rules: insurer.matched_rules.map((matched) => ({
        appetite_id: matched.appetite_id,
        matched_strings: matched.matched_strings,
        rule_product_line: matched.rule_product_line,
        rule_risk_type: matched.rule_risk_type,
        source_quote: matched.source_quote,
        source_page: matched.source_page,
        source_section: matched.source_section,
        source_file_name: matched.source_file_name,
        list: matched.list,
      })),
      scoring_notes: insurer.scoring_notes,
      missing_required_documents: insurer.missing_required_documents,
      unmatched_sections: insurer.unmatched_sections,
      unmatched_product_candidates: insurer.unmatched_product_candidates,
      nearby_rule_matches: insurer.nearby_rule_matches,
    })),
    no_data_for: result.no_data_for,
  };
}

const corpus: ReturnType<typeof project>[] = [];
for (let fixture = 0; fixture < 500; fixture++) {
  const rules: AppetiteRow[] = [];
  for (let insurer = 0; insurer < 6; insurer++) {
    rules.push(rule(fixture * 20 + insurer * 2, insurer));
    if (next() < 0.7) rules.push(rule(fixture * 20 + insurer * 2 + 1, insurer, true));
  }
  const documentFeature = [
    pick(["fleet", "sprinkler", "backup"]),
    pick(["old roof", "high value", "remote"]),
    pick(["asbestos", "war", "unlicensed"]),
  ].join(" ");
  const risk: MatchInputRisk = {
    product_candidates: [pick(["commercial_motor", "buildings", "cyber", "marine"])],
    section_candidates: [pick(["commercial_motor", "buildings", "cyber", "marine"])],
    risk_candidates: [pick(["transport", "property", "technology", "retail"])],
    features: [
      { text: documentFeature, source: "fixture field" },
      { text: pick(["asbestos", "war", "unlicensed", "clear"]), source: "red flag", ai_inferred: true },
    ],
    available_documents: next() < 0.5 ? ["Claims history"] : ["Policy schedule", "Risk survey"],
    overall_confidence: Math.round(next() * 100) / 100,
    overall_confidence_available: next() >= 0.1,
  };
  corpus.push(project(matchInsurers(risk, rules)));
}

const json = JSON.stringify(corpus);
const sha256 = createHash("sha256").update(json).digest("hex");
if (sha256 !== BASELINE_SHA256) {
  throw new Error(`matcher differential changed: expected ${BASELINE_SHA256}, got ${sha256}`);
}
console.log(`ok - 500 baseline-vs-remediated matcher fixtures: 0 authoritative differences (${sha256})`);
