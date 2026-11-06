/**
 * Evidence Mode view model (lib/recommendation-evidence)
 * ----------------------------------------------------------------------------
 * Inputs are the REAL rows the backend produces for the Powerhouse acceptance
 * cases (tests/powerhouse/fixtures/snapshots, drift-checked by the Worker suite)
 * plus authentic historical v1 and null rows. The view model must display what
 * was recorded — never score, classify materiality, reconstruct or invent.
 */

import { describe, expect, it } from "vitest";
import { documentKey as workerDocumentKey } from "../../worker/src/matcher";
import { resolveSchemaFieldIdentity as workerResolveSchemaFieldIdentity, schemaFieldLabel as workerSchemaFieldLabel } from "../../worker/src/completeness";
import { SECTION_FIELDS } from "../../worker/src/extraction";
import {
  COMPLETENESS_NOT_CAPTURED_V1,
  COMPLETENESS_NOT_CAPTURED_V2,
  SHARED_SCHEMA_FIELD_LABELS,
  completenessView,
  contradictionsView,
  documentKey,
  insurerView,
  noDataInsurers,
  provenanceOf,
  recommendationQuality,
  resolveEvidence,
  scoreTies,
  trackedStateFor,
  type InsurerEvidenceView,
} from "../lib/recommendation-evidence";
import type { Recommendation } from "../lib/recommendations";

import case01 from "../../tests/powerhouse/fixtures/snapshots/case-01-single-section-baseline.row.json";
import case05 from "../../tests/powerhouse/fixtures/snapshots/case-05-multi-section-hard-decline.row.json";
import case06 from "../../tests/powerhouse/fixtures/snapshots/case-06-ai-inferred-soft-decline.row.json";
import case07 from "../../tests/powerhouse/fixtures/snapshots/case-07-required-document-missing.row.json";
import case08 from "../../tests/powerhouse/fixtures/snapshots/case-08-document-required-by-product-and-portfolio.row.json";
import case09 from "../../tests/powerhouse/fixtures/snapshots/case-09-no-appetite-data-insurer.row.json";
import case10 from "../../tests/powerhouse/fixtures/snapshots/case-10-incomplete-provenance-locator.row.json";
import case12 from "../../tests/powerhouse/fixtures/snapshots/case-12-privacy-sentinels.row.json";
import case14 from "../../tests/powerhouse/fixtures/snapshots/case-14-no-trusted-documents.row.json";
import histComplete from "../../tests/powerhouse/fixtures/snapshots/historical-v1-complete.row.json";
import histGaps from "../../tests/powerhouse/fixtures/snapshots/historical-v1-gaps.row.json";
import histNull from "../../tests/powerhouse/fixtures/snapshots/historical-null.row.json";
import case11 from "../../tests/powerhouse/fixtures/snapshots/case-11-tie-determinism.row.json";
import case17 from "../../tests/powerhouse/fixtures/snapshots/case-17-tie-required-documents.row.json";
import case18 from "../../tests/powerhouse/fixtures/snapshots/case-18-multi-product-no-declared-sections.row.json";
import case19 from "../../tests/powerhouse/fixtures/snapshots/case-19-material-risk-only-rule.row.json";
import case20 from "../../tests/powerhouse/fixtures/snapshots/case-20-section-preferred-portfolio-hard-decline.row.json";
import case21 from "../../tests/powerhouse/fixtures/snapshots/case-21-unrelated-clean-document.row.json";
import case22 from "../../tests/powerhouse/fixtures/snapshots/case-22-complete-single-section.row.json";
import case23 from "../../tests/powerhouse/fixtures/snapshots/case-23-required-fact-missing.row.json";
import case24 from "../../tests/powerhouse/fixtures/snapshots/case-24-required-document-missing-rule-provenance.row.json";
import case25 from "../../tests/powerhouse/fixtures/snapshots/case-25-one-insurer-complete-another-incomplete.row.json";
import case26 from "../../tests/powerhouse/fixtures/snapshots/case-26-section-without-applicable-rule.row.json";
import case27 from "../../tests/powerhouse/fixtures/snapshots/case-27-multiple-products-no-declared-sections-completeness.row.json";
import case28 from "../../tests/powerhouse/fixtures/snapshots/case-28-sources-agree.row.json";
import case29 from "../../tests/powerhouse/fixtures/snapshots/case-29-sources-disagree.row.json";
import case33 from "../../tests/powerhouse/fixtures/snapshots/case-33-identifier-genuine-mismatch.row.json";
import case40 from "../../tests/powerhouse/fixtures/snapshots/case-40-privacy-sentinels-completeness-contradictions.row.json";
import histV2Ready from "../../tests/powerhouse/fixtures/snapshots/historical-v2-decision-ready.row.json";
import histV2Incomplete from "../../tests/powerhouse/fixtures/snapshots/historical-v2-incomplete.row.json";
import { withInjectedProductComparison } from "../../tests/powerhouse/injected-comparison-fixture";

const row = (value: unknown) => value as unknown as Recommendation;
const evidenceOf = (value: unknown) => resolveEvidence(row(value).evidence_json);
const injectedContradiction = withInjectedProductComparison(case22);

function scored(value: unknown, insurerId: string): InsurerEvidenceView {
  const view = insurerView(evidenceOf(value), insurerId);
  if (!view || view.status !== "scored") throw new Error(`expected a scored view for ${insurerId}`);
  return view;
}

describe("resolveEvidence", () => {
  it("classifies absent, v1, v2, v3 and unsupported packets without throwing", () => {
    expect(resolveEvidence(null)).toEqual({ kind: "absent" });
    expect(resolveEvidence(undefined)).toEqual({ kind: "absent" });
    expect(evidenceOf(histNull)).toEqual({ kind: "absent" });
    expect(evidenceOf(histComplete)).toMatchObject({ kind: "ready", version: "v1" });
    // Historical v2 rows stay v2: they are never promoted to v3.
    expect(evidenceOf(histV2Ready)).toMatchObject({ kind: "ready", version: "v2" });
    expect(evidenceOf(histV2Incomplete)).toMatchObject({ kind: "ready", version: "v2" });
    // What the endpoint writes today.
    expect(evidenceOf(case05)).toMatchObject({ kind: "ready", version: "v3" });
  });

  it("an unknown schema version or a non-packet value is 'unsupported' and never throws", () => {
    const future = { schema_version: "recommendation-evidence-v9", insurers: [], provenance: {}, quality: {}, trusted_documents: [] };
    expect(resolveEvidence(future)).toEqual({ kind: "unsupported", schemaVersion: "recommendation-evidence-v9" });
    for (const junk of ["garbage", 42, true, [], {}, { schema_version: 2 }]) {
      expect(() => resolveEvidence(junk)).not.toThrow();
      expect(resolveEvidence(junk).kind).toBe("unsupported");
    }
  });

  it("a KNOWN schema version whose packet is hollow is 'malformed' (never repaired, never defaulted)", () => {
    expect(resolveEvidence({ schema_version: "recommendation-evidence-v3" })).toEqual({ kind: "malformed", schemaVersion: "recommendation-evidence-v3" });
    expect(resolveEvidence({ schema_version: "recommendation-evidence-v2" })).toEqual({ kind: "malformed", schemaVersion: "recommendation-evidence-v2" });
    expect(resolveEvidence({ schema_version: "recommendation-evidence-v1" })).toEqual({ kind: "malformed", schemaVersion: "recommendation-evidence-v1" });
    const hollow = { ...(row(case05).evidence_json as object) } as Record<string, unknown>;
    delete hollow.scoring_scope;
    expect(resolveEvidence(hollow).kind).toBe("malformed");
  });
  it("insurerView returns null for an insurer the packet does not describe (nothing fabricated)", () => {
    expect(insurerView(evidenceOf(case05), "insurer-unknown")).toBeNull();
    expect(insurerView({ kind: "absent" }, "insurer-alpha")).toBeNull();
  });
});

