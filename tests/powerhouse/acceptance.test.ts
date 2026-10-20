/**
 * POWERHOUSE ACCEPTANCE BENCHMARK  —  `npm run test:powerhouse-acceptance`
 *
 * Fifteen synthetic, network-free cases that every later phase must keep
 * passing before it is allowed to change the underwriting brain. This is not a
 * unit test: each case is a whole recommendation, run through the REAL
 * endpoint (deriveRisk → matcher → evidence v2 → persisted row), then
 *
 *   1. observed into a compact record (order, score, rank, rule effects,
 *      referral/decline state, section outcomes, document outcomes, quality
 *      state, evidence schema, privacy result);
 *   2. compared with the case's committed `<id>.expected.json`;
 *   3. checked against hand-written INTENT assertions that do not come from
 *      the golden (so a regenerated golden cannot silently legitimise a bug);
 *   4. proven order-invariant: the same case with reversed and shuffled
 *      appetite rows must persist an identical row;
 *   5. compared with the FROZEN production v1 matcher
 *      (tests/powerhouse/reference/matcher-v1.reference.ts) and classified:
 *      identical | order_only | tie_rule. Anything else is a failure.
 *
 * Expected files are written once with POWERHOUSE_WRITE_EXPECTED=1 and
 * refuse to be overwritten without POWERHOUSE_REWRITE_EXPECTED=1.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { matchInsurers, type MatchResult } from "../../worker/src/matcher.js";
import { deriveRisk, resolveConfidenceProvenance } from "../../worker/src/recommendation-endpoints.js";
import type { RecommendationEvidenceV2 } from "../../worker/src/recommendation-evidence-v2.js";
import { matchInsurers as matchInsurersV1 } from "./reference/matcher-v1.reference.js";
import { caseIds, loadCase, loadExpected } from "./case-loader.js";
import { fixturePath, readJson } from "./fixture-loader.js";
import { getThroughHandler, runThroughHandler, type HarnessRun, type Row } from "./handler-harness.js";
import { classifyParity, type ParityClass } from "./parity.js";

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

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

const r4 = (n: number | null) => (n === null ? null : Math.round(n * 10_000) / 10_000);

export interface InsurerObservation {
  rank: number;
  score: number;
  band: string;
  rule_status: string;
  confidence: number | null;
  ruled_out: boolean;
  referral_required: boolean;
  manual_review_required: boolean;
  senior_review_required: boolean;
  scored_rule: string | null;
  selection_basis: string | null;
  /** matcher_component|effect|rule|score_contribution for every non-document rule evidence */
  rule_effects: string[];
  sections: { section: string; status: string; selected: string | null; outcome: string | null; reflected: boolean }[];
  /** Product lines implied when no cover section was declared (not requested sections). */
  implied_products: string[];
  /** Aspects in which the insurer-level tied rules differ (empty when equivalent or no tie). */
  tie_differences: string[];
  /** rule_id|listed_because|scored?|documents for every considered rule */
  considered: string[];
  omitted_risk_only: number;
  documents: { type: string; present: boolean; adjustment: number }[];
  quality: string;
  gaps: string[];
}

export interface Observation {
  evidence_schema: string;
  matcher_version: string;
  recommended: string | null;
  /** top, then secondary, then ruled out — as persisted in the compatibility columns */
  insurer_order: string[];
  insurers: Record<string, InsurerObservation>;
  no_data: string[];
  trusted_documents: string[];
  quality: {
    state: string;
    blockers: number;
    material: number;
    advisory: number;
    recommendation_gaps: string[];
  };
  privacy: { sentinel_hits: string[]; features_redacted: boolean };
}

function gapToken(g: RecommendationEvidenceV2["quality"]["gaps"][number]): string {
  return [
    `${g.code}:${g.severity}`,
    g.section_key ? `section=${g.section_key}` : "",
    g.rule_id ? `rule=${g.rule_id}` : "",
    g.field_path ? `field=${g.field_path}` : "",
    g.missing.length ? `missing=${g.missing.join("+")}` : "",
  ].filter(Boolean).join("|");
}

