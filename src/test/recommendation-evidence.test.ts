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

  it("degrades unknown or malformed packets to 'unsupported' and never throws", () => {
    const future = { schema_version: "recommendation-evidence-v9", insurers: [], provenance: {}, quality: {}, trusted_documents: [] };
    expect(resolveEvidence(future)).toEqual({ kind: "unsupported", schemaVersion: "recommendation-evidence-v9" });
    for (const junk of ["garbage", 42, true, [], {}, { schema_version: 2 }, { schema_version: "recommendation-evidence-v2" }]) {
      expect(() => resolveEvidence(junk)).not.toThrow();
      expect(resolveEvidence(junk).kind).toBe("unsupported");
    }
    // v2 claimed but the v2-only structure is missing → not trusted as v2.
    const hollow = { ...(row(case05).evidence_json as object) } as Record<string, unknown>;
    delete hollow.scoring_scope;
    expect(resolveEvidence(hollow).kind).toBe("unsupported");
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