describe("v2 insurer evidence — displays what the matcher recorded", () => {
  it("copies score, rank and flags exactly; the view never recomputes them", () => {
    const packet = row(case05).evidence_json as unknown as { insurers: { insurer_id: string; rank: number; score: number }[] };
    for (const outcome of packet.insurers) {
      const view = scored(case05, outcome.insurer_id);
      expect(view.rank).toBe(outcome.rank);
      expect(view.score).toBe(outcome.score);
    }
    expect(scored(case05, "insurer-gamma").flags.ruledOut).toBe(true);
  });

  it("shows the hidden Goods in transit hard decline as an unreflected section and a blocker gap", () => {
    const alpha = scored(case05, "insurer-alpha");
    const git = alpha.sections!.find((s) => s.sectionKey === "goods_in_transit")!;
    expect(git.outcome).toBe("hard_decline");
    expect(git.reflected).toBe(false);
    expect(git.selectedRule?.ruleId).toBe("alpha-git");
    const blocker = alpha.gaps.find((g) => g.code === "section_hard_decline_not_reflected")!;
    expect(blocker.severity).toBe("blocker");
    expect(blocker.section).toBe("Goods in transit");
    expect(alpha.quality).toMatchObject({ mode: "v2", state: "incomplete", blockers: 1 });
    // The gate informs; it does not rewrite the ranking.
    expect(alpha.flags.ruledOut).toBe(false);
    expect(alpha.score).toBe(100);
  });

  it("an already-ruled-out insurer's hidden section decline is only advisory", () => {
    const gamma = scored(case05, "insurer-gamma");
    const gap = gamma.gaps.find((g) => g.code === "section_hard_decline_not_reflected")!;
    expect(gap.severity).toBe("advisory");
    expect(gamma.triggers.hardDeclines.length).toBeGreaterThan(0);
  });

  it("keeps an AI-inferred decline distinct from a hard decline", () => {
    const alpha = scored(case06, "insurer-alpha");
    expect(alpha.triggers.softDeclines).toHaveLength(1);
    expect(alpha.triggers.hardDeclines).toHaveLength(0);
    const soft = alpha.triggers.softDeclines[0];
    expect(soft.effectMeta.label).toMatch(/needs human confirmation/i);
    expect(soft.contribution).toBe(-10);
    expect(soft.terms).toEqual([{ term: "asbestos", source: "red flag [AI]" }]);
    expect(alpha.flags.referral).toBe(true);
    expect(alpha.flags.ruledOut).toBe(false);
  });

  it("pairs each insurer-owned term with its authoritative input source", () => {
    const alpha = scored(case01, "insurer-alpha");
    const base = alpha.rules.find((r) => r.component === "base")!;
    expect(base.contribution).toBe(100);
    expect(base.terms).toEqual([]);
    const preferred = alpha.rules.find((r) => r.component === "preferred")!;
    expect(preferred.contribution).toBe(5);
    expect(preferred.terms.length).toBeGreaterThan(0);
    for (const pair of preferred.terms) {
      expect(pair.term).toBe("transport fleet");
      expect(pair.source).toBeTruthy();
    }
  });

  it("separates present and missing required documents with the exact confidence effect", () => {
    const alpha = scored(case07, "insurer-alpha");
    expect(alpha.documents.present.map((d) => d.documentType)).toEqual(["Claims history"]);
    expect(alpha.documents.missing.map((d) => d.documentType)).toEqual(["Risk survey"]);
    expect(alpha.documents.missing[0].confidenceAdjustment).toBeCloseTo(-0.1, 10);
  });

  it("one document required by product AND portfolio rules is one line linked to both", () => {
    const alpha = scored(case08, "insurer-alpha");
    expect(alpha.documents.missing).toHaveLength(1);
    const kinds = alpha.documents.missing[0].requiredBy.map((r) => r.portfolio).sort();
    expect(kinds).toEqual([false, true]);
  });

  it("reports an empty trusted-document set as empty", () => {
    expect(scored(case14, "insurer-alpha").trustedDocuments).toEqual([]);
    expect(scored(case01, "insurer-alpha").trustedDocuments).toEqual(["Claims history"]);
  });

  it("states how the score is formed, from the persisted scoring scope", () => {
    expect(scored(case05, "insurer-alpha").scoringStatement).toMatch(/not combined into the score/i);
  });
});

describe("provenance — missing stays missing", () => {
  it("full provenance is complete and carries no missing labels", () => {
    const rule = scored(case01, "insurer-alpha").rules.find((r) => r.component === "preferred")!;
    expect(rule.provenance.complete).toBe(true);
    expect(rule.provenance.missing).toEqual([]);
    expect(rule.provenance.fileName).toBe("guide.pdf");
    expect(rule.provenance.page).toBe(4);
    expect(rule.provenance.quote).toBe("Synthetic guideline excerpt.");
  });

  it("an incomplete locator lists exactly what is absent and invents nothing", () => {
    const rule = scored(case10, "insurer-alpha").rules.find((r) => r.ruleId === "alpha-motor")!;
    expect(rule.provenance.complete).toBe(false);
    expect(rule.provenance.missing.sort()).toEqual(["page", "section", "source excerpt"]);
    expect(rule.provenance.page).toBeNull();
    expect(rule.provenance.section).toBeNull();
    expect(rule.provenance.quote).toBeNull();
    expect(rule.provenance.fileName).toBe("alpha-guide.pdf");
    expect(rule.provenance.documentId).toBe("doc-alpha");
  });

  it("a rule with no provenance at all reports every part missing", () => {
    const rule = scored(case10, "insurer-beta").rules.find((r) => r.ruleId === "beta-motor")!;
    expect(rule.provenance.missing.sort()).toEqual(["file name", "page", "section", "source document", "source excerpt"]);
    expect(rule.provenance.documentId).toBeNull();
    expect(rule.provenance.source).toBe("ai_extracted");
  });

  it("provenanceOf never defaults a value", () => {
    const p = provenanceOf({ source: null, source_document_id: null, source_file_name: null, source_page: null, source_section: null, source_quote: null });
    expect(p).toMatchObject({ documentId: null, fileName: null, page: null, section: null, quote: null, complete: false });
    expect(p.missing).toHaveLength(5);
  });
});