export function observe(row: Row, sentinels: string[] = []): Observation {
  const evidence = row.evidence_json as RecommendationEvidenceV2;
  const reasoning = row.reasoning_json as Row;
  const top = reasoning.top as Row | null;
  const secondary = (row.secondary_options_json as Row[]).map((item) => String(item.insurer_id));
  const ruledOut = (row.not_recommended_json as Row[]).map((item) => String(item.insurer_id));
  const insurers: Record<string, InsurerObservation> = {};
  const noData: string[] = [];
  for (const outcome of evidence.insurers) {
    if (outcome.status !== "scored") {
      noData.push(outcome.insurer_id);
      continue;
    }
    insurers[outcome.insurer_id] = {
      rank: outcome.rank,
      score: outcome.score,
      band: outcome.band,
      rule_status: outcome.rule_status,
      confidence: r4(outcome.confidence),
      ruled_out: outcome.ruled_out,
      referral_required: outcome.referral_required,
      manual_review_required: outcome.manual_review_required,
      senior_review_required: outcome.senior_review_required,
      scored_rule: outcome.selection.product_rule_id,
      selection_basis: outcome.selection.basis,
      rule_effects: outcome.rule_evidence
        .filter((item) => item.matcher_component !== "required_document")
        .map((item) => `${item.matcher_component}|${item.effect}|${item.rule_id}|${item.score_contribution}`),
      sections: outcome.section_evaluations.map((section) => ({
        section: section.section_key,
        status: section.status,
        selected: section.selected_rule_id,
        outcome: section.outcome,
        reflected: section.reflected_in_insurer_outcome,
      })),
      implied_products: outcome.implied_product_evaluations.map(
        (product) => `${product.section_key}=${product.outcome}${product.reflected_in_insurer_outcome ? "*" : ""}`
      ),
      tie_differences: [...outcome.selection.tie_differences],
      considered: outcome.considered_rules.map(
        (rule) =>
          `${rule.rule_id}|${rule.listed_because}|${rule.scored ? "scored" : "-"}|docs=${
            rule.required_documents === null ? "null" : rule.required_documents.join("+")
          }`
      ),
      omitted_risk_only: outcome.selection.omitted_risk_only_rule_count,
      documents: outcome.required_documents.map((doc) => ({
        type: doc.document_type,
        present: doc.present,
        adjustment: r4(doc.confidence_adjustment) as number,
      })),
      quality: outcome.quality.state,
      gaps: evidence.quality.gaps.filter((g) => g.insurer_id === outcome.insurer_id).map(gapToken),
    };
  }
  const serialised = JSON.stringify(row);
  const snapshot = (reasoning.matcher_input as Row).features as Row[];
  return {
    evidence_schema: evidence.schema_version,
    matcher_version: evidence.provenance.matcher_version,
    recommended: (row.recommended_insurer as string | null) ?? null,
    insurer_order: [...(top ? [String(top.insurer_id)] : []), ...secondary, ...ruledOut],
    insurers,
    no_data: noData,
    trusted_documents: evidence.trusted_documents.map((doc) => doc.document_type),
    quality: {
      state: evidence.quality.state,
      blockers: evidence.quality.blocker_count,
      material: evidence.quality.material_count,
      advisory: evidence.quality.advisory_count,
      recommendation_gaps: evidence.quality.gaps
        .filter((g) => g.scope === "recommendation" || g.scope === "reviewed_fact")
        .map(gapToken),
    },
    privacy: {
      sentinel_hits: sentinels.filter((sentinel) => serialised.includes(sentinel)),
      features_redacted:
        evidence.matcher_input.features.every((f) => f.value_retained === false) &&
        snapshot.every((f) => f.value_retained === false && !("text" in f)),
    },
  };
}
// ---------------------------------------------------------------------------
// Parity against the frozen production matcher (shared classifier: ./parity.ts)
// ---------------------------------------------------------------------------

