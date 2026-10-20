/**
 * Evidence Mode view model (lib/recommendation-evidence)
 * ----------------------------------------------------------------------------
 * Inputs are the REAL rows the backend produces for the Powerhouse acceptance
 * cases (tests/powerhouse/fixtures/snapshots, drift-checked by the Worker suite)
 * plus authentic historical v1 and null rows. The view model must display what
 * was recorded — never score, classify materiality, reconstruct or invent.
 */

import { describe, expect, it } from "vitest";
import {
  insurerView,
  noDataInsurers,
  provenanceOf,
  recommendationQuality,
  resolveEvidence,
  scoreTies,
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

const row = (value: unknown) => value as unknown as Recommendation;
const evidenceOf = (value: unknown) => resolveEvidence(row(value).evidence_json);

function scored(value: unknown, insurerId: string): InsurerEvidenceView {
  const view = insurerView(evidenceOf(value), insurerId);
  if (!view || view.status !== "scored") throw new Error(`expected a scored view for ${insurerId}`);
  return view;
}

describe("resolveEvidence", () => {
  it("classifies absent, v1, v2 and unsupported packets without throwing", () => {
    expect(resolveEvidence(null)).toEqual({ kind: "absent" });
    expect(resolveEvidence(undefined)).toEqual({ kind: "absent" });
    expect(evidenceOf(histNull)).toEqual({ kind: "absent" });
    expect(evidenceOf(histComplete)).toMatchObject({ kind: "ready", version: "v1" });
    expect(evidenceOf(case05)).toMatchObject({ kind: "ready", version: "v2" });
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

describe("R6 — hollow v2 packets are 'malformed', never crash, and are never reconstructed", () => {
  it.each(HOLLOW_V2)("%s", (_label, mutate) => {
    const packet = mutated(case05, mutate);
    let view: ReturnType<typeof resolveEvidence> | undefined;
    expect(() => { view = resolveEvidence(packet); }).not.toThrow();
    expect(view).toEqual({ kind: "malformed", schemaVersion: "recommendation-evidence-v2" });
    // The malformed result carries no packet at all: nothing downstream can read half of it.
    expect(JSON.stringify(view)).not.toContain("insurer-alpha");
    expect(insurerView(view!, "insurer-alpha")).toBeNull();
    expect(recommendationQuality(view!)).toBeNull();
    expect(noDataInsurers(view!)).toEqual([]);
  });

  it("the unmutated packet is accepted (the guards do not reject good data)", () => {
    for (const source of [case01, case05, case06, case07, case08, case09, case10, case11, case12, case14, case17, case18, case19, case20, case21]) {
      expect(resolveEvidence((row(source) as { evidence_json: unknown }).evidence_json).kind).toBe("ready");
    }
  });

  it("every contract section outcome (and null) is still accepted; only an unknown value is rejected", () => {
    for (const outcome of ["hard_decline", "soft_decline_referral", "referral", "caution", "preferred", "standard", null]) {
      const packet = mutated(case05, (p) => { p.insurers[scoredIndex(p)].section_evaluations[0].outcome = outcome; });
      expect(resolveEvidence(packet).kind).toBe("ready");
    }
    for (const bad of ["prefered", "Preferred", "", "ruled_out", 1, {}]) {
      const packet = mutated(case05, (p) => { p.insurers[scoredIndex(p)].section_evaluations[0].outcome = bad; });
      expect(resolveEvidence(packet)).toEqual({ kind: "malformed", schemaVersion: "recommendation-evidence-v2" });
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

  it("randomised damage (500 single-field deletions anywhere in the packet) never throws", () => {
    const base = JSON.parse(JSON.stringify((row(case18) as { evidence_json: unknown }).evidence_json));
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
        if (view.kind === "ready") for (const o of copy.insurers) insurerView(view, o.insurer_id);
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