describe("no-data insurers", () => {
  it("are explicit: 'No active appetite data available', never a score or a decline", () => {
    const view = insurerView(evidenceOf(case09), "insurer-epsilon");
    expect(view).toEqual({
      status: "no_data",
      insurerId: "insurer-epsilon",
      insurerName: "Epsilon Insurance",
      message: "No active appetite data available",
    });
    expect(noDataInsurers(evidenceOf(case09)).map((i) => i.insurerName)).toEqual(["Epsilon Insurance", "Foxtrot Insurance"]);
    expect(JSON.stringify(view)).not.toMatch(/score|declin|rank/i);
  });
});

describe("historical evidence v1 — shown as recorded, never promoted", () => {
  it("v1 'complete': no sections/considered rules/severity are invented", () => {
    const view = scored(histComplete, "insurer-alpha");
    expect(view.version).toBe("v1");
    expect(view.sections).toBeNull();
    expect(view.considered).toBeNull();
    expect(view.selection).toBeNull();
    expect(view.scoringStatement).toBeNull();
    expect(view.quality).toEqual({ mode: "v1", status: "complete", gapCount: 0 });
    const quality = recommendationQuality(evidenceOf(histComplete))!;
    expect(quality).toMatchObject({ mode: "v1", state: null, legacyStatus: "complete" });
  });

  it("v1 'gaps_present': gaps are listed without a severity", () => {
    const quality = recommendationQuality(evidenceOf(histGaps))!;
    expect(quality.legacyStatus).toBe("gaps_present");
    expect(quality.gapCount).toBeGreaterThan(0);
    expect(quality.gaps.every((gap) => gap.severity === null)).toBe(true);
    expect(quality.state).toBeNull();
  });

  it("a null evidence_json yields no view and no recommendation quality", () => {
    expect(recommendationQuality(evidenceOf(histNull))).toBeNull();
    expect(insurerView(evidenceOf(histNull), "insurer-alpha")).toBeNull();
  });
});

describe("recommendation quality (v2) is displayed, not computed", () => {
  it("mirrors the persisted state and counts", () => {
    const packet = row(case05).evidence_json as unknown as { quality: { state: string; blocker_count: number; material_count: number; advisory_count: number; gaps: unknown[] } };
    const quality = recommendationQuality(evidenceOf(case05))!;
    expect(quality.state).toBe(packet.quality.state);
    expect([quality.blockers, quality.material, quality.advisory]).toEqual([packet.quality.blocker_count, packet.quality.material_count, packet.quality.advisory_count]);
    expect(quality.gapCount).toBe(packet.quality.gaps.length);
  });
});

describe("privacy of what the UI model exposes", () => {
  it("contains no client sentinel, storage path, signed URL or raw document body", () => {
    const sentinels = ["NAME_SENTINEL_9QX", "ID_SENTINEL_8QX", "PHONE_SENTINEL_7QX", "BANK_SENTINEL_6QX", "ADDRESS_SENTINEL_5QX", "POLICY_SENTINEL_4QX", "FREETEXT_SENTINEL_3QX"];
    const evidence = evidenceOf(case12);
    const all = ["insurer-alpha", "insurer-beta"].map((id) => insurerView(evidence, id));
    const text = JSON.stringify([all, recommendationQuality(evidence)]);
    for (const sentinel of sentinels) expect(text).not.toContain(sentinel);
    for (const forbidden of ["storage_path", "signed_url", "http://", "https://"]) expect(text).not.toContain(forbidden);
  });
});

// ---------------------------------------------------------------------------
// Remediation R6 — hollow packets fail safe at the parser boundary
// ---------------------------------------------------------------------------

type Mutator = (packet: any) => void;

function mutated(source: unknown, mutate: Mutator): unknown {
  const copy = JSON.parse(JSON.stringify((row(source) as { evidence_json: unknown }).evidence_json));
  mutate(copy);
  return copy;
}

const scoredIndex = (packet: any) => packet.insurers.findIndex((i: any) => i.status === "scored");

const HOLLOW_V2: [string, Mutator][] = [
  ["quality.gaps missing", (p) => { delete p.quality.gaps; }],
  ["quality.gaps not an array", (p) => { p.quality.gaps = "none"; }],
  ["quality.state invalid", (p) => { p.quality.state = "great"; }],
  ["quality block missing", (p) => { delete p.quality; }],
  ["insurer outcome without rule_evidence", (p) => { delete p.insurers[scoredIndex(p)].rule_evidence; }],
  ["insurer outcome without required_documents", (p) => { delete p.insurers[scoredIndex(p)].required_documents; }],
  ["insurer outcome without score_reconciliation", (p) => { delete p.insurers[scoredIndex(p)].score_reconciliation; }],
  ["insurer outcome without outcome_reasons", (p) => { delete p.insurers[scoredIndex(p)].outcome_reasons; }],
  ["insurer outcome without section_evaluations", (p) => { delete p.insurers[scoredIndex(p)].section_evaluations; }],
  ["insurer outcome without implied_product_evaluations", (p) => { delete p.insurers[scoredIndex(p)].implied_product_evaluations; }],
  ["insurer outcome without considered_rules", (p) => { delete p.insurers[scoredIndex(p)].considered_rules; }],
  ["insurer outcome without its own quality", (p) => { delete p.insurers[scoredIndex(p)].quality; }],
  ["insurer outcome without selection", (p) => { delete p.insurers[scoredIndex(p)].selection; }],
  ["score is a string", (p) => { p.insurers[scoredIndex(p)].score = "100"; }],
  ["insurer is null", (p) => { p.insurers[0] = null; }],
  ["insurer without status", (p) => { delete p.insurers[0].status; }],
  ["rule_evidence item without evidence_id", (p) => { delete p.insurers[scoredIndex(p)].rule_evidence[0].evidence_id; }],
  ["rule term not an object", (p) => { p.insurers[scoredIndex(p)].rule_evidence.find((r: any) => r.matched_rule_terms.length).matched_rule_terms[0] = "x"; }],
  ["considered rule without conditions", (p) => { delete p.insurers[scoredIndex(p)].considered_rules[0].conditions; }],
  ["considered rule without required_documents", (p) => { delete p.insurers[scoredIndex(p)].considered_rules[0].required_documents; }],
  ["section evaluation without tie_differences", (p) => { delete p.insurers[scoredIndex(p)].section_evaluations[0].tie_differences; }],
  ["section outcome is not a known outcome (misspelled)", (p) => { p.insurers[scoredIndex(p)].section_evaluations[0].outcome = "prefered"; }],
  ["gap without severity", (p) => { delete p.quality.gaps[0].severity; }],
  ["trusted_documents missing", (p) => { delete p.trusted_documents; }],
  ["provenance missing", (p) => { delete p.provenance; }],
  ["requested_sections missing", (p) => { delete p.requested_sections; }],
  ["scoring_scope missing", (p) => { delete p.scoring_scope; }],
];