function parityFor(caseInput: ReturnType<typeof loadCase>): { class: ParityClass; differing: string[] } {
  const { input } = caseInput;
  const availableDocs = (input.documents ?? [])
    .filter((doc) => doc.status === "active" && doc.scan_status === "clean")
    .map((doc) => doc.document_type);
  const confidence = resolveConfidenceProvenance(input.reviewed, {}, input.extractionConfidence ?? null);
  const risk = deriveRisk(input.reviewed, availableDocs, confidence.overall_confidence, confidence.overall_confidence_available);
  const active = caseInput.rules.filter((rule) => rule.is_active === true) as unknown as Parameters<typeof matchInsurers>[1];
  const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const v1 = matchInsurersV1(clone(risk), clone(active)) as unknown as MatchResult;
  const v2 = matchInsurers(clone(risk), clone(active));
  const portfolioRuleCounts = new Map<string, number>();
  for (const rule of active as unknown as { insurer_id: string; product_line: string; risk_type: string }[]) {
    if (rule.product_line.trim() === "*" && rule.risk_type.trim() === "*") {
      portfolioRuleCounts.set(rule.insurer_id, (portfolioRuleCounts.get(rule.insurer_id) ?? 0) + 1);
    }
  }
  return classifyParity(v1, v2, { portfolioRuleCounts });
}

// ---------------------------------------------------------------------------
// Row normalisation (ids and timestamps are the only non-semantic noise)
// ---------------------------------------------------------------------------

