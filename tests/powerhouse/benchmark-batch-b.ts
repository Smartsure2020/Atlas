/**
 * Powerhouse Batch B — cost of completeness + contradiction analysis on a large
 * synthetic rule matrix. Not a pass/fail test: it prints a table so a reviewer can
 * judge production risk (`npm run benchmark:powerhouse-batch-b`).
 *
 * Batch 2 already made the matcher the dominant cost on large matrices, so the
 * question here is whether the new layers are noticeable next to it, and whether
 * they grow with facts + sources + relevant rules (linear) or with a Cartesian
 * product (not acceptable).
 */

import { performance } from "node:perf_hooks";
import { matchInsurers, MATCHER_VERSION, type MatchInputRisk } from "../../worker/src/matcher.js";
import type { AppetiteRow } from "../../worker/src/matcher-types.js";
import { assessCompleteness, readExtractionReportedMissing } from "../../worker/src/completeness.js";
import { analyseContradictions, collectObservations } from "../../worker/src/contradictions.js";
import { buildEvidenceBaseV2, buildRecommendationEvidenceV2 } from "../../worker/src/recommendation-evidence-v2.js";
import { buildRecommendationEvidenceV3 } from "../../worker/src/recommendation-evidence-v3.js";
import { assessQualityV3 } from "../../worker/src/recommendation-quality-v3.js";
import { TAXONOMY_VERSION } from "../../worker/src/taxonomy.js";

const PRODUCTS = ["commercial motor", "goods in transit", "public liability", "buildings", "contents", "business interruption", "cyber", "marine cargo"];
const RISKS = ["transport", "cargo", "property", "technology", "liability"];
const DOCS = Array.from({ length: 30 }, (_, i) => `Supporting document ${i + 1}`);

function matrix(insurers: number, rulesPerInsurer: number): AppetiteRow[] {
  const rows: AppetiteRow[] = [];
  for (let i = 0; i < insurers; i++) {
    for (let r = 0; r < rulesPerInsurer; r++) {
      const product = PRODUCTS[(i + r) % PRODUCTS.length].replace(/ /g, "_");
      const portfolio = r === rulesPerInsurer - 1;
      rows.push({
        id: `rule-${i}-${r}`, insurer_id: `insurer-${String(i).padStart(4, "0")}`, insurer_name: `Insurer ${i}`,
        product_line: portfolio ? "*" : product, risk_type: portfolio ? "*" : RISKS[(i + r) % RISKS.length],
        appetite_level: (["preferred", "standard", "caution", "standard"] as const)[(i + r) % 4],
        preferred_risks: ["transport fleet"], caution_risks: r % 3 === 0 ? ["medium"] : [], declined_risks: [],
        required_documents: [DOCS[(i * 3 + r) % DOCS.length], DOCS[(i * 3 + r + 7) % DOCS.length], DOCS[(i * 3 + r + 13) % DOCS.length]],
        referral_triggers: [], notes: null, source: "manual", source_document_id: `doc-${i}`, source_file_name: "guide.pdf",
        source_page: r + 1, source_section: "S", source_quote: "Q", is_active: true,
      });
    }
  }
  return rows;
}

function risk(sections: string[]): MatchInputRisk {
  return {
    product_candidates: sections, section_candidates: sections, risk_candidates: ["transport", "cargo", "liability"],
    features: Array.from({ length: 40 }, (_, i) => ({ text: i === 0 ? "transport fleet" : `feature ${i}`, source: `field ${i % 10}` })),
    available_documents: DOCS.slice(0, 10), overall_confidence: 0.9, overall_confidence_available: true,
  };
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function time<T>(runs: number, fn: () => T): { ms: number; result: T } {
  let result!: T;
  const samples: number[] = [];
  fn(); // warm-up
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    result = fn();
    samples.push(performance.now() - t);
  }
  return { ms: median(samples), result };
}

const SCENARIOS = [
  { insurers: 10, rules: 8, sections: 3 },
  { insurers: 50, rules: 12, sections: 5 },
  { insurers: 200, rules: 12, sections: 8 },
  { insurers: 400, rules: 16, sections: 8 },
];

console.log("Powerhouse Batch B — synthetic cost (median of 5, milliseconds; Node, not the Workers runtime)\n");
console.log("insurers rules sections |   matcher |  v2 build |  v3 build | completeness | contradictions | quality v3 |  Δ v3-v2 | packet KB (v2 → v3) | items");
for (const scenario of SCENARIOS) {
  const rules = matrix(scenario.insurers, scenario.rules);
  const sections = PRODUCTS.slice(0, scenario.sections);
  const riskInput = risk(sections);
  const reviewed = {
    missing_information: Array.from({ length: 50 }, (_, i) => ({ field: `free text ${i}`, priority: "low" })),
    broker: { email: { value: "doc@brokers.co.za", status: "extracted", confidence: 0.9 } },
  };
  const observations = collectObservations({ reviewed, extractionId: "e", intake: { status: "available", record: { broker_email: "intake@brokers.co.za" } } });
  const common = {
    recommendationId: "rec", submissionId: "sub", extractionId: "ext", reviewedAt: "2026-10-16T09:00:00.000Z",
    generatedAt: "2026-10-16T10:00:00.000Z", matcherVersion: MATCHER_VERSION, taxonomyVersion: TAXONOMY_VERSION,
    explanationMode: "deterministic", explanationSource: "deterministic", recommendationInputFingerprint: "fp",
  };
  const matched = time(5, () => matchInsurers(JSON.parse(JSON.stringify(riskInput)), rules));
  const input = { ...common, reviewed, matcherInput: riskInput, matcherResult: matched.result, activeAppetite: rules };
  const v2 = time(5, () => buildRecommendationEvidenceV2(input));
  const v3 = time(5, () => buildRecommendationEvidenceV3({ ...input, observations }));
  const base = buildEvidenceBaseV2(input);
  const cores = [...base.scored, ...base.noData];
  const reported = readExtractionReportedMissing(reviewed);
  const completeness = time(5, () => assessCompleteness({ requestedSections: base.requested_sections, insurers: cores, reported }));
  const contradictions = time(5, () => analyseContradictions({ observations }));
  const quality = time(5, () => assessQualityV3({
    facts: base.reviewed_risk_facts, insurers: cores, requestedSections: base.requested_sections,
    trustedDocumentCount: base.trusted_documents.length, completeness: completeness.result, contradictions: contradictions.result,
  }));
  const kb2 = JSON.stringify(v2.result).length / 1024;
  const kb3 = JSON.stringify(v3.result).length / 1024;
  const f = (n: number, w = 9) => n.toFixed(2).padStart(w);
  console.log(
    `${String(scenario.insurers).padStart(8)} ${String(scenario.rules).padStart(5)} ${String(scenario.sections).padStart(8)} |` +
      ` ${f(matched.ms)} | ${f(v2.ms)} | ${f(v3.ms)} | ${f(completeness.ms, 12)} | ${f(contradictions.ms, 14)} | ${f(quality.ms, 10)} | ${f(v3.ms - v2.ms, 8)} |` +
      ` ${kb2.toFixed(0).padStart(9)} → ${kb3.toFixed(0).padEnd(6)} | ${completeness.result.items.length}`
  );
}