// Everything v3 adds on top of v2. Applied to an injected engine contradiction
// because the production registry is intentionally empty.
const HOLLOW_V3_ONLY: [string, Mutator][] = [
  ["completeness missing", (p) => { delete p.completeness; }],
  ["completeness not an object", (p) => { p.completeness = "none"; }],
  ["completeness.items missing", (p) => { delete p.completeness.items; }],
  ["completeness.state invalid", (p) => { p.completeness.state = "mostly_complete"; }],
  ["completeness.insurers missing", (p) => { delete p.completeness.insurers; }],
  ["completeness.case_item_ids missing", (p) => { delete p.completeness.case_item_ids; }],
  ["contradictions missing", (p) => { delete p.contradictions; }],
  ["contradictions.comparisons missing", (p) => { delete p.contradictions.comparisons; }],
  ["contradictions.contradictions not an array", (p) => { p.contradictions.contradictions = {}; }],
  ["contradiction with a single value group (not a contradiction)", (p) => { p.contradictions.contradictions[0].value_groups.pop(); }],
  ["contradiction without value_groups", (p) => { delete p.contradictions.contradictions[0].value_groups; }],
  ["contradiction severity unknown", (p) => { p.contradictions.contradictions[0].severity = "blocker"; }],
  ["contradiction resolution state unknown", (p) => { p.contradictions.contradictions[0].resolution_state = "resolved"; }],
  ["contradiction source without a pointer", (p) => { delete p.contradictions.contradictions[0].value_groups[0].sources[0].pointer; }],
  ["quality gap without completeness_item_ids", (p) => { delete p.quality.gaps[0].completeness_item_ids; }],
  ["quality gap without contradiction_id", (p) => { delete p.quality.gaps[0].contradiction_id; }],
];

const HOLLOW_CASES: { label: string; base: unknown; schema: string }[] = [
  { label: "v2 (historical)", base: histV2Incomplete, schema: "recommendation-evidence-v2" },
  { label: "v3 (current)", base: case05, schema: "recommendation-evidence-v3" },
];

describe.each(HOLLOW_CASES)("R6 — hollow $label packets are 'malformed', never crash, and are never reconstructed", ({ base, schema }) => {
  it.each(HOLLOW_V2)("%s", (_label, mutate) => {
    const packet = mutated(base, mutate);
    let view: ReturnType<typeof resolveEvidence> | undefined;
    expect(() => { view = resolveEvidence(packet); }).not.toThrow();
    expect(view).toEqual({ kind: "malformed", schemaVersion: schema });
    // The malformed result carries no packet at all: nothing downstream can read half of it.
    expect(JSON.stringify(view)).not.toContain("insurer-alpha");
    expect(insurerView(view!, "insurer-alpha")).toBeNull();
    expect(recommendationQuality(view!)).toBeNull();
    expect(completenessView(view!)).toBeNull();
    expect(contradictionsView(view!)).toBeNull();
    expect(noDataInsurers(view!)).toEqual([]);
  });

  it("every contract section outcome (and null) is still accepted; only an unknown value is rejected", () => {
    for (const outcome of ["hard_decline", "soft_decline_referral", "referral", "caution", "preferred", "standard", null]) {
      const packet = mutated(base, (p) => { p.insurers[scoredIndex(p)].section_evaluations[0].outcome = outcome; });
      expect(resolveEvidence(packet).kind).toBe("ready");
    }
    for (const bad of ["prefered", "Preferred", "", "ruled_out", 1, {}]) {
      const packet = mutated(base, (p) => { p.insurers[scoredIndex(p)].section_evaluations[0].outcome = bad; });
      expect(resolveEvidence(packet)).toEqual({ kind: "malformed", schemaVersion: schema });
    }
  });
});

describe("R6 (Batch B) — hollow v3 analyses are 'malformed' and a v2 packet is never held to v3 rules", () => {
  it.each(HOLLOW_V3_ONLY)("%s", (_label, mutate) => {
    const packet = mutated(injectedContradiction, mutate);
    let view: ReturnType<typeof resolveEvidence> | undefined;
    expect(() => { view = resolveEvidence(packet); }).not.toThrow();
    expect(view).toEqual({ kind: "malformed", schemaVersion: "recommendation-evidence-v3" });
    expect(completenessView(view!)).toBeNull();
    expect(contradictionsView(view!)).toBeNull();
  });

  it("the unmutated contradiction packet is accepted", () => {
    expect(evidenceOf(injectedContradiction)).toMatchObject({ kind: "ready", version: "v3" });
  });

  it("a v2 packet does not need completeness or contradictions to be readable", () => {
    const withoutAnalyses = mutated(histV2Incomplete, () => undefined) as Record<string, unknown>;
    expect("completeness" in withoutAnalyses || "contradictions" in withoutAnalyses).toBe(false);
    expect(resolveEvidence(withoutAnalyses)).toMatchObject({ kind: "ready", version: "v2" });
  });

  it("a v3 schema label does not rescue a v2-shaped packet (no analyses => malformed, not silently v2)", () => {
    const relabelled = mutated(histV2Incomplete, (p) => { p.schema_version = "recommendation-evidence-v3"; });
    expect(resolveEvidence(relabelled)).toEqual({ kind: "malformed", schemaVersion: "recommendation-evidence-v3" });
  });
});