function normalisedRow(row: Row): string {
  const copy = JSON.parse(JSON.stringify(row)) as Row;
  delete copy.id;
  delete copy.created_at;
  const evidence = copy.evidence_json as Row | null;
  if (evidence) {
    const provenance = evidence.provenance as Row;
    delete provenance.recommendation_id;
    delete provenance.generated_at;
  }
  return JSON.stringify(copy);
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

async function runCase(id: string, rulesOrder?: (rules: Row[]) => Row[]): Promise<HarnessRun & { loaded: ReturnType<typeof loadCase> }> {
  const loaded = loadCase(id);
  const rules = rulesOrder ? rulesOrder(loaded.rules) : loaded.rules;
  const run = await runThroughHandler({ ...loaded.input, rules });
  assert(run.status === 200 && run.row, `${id}: handler run failed (${run.status} ${JSON.stringify(run.body)})`);
  return { ...run, loaded };
}

// ---------------------------------------------------------------------------
// Hand-written intent assertions (independent of the golden)
// ---------------------------------------------------------------------------

type Intent = (obs: Observation, run: HarnessRun & { loaded: ReturnType<typeof loadCase> }) => void;
const effects = (o: InsurerObservation) => o.rule_effects.map((entry) => entry.split("|")[1]);
const gapCodes = (o: InsurerObservation) => o.gaps.map((entry) => entry.split(":")[0]);

const INTENTS: Record<string, Intent> = {
  "case-01-single-section-baseline": (o) => {
    deepEq(o.insurer_order, ["insurer-alpha", "insurer-beta", "insurer-gamma", "insurer-delta"], "preferred > standard > caution > ruled out");
    deepEq(["insurer-alpha", "insurer-beta", "insurer-gamma", "insurer-delta"].map((id) => o.insurers[id].score), [100, 70, 30, 0], "v1 scores");
    eq(o.insurers["insurer-delta"].ruled_out, true, "declined level rules the insurer out");
    eq(o.quality.state, "decision_ready", "clean single-section recommendation");
    eq(o.quality.blockers + o.quality.material, 0, "no blocker or material gap");
  },
  "case-02-multi-section-compatible": (o) => {
    for (const id of ["insurer-alpha", "insurer-beta"]) {
      deepEq(o.insurers[id].sections.map((s) => s.status), ["evaluated", "evaluated"], `${id}: both sections evaluated`);
    }
    deepEq([o.insurers["insurer-alpha"].score, o.insurers["insurer-beta"].score], [100, 70], "single-rule v1 scores");
    eq(o.quality.state, "decision_ready", "nothing adverse");
    assert(Object.values(o.insurers).every((i) => gapCodes(i).every((c) => c === "section_outcome_not_scored")), "only the aggregation advisory");
    assert(Object.values(o.insurers).every((i) => i.selection_basis === "tie_broken_by_canonical_order"), "equal-quality rules tie");
  },
  "case-03-multi-section-preferred-plus-caution": (o) => {
    eq(o.insurers["insurer-alpha"].score, 100, "alpha keeps its v1 score");
    const git = o.insurers["insurer-alpha"].sections.find((s) => s.section === "goods_in_transit")!;
    eq(git.outcome, "caution", "caution is visible");
    eq(git.reflected, false, "…and is not in the score");
    assert(o.insurers["insurer-alpha"].gaps.some((g) => g.startsWith("section_caution_not_reflected:material")), "material gap");
    eq(o.quality.state, "caution", "caution state");
  },
  "case-04-multi-section-referral": (o) => {
    eq(o.insurers["insurer-alpha"].referral_required, false, "unreflected referral does not set the v1 flag");
    assert(o.insurers["insurer-alpha"].gaps.some((g) => g.startsWith("section_referral_not_reflected:material")), "but it is surfaced");
    eq(o.insurers["insurer-beta"].referral_required, true, "reflected referral sets the flag");
    eq(o.insurers["insurer-beta"].score, 62, "70 - 8");
    eq(o.quality.state, "caution", "caution");
  },
  "case-05-multi-section-hard-decline": (o) => {
    eq(o.insurers["insurer-alpha"].ruled_out, false, "alpha stays viable (v1)");
    eq(o.insurers["insurer-beta"].ruled_out, false, "beta stays viable (v1)");
    eq(o.insurers["insurer-gamma"].ruled_out, true, "gamma ruled out as in v1");
    for (const id of ["insurer-alpha", "insurer-beta"]) {
      assert(o.insurers[id].gaps.some((g) => g.startsWith("section_hard_decline_not_reflected:blocker")), `${id}: hidden hard decline is a blocker`);
      eq(o.insurers[id].quality, "incomplete", `${id}: incomplete`);
    }
    assert(o.insurers["insurer-gamma"].gaps.some((g) => g.startsWith("section_hard_decline_not_reflected:advisory")), "already ruled out: advisory");
    eq(o.quality.state, "incomplete", "recommendation incomplete");
    eq(o.quality.blockers, 2, "two blockers");
    eq(o.insurer_order[0], "insurer-alpha", "ranking itself is unchanged by the gate");
  },
  "case-06-ai-inferred-soft-decline": (o) => {
    const alpha = o.insurers["insurer-alpha"];
    eq(alpha.ruled_out, false, "AI-inferred signal never rules out");
    eq(alpha.referral_required, true, "referral required");
    eq(alpha.score, 60, "70 - 10");
    assert(alpha.rule_effects.some((e) => e.includes("|soft_decline_referral|") && e.endsWith("|-10")), "soft_decline_referral -10");
    for (const insurer of Object.values(o.insurers)) {
      assert(!effects(insurer).includes("hard_decline"), "no hard_decline anywhere");
      assert(insurer.sections.every((s) => s.outcome !== "hard_decline"), "no hard-decline section outcome");
      assert(gapCodes(insurer).every((c) => c !== "section_hard_decline_not_reflected"), "no hard-decline gap");
    }
    assert(o.insurers["insurer-beta"].gaps.some((g) => g.startsWith("section_soft_decline_not_reflected:material")), "beta: distinct soft-decline gap");
  },
  "case-07-required-document-missing": (o) => {
    const alpha = o.insurers["insurer-alpha"];
    eq(alpha.score, 100, "score unchanged");
    eq(alpha.confidence, 0.8, "confidence -0.10 for one missing document");
    deepEq(alpha.documents.map((d) => [d.type, d.present]), [["Claims history", true], ["Risk survey", false]], "document outcomes");
    eq(o.quality.state, "decision_ready", "advisory only");
  },
  "case-08-document-required-by-product-and-portfolio": (o, run) => {
    const alpha = o.insurers["insurer-alpha"];
    eq(alpha.documents.length, 1, "one canonical outcome");
    eq(alpha.confidence, 0.8, "one penalty, not two");
    const evidence = run.row!.evidence_json as RecommendationEvidenceV2;
    const outcome = evidence.insurers.find((i) => i.insurer_id === "insurer-alpha")!;
    assert(outcome.status === "scored", "scored");
    eq(outcome.required_documents[0].rule_evidence_ids.length, 2, "linked to BOTH the product and portfolio rule");
    eq(alpha.score, 70, "score unaffected");
    // Remediation R9: Policy schedule is trusted but is not what Alpha requires.
    assert(alpha.gaps.some((g) => g.startsWith("required_documents_unevidenced:material")), "nothing Alpha requires is evidenced");
    eq(o.quality.state, "caution", "an unrelated clean document does not make this reliance-ready");
  },
  "case-09-no-appetite-data-insurer": (o, run) => {
    deepEq(o.no_data, ["insurer-epsilon", "insurer-foxtrot"], "explicit no-data outcomes, sorted by name");
    const evidence = run.row!.evidence_json as RecommendationEvidenceV2;
    for (const outcome of evidence.insurers.filter((i) => i.status === "no_appetite_data")) {
      assert(outcome.status === "no_appetite_data", "no-data");
      eq(outcome.rank, null, "no rank");
      eq(outcome.score, null, "no score — not 0");
      eq(outcome.status_code, "no_active_appetite_data", "explicit code");
      assert(!("ruled_out" in outcome) && !("quality" in outcome), "no decline flag and no quality state");
    }
    deepEq(Object.keys(o.insurers), ["insurer-alpha"], "only the insurer with data is scored");
    eq(o.quality.state, "decision_ready", "no-data is a scope note");
  },
  "case-10-incomplete-provenance-locator": (o, run) => {
    assert(o.insurers["insurer-alpha"].gaps.includes("rule_source_locator_incomplete:advisory|rule=alpha-motor|missing=source_page+source_quote+source_section"), "alpha locator gap is advisory");
    assert(o.insurers["insurer-beta"].gaps.some((g) => g.startsWith("rule_source_document_missing:material|rule=beta-motor")), "beta: material");
    eq(o.quality.state, "caution", "caution");
    const evidence = run.row!.evidence_json as RecommendationEvidenceV2;
    const alpha = evidence.insurers.find((i) => i.insurer_id === "insurer-alpha");
    assert(alpha && alpha.status === "scored", "alpha");
    const rule = alpha.rule_evidence.find((r) => r.rule_id === "alpha-motor")!;
    deepEq([rule.source_page, rule.source_section, rule.source_quote], [null, null, null], "nothing invented");
    eq(rule.source_file_name, "alpha-guide.pdf", "what exists is preserved");
  },
  "case-11-tie-determinism": (o) => {
    deepEq(o.insurer_order, ["m-5", "z-1", "a-9"], "Gamma 100, then Alpha before Beta by NAME (ids sort the other way)");
    eq(o.insurers["m-5"].scored_rule, "r-gamma-motor", "canonical-first rule wins the tie");
    eq(o.insurers["m-5"].selection_basis, "tie_broken_by_canonical_order", "tie recorded");
    assert(o.insurers["m-5"].gaps.some((g) => g.startsWith("scored_rule_selection_tie:blocker")), "the tie that flips a decline is a blocker");
    eq(o.quality.state, "incomplete", "incomplete");
  },
  "case-12-privacy-sentinels": (o, run) => {
    deepEq(o.privacy.sentinel_hits, [], "no sentinel anywhere in the persisted row");
    eq(o.privacy.features_redacted, true, "features carry labels only");
    deepEq([o.insurers["insurer-alpha"].score, o.insurers["insurer-beta"].score], [100, 70], "recommendation unaffected by redaction");
    assert(run.loaded.file.sentinels!.length === 7, "all seven sentinel classes exercised");
  },
  "case-14-no-trusted-documents": (o) => {
    deepEq(o.trusted_documents, [], "nothing pending/infected/not_scanned/expired counts");
    assert(o.quality.recommendation_gaps.some((g) => g.startsWith("no_trusted_documents:material")), "material because something is required");
    eq(o.insurers["insurer-alpha"].confidence, 0.7, "0.9 - 2 x 0.10");
    eq(o.insurers["insurer-alpha"].score, 100, "score unchanged");
    eq(o.quality.state, "caution", "caution");
  },
  "case-15-trusted-clean-document": (o) => {
    deepEq(o.trusted_documents, ["Claims history"], "only active + exactly clean counts");
    deepEq(o.insurers["insurer-alpha"].documents.map((d) => [d.type, d.present]), [["Claims history", true]], "satisfied");
    eq(o.insurers["insurer-alpha"].confidence, 0.9, "no penalty");
    eq(o.quality.state, "decision_ready", "decision_ready");
  },

  // ---- Remediation cases ---------------------------------------------------
  "case-16-tie-score-contribution": (o) => {
    const alpha = o.insurers["insurer-alpha"];
    eq(alpha.score, 75, "legacy score is the canonical-first rule's");
    eq(alpha.scored_rule, "alpha-motor-a", "technical tie-break");
    deepEq(alpha.tie_differences, ["preferred_terms"], "the choice changes the score through preferred terms");
    assert(alpha.gaps.some((g) => g.startsWith("scored_rule_selection_tie:material")), "material, not hidden");
    assert(alpha.gaps.some((g) => g.startsWith("section_rule_conflict:material")), "section-level too");
    eq(alpha.quality, "caution", "no longer decision_ready");
    eq(o.insurers["insurer-beta"].quality, "decision_ready", "no tie, no gap");
    deepEq(o.insurer_order, ["insurer-alpha", "insurer-beta"], "ranking unchanged by the gate");
    eq(o.quality.state, "caution", "caution");
  },
  "case-17-tie-required-documents": (o) => {
    const alpha = o.insurers["insurer-alpha"];
    deepEq(alpha.tie_differences, ["required_documents"], "only the documents differ");
    assert(alpha.gaps.some((g) => g.startsWith("scored_rule_selection_tie:material")), "material");
    deepEq(alpha.considered, ["alpha-motor-a|scored_rule|scored|docs=Claims history", "alpha-motor-b|section_applicable|-|docs=Risk survey"], "each rule keeps its OWN documents");
    eq(alpha.confidence, 0.9, "the scored rule's document is present: no penalty");
    eq(alpha.score, 100, "score unchanged by the disclosure (100 base + 5, clamped)");
    eq(o.quality.state, "caution", "caution");
  },
  "case-18-multi-product-no-declared-sections": (o, run) => {
    const evidence = run.row!.evidence_json as RecommendationEvidenceV2;
    deepEq(evidence.requested_sections, [], "NO requested section is invented");
    const alpha = o.insurers["insurer-alpha"];
    deepEq(alpha.sections, [], "no section evaluations");
    deepEq(alpha.implied_products, ["commercial_motor=preferred*", "goods_in_transit=hard_decline"], "implied products evaluated, not scored together");
    eq(alpha.score, 100, "legacy score unchanged");
    eq(alpha.ruled_out, false, "NOT declined merely because sections were not declared");
    assert(alpha.gaps.some((g) => g.startsWith("implied_product_hard_decline_not_reflected:blocker")), "hidden hard decline is a blocker");
    assert(alpha.gaps.some((g) => g.startsWith("multiple_products_without_declared_sections:material")), "and the incompleteness is stated");
    eq(alpha.quality, "incomplete", "incomplete");
    const beta = o.insurers["insurer-beta"];
    assert(beta.gaps.some((g) => g.startsWith("multiple_products_without_declared_sections:material")), "beta: cannot claim a complete evaluation");
    eq(beta.quality, "caution", "caution, never decision_ready");
    assert(!o.insurers["insurer-gamma"].gaps.some((g) => g.startsWith("multiple_products")), "a single implied product raises nothing");
    eq(o.insurers["insurer-gamma"].quality, "decision_ready", "gamma decision_ready");
    assert(o.quality.recommendation_gaps.some((g) => g.startsWith("requested_sections_not_declared:advisory")), "scope note kept");
    eq(o.quality.state, "incomplete", "incomplete");
  },
  "case-19-material-risk-only-rule": (o) => {
    const alpha = o.insurers["insurer-alpha"];
    assert(alpha.considered.includes("alpha-cyber-transport|material_risk_only|-|docs="), "the material risk-only rule is surfaced");
    assert(!alpha.considered.some((c) => c.startsWith("alpha-marine-transport")), "the ordinary non-material loser is not listed");
    assert(!alpha.considered.some((c) => c.startsWith("alpha-cyber-technology")), "the rule matching neither product nor risk is not listed");
    eq(alpha.omitted_risk_only, 1, "exactly the plain marine loser is count-only");
    eq(alpha.score, 100, "legacy answer unchanged");
    eq(alpha.scored_rule, "alpha-motor", "same scored rule");
  },
  "case-20-section-preferred-portfolio-hard-decline": (o, run) => {
    const alpha = o.insurers["insurer-alpha"];
    eq(alpha.ruled_out, true, "overall: ruled out");
    deepEq(alpha.sections.map((s) => [s.outcome, s.reflected]), [["preferred", true]], "the section's own rule is preferred and reflected in section scoring");
    assert(alpha.rule_effects.some((e) => e.startsWith("portfolio_declined|hard_decline|alpha-portfolio")), "the decline is the PORTFOLIO rule's");
    eq(o.insurers["insurer-beta"].ruled_out, false, "beta unaffected");
    const evidence = run.row!.evidence_json as RecommendationEvidenceV2;
    const outcome = evidence.insurers.find((i) => i.insurer_id === "insurer-alpha")!;
    assert(outcome.status === "scored" && outcome.scored_against_rule_id === "alpha-portfolio", "ruled out against the portfolio rule");
  },
  "case-21-unrelated-clean-document": (o) => {
    deepEq(o.trusted_documents, ["Policy schedule"], "document trust unchanged");
    const alpha = o.insurers["insurer-alpha"];
    eq(alpha.confidence, 0.8, "confidence penalty unchanged");
    eq(alpha.score, 100, "score unchanged");
    assert(!o.quality.recommendation_gaps.some((g) => g.startsWith("no_trusted_documents")), "trusted evidence is not wholly absent");
    assert(alpha.gaps.some((g) => g.startsWith("required_documents_unevidenced:material")), "but nothing Alpha requires is evidenced");
    eq(alpha.quality, "caution", "caution");
    eq(o.insurers["insurer-beta"].quality, "decision_ready", "beta requires nothing");
    eq(o.quality.state, "caution", "NOT decision_ready");
  },
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const WRITE = process.env.POWERHOUSE_WRITE_EXPECTED === "1";
const REWRITE = process.env.POWERHOUSE_REWRITE_EXPECTED === "1";

interface Expected {
  expected_schema: "powerhouse-case-expected-v1";
  parity_vs_frozen_v1: { class: ParityClass; differing_insurers: string[] };
  observation: Observation;
}

for (const id of caseIds()) {
  test(`${id}`, async () => {
    const run = await runCase(id);
    const loaded = run.loaded;
    const obs = observe(run.row!, loaded.file.sentinels ?? []);

    // 1 + 2: observation versus the committed expectation.
    const parity = parityFor(loaded);
    const expectedPath = fixturePath(`cases/${id}.expected.json`);
    const next: Expected = {
      expected_schema: "powerhouse-case-expected-v1",
      parity_vs_frozen_v1: { class: parity.class, differing_insurers: parity.differing },
      observation: obs,
    };
    if (WRITE && (!existsSync(expectedPath) || REWRITE)) {
      writeFileSync(expectedPath, `${JSON.stringify(next, null, 2)}\n`);
      console.log(`  wrote ${id}.expected.json`);
    }
    const expected = loadExpected<Expected>(id);
    eq(expected.expected_schema, "powerhouse-case-expected-v1", "expected schema");
    deepEq(obs, expected.observation, "observation");
    deepEq(next.parity_vs_frozen_v1, expected.parity_vs_frozen_v1, "parity classification vs the frozen v1 matcher");

    // 3: intent assertions that do not come from the golden.
    const intent = INTENTS[id];
    assert(intent, `no intent assertions registered for ${id}`);
    intent(obs, run);

    // Persisted order and evidence ranks must agree.
    const ranked = Object.entries(obs.insurers).sort((a, b) => a[1].rank - b[1].rank).map(([key]) => key);
    deepEq(obs.insurer_order, ranked, "compatibility columns and evidence ranks agree");

    // 4: the same case with reversed and shuffled appetite rows persists the same row.
    const base = normalisedRow(run.row!);
    for (const [label, order] of [
      ["reversed", (rules: Row[]) => [...rules].reverse()],
      ["shuffle-1", (rules: Row[]) => shuffled(rules, 1)],
      ["shuffle-2", (rules: Row[]) => shuffled(rules, 2)],
    ] as const) {
      const variant = await runCase(id, order);
      eq(normalisedRow(variant.row!), base, `${id}: ${label} rows must persist an identical recommendation`);
    }

    // GET round trip returns exactly what was persisted.
    deepEq((await getThroughHandler(run.row!)).evidence_json, run.row!.evidence_json, "GET returns persisted evidence unchanged");
  });
}

// CASE 13 — historical evidence-v1 recommendations remain readable.
test("case-13-historical-evidence-v1 (stored v1 rows read back unchanged; v1 vocabulary is not rewritten)", async () => {
  for (const name of ["snapshots/historical-v1-complete.row.json", "snapshots/historical-v1-gaps.row.json"]) {
    const stored = readJson<Row>(name);
    const evidence = stored.evidence_json as Row;
    eq(evidence.schema_version, "recommendation-evidence-v1", `${name}: still v1`);
    const status = (evidence.quality as Row).status;
    assert(status === "complete" || status === "gaps_present", `${name}: v1 quality vocabulary preserved`);
    assert(!("state" in (evidence.quality as Row)), `${name}: not converted to v2 quality`);
    assert(!("scoring_scope" in evidence) && !("requested_sections" in evidence), `${name}: no fabricated v2 fields`);
    const got = await getThroughHandler(stored);
    deepEq(got.evidence_json, stored.evidence_json, `${name}: GET returns the stored packet verbatim`);
  }
  const nullRow: Row = { id: "old", submission_id: "11111111-1111-1111-1111-111111111111", reasoning_json: {}, evidence_json: null };
  eq((await getThroughHandler(nullRow)).evidence_json, null, "historical evidence_json = null stays null");
});

test("every case file has an expected file and an intent registered (no silent gaps in the benchmark)", () => {
  const ids = caseIds();
  eq(ids.length, 20, "14 original handler cases + 6 remediation cases (+ case 13, historical, which has no handler run)");
  for (const id of ids) {
    assert(existsSync(fixturePath(`cases/${id}.expected.json`)), `${id}: expected file`);
    assert(INTENTS[id], `${id}: intent`);
    const file = readFileSync(fixturePath(`cases/${id}.json`), "utf8");
    assert(file.includes('"intent"'), `${id}: intent documented in the case file`);
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
console.log(`\nPowerhouse acceptance benchmark: ${tests.length - failures} passed, ${failures} failed out of ${tests.length}`);
if (failures > 0) process.exitCode = 1;