describe("R6 — unmutated packets and the other hollow-packet nets", () => {
  it("the unmutated packet is accepted (the guards do not reject good data)", () => {
    for (const source of [case01, case05, case06, case07, case08, case09, case10, case11, case12, case14, case17, case18, case19, case20, case21, case22, case23, case24, case25, case26, case27, case28, case29, case33, case40, histV2Ready, histV2Incomplete]) {
      expect(resolveEvidence((row(source) as { evidence_json: unknown }).evidence_json).kind).toBe("ready");
    }
  });

  it("hollow v1 packets are malformed too; genuine historical v1 and null stay readable", () => {
    expect(resolveEvidence(mutated(histComplete, (p) => { delete p.quality.status; })).kind).toBe("malformed");
    expect(resolveEvidence(mutated(histComplete, (p) => { delete p.insurers[0].rule_evidence; })).kind).toBe("malformed");
    expect(resolveEvidence(mutated(histGaps, (p) => { p.quality.gaps = [{ code: 1 }]; })).kind).toBe("malformed");
    expect(evidenceOf(histComplete)).toMatchObject({ kind: "ready", version: "v1" });
    expect(evidenceOf(histGaps)).toMatchObject({ kind: "ready", version: "v1" });
    expect(evidenceOf(histNull)).toEqual({ kind: "absent" });
  });

  it.each([
    ["v3 with an injected contradiction", injectedContradiction],
    ["v3 with completeness items", case18],
    ["historical v2", histV2Incomplete],
  ])("randomised damage (500 single-field deletions anywhere in the packet) never throws — %s", (_label, source) => {
    const base = JSON.parse(JSON.stringify((row(source) as { evidence_json: unknown }).evidence_json));
    const paths: (string | number)[][] = [];
    const walk = (value: unknown, path: (string | number)[]) => {
      if (value && typeof value === "object") {
        for (const key of Object.keys(value as object)) {
          paths.push([...path, key]);
          walk((value as Record<string, unknown>)[key], [...path, key]);
        }
      }
    };
    walk(base, []);
    let seed = 12345;
    for (let i = 0; i < 500; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const path = paths[seed % paths.length];
      const copy = JSON.parse(JSON.stringify(base));
      let cursor = copy;
      for (const key of path.slice(0, -1)) cursor = cursor[key];
      delete cursor[path[path.length - 1]];
      expect(() => {
        const view = resolveEvidence(copy);
        if (view.kind === "ready") {
          for (const o of copy.insurers) insurerView(view, o.insurer_id);
          completenessView(view);
          contradictionsView(view);
        }
      }).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// Remediation R3 / R4 / R5 / R7 / R8 / R9 — what the view model carries
// ---------------------------------------------------------------------------

describe("R3 — a tied rule's own required documents are shown", () => {
  it("each considered rule keeps its own documents; the tie names what differs", () => {
    const alpha = scored(case17, "insurer-alpha");
    expect(alpha.considered!.map((r) => [r.ruleId, r.requiredDocuments])).toEqual([
      ["alpha-motor-a", ["Claims history"]],
      ["alpha-motor-b", ["Risk survey"]],
    ]);
    const section = alpha.sections![0];
    expect(section.tiedDisagree).toBe(true);
    expect(section.tieDifferences).toEqual(["required documents"]);
    expect(alpha.selection!.tie_differences).toEqual(["required_documents"]);
  });
});

describe("R4 — undeclared sections with several products", () => {
  it("shows implied products separately; no requested section is invented", () => {
    const alpha = scored(case18, "insurer-alpha");
    expect(alpha.sections).toEqual([]);
    expect(alpha.impliedProducts!.map((p) => [p.section, p.outcome, p.reflected])).toEqual([
      ["commercial_motor", "preferred", true],
      ["goods_in_transit", "hard_decline", false],
    ]);
    expect(alpha.gaps.map((g) => g.code)).toEqual(
      expect.arrayContaining(["implied_product_hard_decline_not_reflected", "multiple_products_without_declared_sections"])
    );
    expect(alpha.gaps.find((g) => g.code === "implied_product_hard_decline_not_reflected")!.section).toBe("goods_in_transit");
    expect(recommendationQuality(evidenceOf(case18))!.state).toBe("incomplete");
    // A single implied product: nothing is produced.
    expect(scored(case18, "insurer-gamma").impliedProducts).toEqual([]);
  });
  it("v1 has no implied-product data: null means 'not captured'", () => {
    expect(scored(histComplete, "insurer-alpha").impliedProducts).toBeNull();
  });
});

describe("R5 — a material risk-only rule is listed with why", () => {
  it("lists it as material_risk_only and keeps the plain loser count-only", () => {
    const alpha = scored(case19, "insurer-alpha");
    const listed = alpha.considered!.find((r) => r.ruleId === "alpha-cyber-transport")!;
    expect(listed.listedBecause).toBe("material_risk_only");
    expect(listed.conditions.map((c) => c.kind)).toEqual(["caution"]);
    expect(alpha.considered!.some((r) => r.ruleId === "alpha-marine-transport")).toBe(false);
    expect(alpha.selection!.omitted_risk_only_rule_count).toBe(1);
  });
});

describe("R7 — equal-score ranks are disclosed", () => {
  it("names the viable insurers that share a score; a unique score has none", () => {
    expect(scored(case11, "z-1").tiedScoreWith).toEqual(["Beta Mutual"]);
    expect(scored(case11, "a-9").tiedScoreWith).toEqual(["Alpha Mutual"]);
    expect(scored(case11, "m-5").tiedScoreWith).toEqual([]);
    const ties = scoreTies(evidenceOf(case11));
    expect(ties).toHaveLength(1);
    expect(ties[0].score).toBe(70);
    expect([...ties[0].insurers].sort()).toEqual(["Alpha Mutual", "Beta Mutual"]);
  });
  it("ruled-out insurers are never 'tied' (ruling out is itself a business distinction)", () => {
    expect(scoreTies(evidenceOf(case05))).toEqual([]);
    expect(scored(case05, "insurer-gamma").tiedScoreWith).toEqual([]);
  });
});

describe("R8 — the section rule outcome and the insurer's overall outcome are separate", () => {
  it("a preferred section under a portfolio hard decline reports both truths", () => {
    const alpha = scored(case20, "insurer-alpha");
    expect(alpha.sections!.map((s) => [s.outcome, s.reflected])).toEqual([["preferred", true]]);
    expect(alpha.overall).toEqual({ ruledOut: true, reason: "a portfolio-level rule declines this risk" });
    expect(scored(case20, "insurer-beta").overall).toEqual({ ruledOut: false, reason: null });
  });
  it("a hard decline on the scored rule or its level reads accordingly", () => {
    expect(scored(case05, "insurer-gamma").overall.reason).toBe("a declined-risk term matched the rule that set this insurer's score");
    expect(scored(case01, "insurer-delta").overall.reason).toBe("the rule that set this insurer's score is declined");
  });
});

describe("R9 — relevant trusted documents", () => {
  it("an unrelated clean document leaves the required-document gap standing", () => {
    const alpha = scored(case21, "insurer-alpha");
    expect(alpha.trustedDocuments).toEqual(["Policy schedule"]);
    const gap = alpha.gaps.find((g) => g.code === "required_documents_unevidenced")!;
    expect(gap.severity).toBe("material");
    expect(gap.copy.title).toBe("None of this insurer's required documents is evidenced");
    expect(gap.missing).toEqual(["trusted_required_document"]);
    expect(recommendationQuality(evidenceOf(case21))!.state).toBe("caution");
  });
});

// ---------------------------------------------------------------------------
// Batch B — completeness ("what Atlas still needs") and contradictions ("conflicts
// to review"). The view model attaches wording and groups what the Worker already
// decided; it never decides what is missing or what conflicts.
// ---------------------------------------------------------------------------

function captured<T extends { mode: string }>(view: T | null): Extract<T, { mode: "captured" }> {
  if (!view || view.mode !== "captured") throw new Error("expected a captured analysis");
  return view as Extract<T, { mode: "captured" }>;
}

describe("Batch B — completeness view", () => {
  it("a complete case lists nothing outstanding and names every insurer as complete", () => {
    const view = captured(completenessView(evidenceOf(case22)));
    expect(view.state).toBe("complete");
    expect([view.caseLines, view.documentLines, view.insurerGroups]).toEqual([[], [], []]);
    expect(view.completeInsurers.sort()).toEqual(["Alpha Insurance", "Beta Insurance"]);
    expect(view.basis.join(" ")).toMatch(/no universal insurance requirement/i);
  });

  it("one logical document is ONE line across insurers, with every requiring rule and its scope", () => {
    const view = captured(completenessView(evidenceOf(case24)));
    expect(view.documentLines).toHaveLength(1);
    const [doc] = view.documentLines;
    expect(doc.documentType).toBe("Risk survey");
    expect(doc.materiality).toBe("material");
    expect(doc.insurers.map((i) => i.insurerName)).toEqual(["Alpha Insurance", "Beta Insurance"]);
    expect(doc.requiredBy).toEqual([
      "Alpha Insurance's product rule — not evidenced",
      "Alpha Insurance's portfolio rule — not evidenced",
      "Beta Insurance's product rule — not evidenced",
    ]);
    expect(doc.basis).toMatch(/clean-scanned/i);
    expect(doc.tracking).toMatchObject({ title: "Risk survey", type: "document" });
  });

  it("insurers are grouped worst first; a complete insurer is named, not listed", () => {
    const view = captured(completenessView(evidenceOf(case25)));
    expect(view.insurerGroups.map((g) => [g.insurerName, g.state])).toEqual([
      ["Beta Insurance", "incomplete_material"],
      ["Gamma Insurance", "incomplete_nonblocking"],
    ]);
    expect(view.completeInsurers).toEqual(["Alpha Insurance"]);
    // Documents are listed once, in the documents block — not repeated per insurer.
    expect(view.insurerGroups.every((g) => g.lines.length === 0)).toBe(true);
    expect(view.documentLines.map((l) => l.documentType)).toEqual(["Financial statements"]);
  });

  it("a section with no applicable rule is material for a viable insurer and nonblocking once ruled out", () => {
    const view = captured(completenessView(evidenceOf(case26)));
    const byInsurer = Object.fromEntries(view.insurerGroups.map((g) => [g.insurerName, g.lines.map((l) => [l.copy.title, l.materiality, l.sections])]));
    expect(byInsurer["Alpha Insurance"]).toEqual([["A requested section has no applicable rule", "material", ["Cyber"]]]);
    expect(byInsurer["Beta Insurance"]).toEqual([["A requested section has no applicable rule", "nonblocking", ["Cyber"]]]);
    expect(view.completeInsurers).toEqual(["Gamma Insurance"]);
  });

  it("undeclared sections are a case-level limitation; nothing is invented", () => {
    const view = captured(completenessView(evidenceOf(case27)));
    expect(view.caseLines.map((l) => l.code)).toEqual(["requested_sections_not_declared"]);
    expect(view.caseLines[0].materiality).toBe("nonblocking");
    expect(view.insurerGroups.map((g) => [g.insurerName, g.stateMeta.label])).toEqual([
      ["Alpha Insurance", "Material information outstanding"],
      ["Beta Insurance", "Information outstanding"],
    ]);
    expect((evidenceOf(case27) as { evidence: { requested_sections: unknown[] } }).evidence.requested_sections).toEqual([]);
  });

  it("reported facts keep position and priority; free text never appears; effect is not claimed", () => {
    const view = captured(completenessView(evidenceOf(case23)));
    expect(view.caseLines).toHaveLength(3);
    const labelled = view.caseLines.filter((l) => l.fieldLabel);
    expect(labelled.map((l) => [l.fieldLabel, l.fieldPath])).toEqual([["Registration or ID number", "extracted_client.registration_or_id_number"]]);
    expect(view.caseLines.every((l) => l.affects === "Atlas cannot tell whether this changes the outcome.")).toBe(true);
    expect(view.caseLines.map((l) => l.requiredBy[0])).toEqual(
      expect.arrayContaining([
        "The extraction reported an item as outstanding (high priority)",
        "The extraction reported item 2 as outstanding (medium priority)",
        "The extraction reported item 4 as outstanding (low priority)",
      ])
    );
    const text = JSON.stringify(view);
    for (const sentinel of ["REASON_SENTINEL_23A", "FREETEXT_SENTINEL_23B", "FREETEXT_SENTINEL_23C"]) expect(text).not.toContain(sentinel);
  });

  it("every completeness line points at quality gaps that exist in the same packet (stable ids)", () => {
    for (const source of [case24, case25, case26, case27, case23]) {
      const evidence = evidenceOf(source);
      const view = captured(completenessView(evidence));
      const gapIds = new Set(recommendationQuality(evidence)!.gaps.map((g) => g.gapId));
      const lines = [...view.caseLines, ...view.documentLines, ...view.insurerGroups.flatMap((g) => g.lines)];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.qualityGapIds.length).toBeGreaterThan(0);
        for (const id of line.qualityGapIds) expect(gapIds.has(id)).toBe(true);
      }
    }
  });
});

describe("Batch B — contradictions view", () => {
  it("an injected engine registry produces one unresolved material cluster without source precedence", () => {
    const view = captured(contradictionsView(evidenceOf(withInjectedProductComparison(case22))));
    expect(view.conflicts).toHaveLength(1);
    const [conflict] = view.conflicts;
    expect(conflict.title).toBe("Atlas found conflicting recorded values");
    expect(conflict.groups).toHaveLength(2);
    expect(conflict.groups.map((g) => g.display).sort()).toEqual(["motor", "property"]);
    expect(conflict.groups.map((g) => g.reference)).toEqual(["A", "B"]);
    expect(conflict.groups.flatMap((g) => g.sources.map((s) => s.label)).sort()).toEqual(["Synthetic source A", "Synthetic source B"]);
    expect(conflict.severity).toBe("material");
    expect(conflict.affectsMatcher).toBe(true);
    expect(conflict.matcherNote).toMatch(/could have affected the recommendation/i);
    expect(conflict.resolution.state).toBe("unresolved");
    expect(view.precedenceStatement).toMatch(/does not say which one is correct/i);
  });

  it("never uses accusatory wording", () => {
    const text = JSON.stringify([contradictionsView(evidenceOf(withInjectedProductComparison(case22))), contradictionsView(evidenceOf(case40))]);
    expect(text).not.toMatch(/fraud|false information|misrepresent|lied|dishonest|untruth/i);
  });

  it("injected agreement is reported as agreement, not as a conflict", () => {
    const view = captured(contradictionsView(evidenceOf(withInjectedProductComparison(case22, "motor"))));
    expect(view.conflicts).toEqual([]);
    expect(view.agreedLabels).toEqual(["Product line"]);
    expect(view.comparedCount).toBe(1);
  });

  it("ordinal references distinguish groups without a value-derived digest", () => {
    const [conflict] = captured(contradictionsView(evidenceOf(withInjectedProductComparison(case22)))).conflicts;
    expect(conflict.groups.map((g) => g.reference)).toEqual(["A", "B"]);
    expect(JSON.stringify(conflict)).not.toContain("value_digest");
  });

  it("when nothing could be compared the view says so instead of claiming consistency", () => {
    const view = captured(contradictionsView(evidenceOf(case22)));
    expect(view.comparedCount).toBe(0);
    expect(view.conflicts).toEqual([]);
  });

  it("the quality gap and the contradiction reference each other", () => {
    const evidence = evidenceOf(withInjectedProductComparison(case22));
    const [conflict] = captured(contradictionsView(evidence)).conflicts;
    const gap = recommendationQuality(evidence)!.gaps.find((g) => g.code === "conflicting_recorded_values")!;
    expect(gap.contradictionId).toBe(conflict.id);
    expect(gap.gapId).toBe(conflict.qualityGapId);
    expect(gap.severity).toBe("material");
  });

  it("privacy: no sentinel, raw address or free text survives into either view", () => {
    const text = JSON.stringify([completenessView(evidenceOf(case40)), contradictionsView(evidenceOf(case40))]);
    for (const needle of ["sentinel", "MISSING_TEXT_SENTINEL_40", "REASON_TEXT_SENTINEL_40", "CONFLICT_TEXT_SENTINEL_40"]) {
      expect(text.toLowerCase()).not.toContain(needle.toLowerCase());
    }
    expect(text).not.toMatch(/[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]+/i);
  });
});

describe("Batch B — historical packets are never promoted or reconstructed", () => {
  it("v1 and v2 report 'not captured' with the specified wording", () => {
    expect(completenessView(evidenceOf(histComplete))).toEqual({ mode: "not_captured", version: "v1", message: COMPLETENESS_NOT_CAPTURED_V1 });
    expect(contradictionsView(evidenceOf(histGaps))).toEqual({ mode: "not_captured", version: "v1", message: COMPLETENESS_NOT_CAPTURED_V1 });
    expect(completenessView(evidenceOf(histV2Ready))).toEqual({ mode: "not_captured", version: "v2", message: COMPLETENESS_NOT_CAPTURED_V2 });
    expect(contradictionsView(evidenceOf(histV2Incomplete))).toEqual({ mode: "not_captured", version: "v2", message: COMPLETENESS_NOT_CAPTURED_V2 });
    expect(COMPLETENESS_NOT_CAPTURED_V1).toBe("Completeness and contradiction analysis was not captured for this historical recommendation.");
    expect(COMPLETENESS_NOT_CAPTURED_V2).toBe("This recommendation predates deterministic completeness and contradiction analysis.");
  });

  it("a null evidence_json has no completeness or contradiction view at all", () => {
    expect(completenessView(evidenceOf(histNull))).toBeNull();
    expect(contradictionsView(evidenceOf(histNull))).toBeNull();
  });

  it("a historical v2 packet's gaps carry no fabricated links", () => {
    const quality = recommendationQuality(evidenceOf(histV2Incomplete))!;
    expect(quality.gaps.length).toBeGreaterThan(0);
    expect(quality.gaps.every((g) => g.completenessItemIds.length === 0 && g.contradictionId === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Batch B — joining detected items to the Missing Information workspace
// ---------------------------------------------------------------------------

describe("Batch B — document key parity and the tracked-state join", () => {
  it("the frontend document key is the matcher's document key (same corpus, same answer)", () => {
    const corpus = ["Risk survey", "risk-survey", "RISK_SURVEY", "  Risk   Survey ", "Claims history", "claims_history ", "Policy-schedule (2026)", "", "   ", "A  -  B"];
    for (const label of corpus) expect(documentKey(label)).toBe(workerDocumentKey(label));
  });

  const viewOf = (source: unknown) => captured(completenessView(evidenceOf(source)));
  const lineOf = (source: unknown, predicate: (l: { code: string; documentType: string | null }) => boolean) => {
    const view = viewOf(source);
    const all = [...view.caseLines, ...view.documentLines, ...view.insurerGroups.flatMap((g) => g.lines)];
    const line = all.find(predicate);
    if (!line) throw new Error("line not found");
    return line;
  };

  it("a document matches an existing item on the canonical key, however it was spelled or derived", () => {
    const line = lineOf(case24, (l) => l.code === "required_document_missing");
    expect(trackedStateFor(line, [])).toEqual({ state: "untracked" });
    for (const title of ["Risk survey", "risk-survey", "RISK_SURVEY", "  risk   survey "]) {
      expect(trackedStateFor(line, [{ item_type: "document", title, status: "requested" }])).toMatchObject({ state: "tracked_open", status: "requested" });
    }
    // Same name but a different kind of item is a different thing.
    expect(trackedStateFor(line, [{ item_type: "quote_term", title: "Risk survey", status: "open" }])).toEqual({ state: "untracked" });
    // A different document never matches.
    expect(trackedStateFor(line, [{ item_type: "document", title: "Claims history", status: "open" }])).toEqual({ state: "untracked" });
  });

  it("open beats closed; all-closed reads as closed; the status is the item's own", () => {
    const line = lineOf(case24, (l) => l.code === "required_document_missing");
    expect(trackedStateFor(line, [
      { item_type: "document", title: "Risk survey", status: "received" },
      { item_type: "document", title: "risk survey", status: "open" },
    ])).toMatchObject({ state: "tracked_open", status: "open", count: 2 });
    expect(trackedStateFor(line, [{ item_type: "document", title: "Risk survey", status: "waived" }])).toMatchObject({ state: "tracked_closed", status: "waived" });
  });

  it("only requests a broker can act on are trackable; internal limitations never are", () => {
    expect(lineOf(case24, (l) => l.code === "required_document_missing").tracking).toMatchObject({ trackable: true, owner: "broker", type: "document" });
    expect(lineOf(case27, (l) => l.code === "requested_sections_not_declared").tracking).toMatchObject({ trackable: true, title: "Cover sections required", owner: "broker" });
    const labelled = lineOf(case23, (l) => l.code === "extraction_reported_information_missing" && l.documentType === null);
    const all = captured(completenessView(evidenceOf(case23))).caseLines;
    expect(all.filter((l) => l.tracking.trackable).map((l) => l.tracking.title)).toEqual(["Registration or ID number"]);
    expect(labelled.tracking.trackable).toBeDefined();
    for (const l of captured(completenessView(evidenceOf(case26))).insurerGroups.flatMap((g) => g.lines)) expect(l.tracking.trackable).toBe(false);
    for (const l of captured(completenessView(evidenceOf(case27))).insurerGroups.flatMap((g) => g.lines)) expect(l.tracking.trackable).toBe(false);
  });

  it("a non-trackable line is never reported as tracked", () => {
    const line = captured(completenessView(evidenceOf(case26))).insurerGroups[0].lines[0];
    expect(trackedStateFor(line, [{ item_type: "other", title: line.tracking.title, status: "open" }])).toEqual({ state: "untracked" });
  });

  it("tracking titles are free of values and identifiers", () => {
    const view = captured(completenessView(evidenceOf(case40)));
    const text = JSON.stringify([...view.caseLines, ...view.documentLines].map((l) => l.tracking));
    expect(text.toLowerCase()).not.toContain("sentinel");
    expect(text).not.toMatch(/cmp:|gap:|ctr:/);
  });
});

// ---------------------------------------------------------------------------
// Batch B — a shared schema label can never prove WHICH path a tracked row is for
// ---------------------------------------------------------------------------

describe("Batch B — ambiguous schema labels never prove tracked state", () => {
  // A tracked row carries only its title. Several extraction paths share one label, so
  // for those the title alone cannot say which path the row was tracked for. The server
  // refuses to map such a title to a path (see detected-missing-info.ts); the display
  // join must not claim more than the server does.
  const SHARED_PATHS = [
    "extracted_client.name",
    "broker.name",
    "extracted_client.risk_address",
    "quote_terms.risk_address",
    "current_cover.required_documents",
    "quote_terms.required_documents",
  ] as const;

  const lineOf = (source: unknown, predicate: (l: { code: string }) => boolean) => {
    const view = captured(completenessView(evidenceOf(source)));
    const line = [...view.caseLines, ...view.documentLines, ...view.insurerGroups.flatMap((g) => g.lines)].find(predicate);
    if (!line) throw new Error("line not found");
    return line;
  };
  const factLine = () => {
    const line = captured(completenessView(evidenceOf(case23))).caseLines.find((l) => l.tracking.trackable && l.fieldPath !== null);
    if (!line) throw new Error("fact line not found");
    return line;
  };
  /** A real trackable fact line, re-pointed at another schema path with that path's own generated label. */
  const lineForPath = (path: string) => {
    const base = factLine();
    const label = workerSchemaFieldLabel(path);
    return { ...base, fieldPath: path, fieldLabel: label, tracking: { ...base.tracking, title: label } };
  };
  const row = (title: string, status: string) => ({ item_type: "underwriting_info", title, status });

  it("the shared-label set is exactly the labels the worker registry itself refuses to resolve", () => {
    const pathsByLabel = new Map<string, string[]>();
    for (const [section, fields] of Object.entries(SECTION_FIELDS)) {
      for (const { field } of fields) {
        const path = `${section}.${field}`;
        const label = workerSchemaFieldLabel(path).toLowerCase();
        pathsByLabel.set(label, [...(pathsByLabel.get(label) ?? []), path]);
      }
    }
    const shared = new Map([...pathsByLabel].filter(([, paths]) => paths.length > 1));
    // Drift guard: a new schema field that collides on label must be added to the client set.
    expect(new Set(shared.keys())).toEqual(new Set(SHARED_SCHEMA_FIELD_LABELS));
    expect([...shared.values()].flat().sort()).toEqual([...SHARED_PATHS].sort());
    for (const [label, paths] of shared) {
      expect(workerResolveSchemaFieldIdentity(label)).toBeNull();
      expect(paths.length).toBeGreaterThan(1);
    }
    // And every other label resolves uniquely, so a title match for it is still proof.
    for (const [label, paths] of pathsByLabel) {
      if (!shared.has(label)) expect(workerResolveSchemaFieldIdentity(label)).toBe(paths[0]);
    }
  });

  it("two sibling paths that render the same title are never both reported as tracked", () => {
    const a = lineForPath("extracted_client.risk_address");
    const b = lineForPath("quote_terms.risk_address");
    expect(a.tracking.title).toBe(b.tracking.title);
    for (const status of ["open", "requested", "received", "waived", "not_required"]) {
      const items = [row("Risk address", status)];
      expect(trackedStateFor(a, items)).toEqual({ state: "untracked" });
      expect(trackedStateFor(b, items)).toEqual({ state: "untracked" });
    }
  });

  it("a closed row for one sibling cannot hide the genuinely outstanding other (Track stays available)", () => {
    const outstanding = lineForPath("quote_terms.risk_address");
    for (const status of ["received", "waived", "not_required"]) {
      expect(trackedStateFor(outstanding, [row("Risk address", status)]).state).toBe("untracked");
    }
  });

  it("holds even when only one sibling is in the packet (a row may belong to the absent peer)", () => {
    const only = lineForPath("extracted_client.risk_address");
    expect(trackedStateFor(only, [row("Risk address", "open")])).toEqual({ state: "untracked" });
    expect(trackedStateFor(only, [row("Risk address", "open"), row("Risk address", "received")])).toEqual({ state: "untracked" });
  });

  it("applies to every shared label, not just risk address", () => {
    for (const path of SHARED_PATHS) {
      const line = lineForPath(path);
      expect(trackedStateFor(line, [row(line.tracking.title, "open")])).toEqual({ state: "untracked" });
      expect(trackedStateFor(line, [row(line.tracking.title, "received")])).toEqual({ state: "untracked" });
    }
  });

  it("is insensitive to case and padding of the row title, as the server's registry lookup is", () => {
    const line = lineForPath("quote_terms.risk_address");
    for (const title of ["risk address", "RISK ADDRESS", "  Risk address  "]) {
      expect(trackedStateFor(line, [row(title, "open")])).toEqual({ state: "untracked" });
    }
  });

  it("an unambiguous schema fact is still recognised exactly as before", () => {
    const line = factLine();
    expect(line.tracking.title).toBe("Registration or ID number");
    expect(trackedStateFor(line, [row("Registration or ID number", "open")])).toMatchObject({ state: "tracked_open", status: "open", count: 1 });
    expect(trackedStateFor(line, [row("Registration or ID number", "received")])).toMatchObject({ state: "tracked_closed", status: "received" });
    expect(trackedStateFor(line, [row("Risk address", "open")])).toEqual({ state: "untracked" });
  });

  it("documents and the cover-sections item are unaffected by the shared-label rule", () => {
    const doc = lineOf(case24, (l) => l.code === "required_document_missing");
    expect(trackedStateFor(doc, [{ item_type: "document", title: "Risk survey", status: "received" }])).toMatchObject({ state: "tracked_closed" });
    const sections = lineOf(case27, (l) => l.code === "requested_sections_not_declared");
    expect(trackedStateFor(sections, [row("Cover sections required", "open")])).toMatchObject({ state: "tracked_open" });
  });

  it("a document that merely shares a shared label's words is still matched on its document key", () => {
    const doc = { ...lineOf(case24, (l) => l.code === "required_document_missing") };
    const asDocument = { ...doc, documentKey: documentKey("Name"), tracking: { ...doc.tracking, title: "Name" } };
    expect(trackedStateFor(asDocument, [{ item_type: "document", title: "name", status: "open" }])).toMatchObject({ state: "tracked_open" });
  });
});
