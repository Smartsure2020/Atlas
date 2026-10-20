/**
 * Evidence Mode (Powerhouse P1B)
 * ----------------------------------------------------------------------------
 * Rendered against the REAL rows the backend produces for the Powerhouse
 * acceptance cases (tests/powerhouse/fixtures/snapshots — drift-checked by the
 * Worker suite) and authentic historical v1 / null rows.
 *
 * What these tests protect:
 *   • Evidence Mode DISPLAYS persisted evidence; it never scores or reinterprets.
 *   • Missing provenance is visibly missing; nothing is manufactured.
 *   • No-data insurers read "No active appetite data available" — never a zero
 *     score, a decline or a poor fit.
 *   • "Incomplete" is a reliance signal, never worded as a decline or a block.
 *   • v1, v2, null and unsupported evidence all render without crashing.
 *   • Ordinary users never see raw JSON or technical IDs.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";

const runRecommendationMock = vi.fn();
vi.mock("../lib/recommendations", () => ({
  runRecommendation: (...args: unknown[]) => runRecommendationMock(...args),
}));

import RecommendationPanel from "../pages/RecommendationPanel";
import { EvidenceDrawer } from "../components/EvidenceMode";
import { resolveEvidence } from "../lib/recommendation-evidence";
import type { Recommendation } from "../lib/recommendations";
import type { ExtractionConfidenceState } from "../lib/extraction-confidence";

import case01 from "../../tests/powerhouse/fixtures/snapshots/case-01-single-section-baseline.row.json";
import case02 from "../../tests/powerhouse/fixtures/snapshots/case-02-multi-section-compatible.row.json";
import case03 from "../../tests/powerhouse/fixtures/snapshots/case-03-multi-section-preferred-plus-caution.row.json";
import case05 from "../../tests/powerhouse/fixtures/snapshots/case-05-multi-section-hard-decline.row.json";
import case06 from "../../tests/powerhouse/fixtures/snapshots/case-06-ai-inferred-soft-decline.row.json";
import case07 from "../../tests/powerhouse/fixtures/snapshots/case-07-required-document-missing.row.json";
import case09 from "../../tests/powerhouse/fixtures/snapshots/case-09-no-appetite-data-insurer.row.json";
import case10 from "../../tests/powerhouse/fixtures/snapshots/case-10-incomplete-provenance-locator.row.json";
import case12 from "../../tests/powerhouse/fixtures/snapshots/case-12-privacy-sentinels.row.json";
import case14 from "../../tests/powerhouse/fixtures/snapshots/case-14-no-trusted-documents.row.json";
import histComplete from "../../tests/powerhouse/fixtures/snapshots/historical-v1-complete.row.json";
import histGaps from "../../tests/powerhouse/fixtures/snapshots/historical-v1-gaps.row.json";
import histNull from "../../tests/powerhouse/fixtures/snapshots/historical-null.row.json";

const AVAILABLE: ExtractionConfidenceState = { state: "available", value: 0.9, source: "provider", available: true };
const asRec = (value: unknown) => value as unknown as Recommendation;

function renderPanel(
  recommendation: Recommendation,
  props: Partial<React.ComponentProps<typeof RecommendationPanel>> = {}
) {
  return render(
    <RecommendationPanel
      submissionId="sub_1"
      recommendation={recommendation}
      extractionExists={true}
      extractionReviewed={true}
      extractionConfidence={AVAILABLE}
      openMissingInfo={[]}
      onRefresh={vi.fn().mockResolvedValue(undefined)}
      onGoToTab={vi.fn()}
      {...props}
    />
  );
}

async function openEvidence(insurerName: string) {
  const user = userEvent.setup();
  const button = screen.getAllByRole("button", { name: new RegExp(`Why Atlas ranked this.*${insurerName}`) })[0];
  await user.click(button);
  return {
    user,
    dialog: screen.getByRole("dialog", { name: new RegExp(`Why Atlas ranked ${insurerName}`) }),
  };
}

beforeEach(() => runRecommendationMock.mockReset());

describe("Evidence Mode — v2 recommendation-level quality panel", () => {
  it("shows the reliance state, counts and the limitation behind a hidden hard decline", () => {
    renderPanel(asRec(case05));
    const panel = screen.getByRole("region", { name: "Intelligence quality" });
    expect(within(panel).getAllByText("Incomplete").length).toBeGreaterThan(0);
    expect(within(panel).getByText("2 blockers")).toBeInTheDocument();
    // Two blockers are listed as limitations that affect reliance (Gamma's identical gap is advisory, under "Advisory notes").
    const limitations = within(panel).getByRole("list", { name: "Limitations that affect reliance" });
    expect(within(limitations).getAllByText("A requested section is declined but not reflected in the score")).toHaveLength(2);
    // Each card says WHICH insurer it concerns, and in plain words what is missing.
    expect(within(limitations).getByText(/Insurer: Alpha Insurance\. Section: Goods in transit\. Missing: this section's outcome in the score\./)).toBeInTheDocument();
    expect(within(limitations).getByText(/Insurer: Beta Insurance\. Section: Goods in transit\./)).toBeInTheDocument();
    expect(within(panel).getByText("Advisory notes (1)")).toBeInTheDocument();
    // It informs; it does not block or decline.
    expect(within(panel).getByText(/Nothing is blocked or declined/i)).toBeInTheDocument();
    expect(within(panel).queryByText(/ruled out|declined by atlas/i)).toBeNull();
    // The scoring scope is stated.
    expect(within(panel).getByText(/not combined into the score/i)).toBeInTheDocument();
  });

  it("a clean recommendation is 'Decision ready' with no blocker or material limitation listed", () => {
    renderPanel(asRec(case01));
    const panel = screen.getByRole("region", { name: "Intelligence quality" });
    expect(within(panel).getAllByText("Decision ready").length).toBeGreaterThan(0);
    expect(within(panel).queryByRole("list", { name: "Limitations that affect reliance" })).toBeNull();
  });

  it("material limitations put the recommendation in 'Use with caution'", () => {
    renderPanel(asRec(case03));
    const panel = screen.getByRole("region", { name: "Intelligence quality" });
    expect(within(panel).getAllByText("Use with caution").length).toBeGreaterThan(0);
    expect(within(panel).getByText("A caution in another section is not reflected in the score")).toBeInTheDocument();
  });

  it("does not change the ranking or the displayed scores", () => {
    renderPanel(asRec(case05));
    const ranked = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(ranked.slice(0, 3)).toEqual(["Alpha Insurance", "Beta Insurance", "Gamma Insurance"]);
  });
});

describe("Evidence Mode — per-insurer drawer (v2)", () => {
  it("answers the underwriter's questions in named sections", async () => {
    renderPanel(asRec(case05));
    const { dialog } = await openEvidence("Alpha Insurance");
    for (const heading of [
      "Ranking explanation",
      "Rules applied",
      "Requested sections",
      "Referral and decline triggers",
      "Required documents",
      "Trusted evidence",
      "Evidence gaps — what Atlas does not know",
      "Source guideline provenance",
      "Intelligence quality",
    ]) {
      expect(within(dialog).getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    expect(within(dialog).getByText(/ranked 1 among the insurers Atlas scored, with an internal score of 100/)).toBeInTheDocument();
    expect(within(dialog).getByText(/The score orders candidates; the reasons below are what to act on/)).toBeInTheDocument();
  });

  it("shows the hidden section decline as 'Hard decline' and 'Not reflected in the score'", async () => {
    renderPanel(asRec(case05));
    const { dialog } = await openEvidence("Alpha Insurance");
    const sections = within(dialog).getByRole("heading", { name: "Requested sections" }).closest(".atlas-block") as HTMLElement;
    const list = sections.querySelector(".atlas-ev__sections") as HTMLElement;
    expect(within(list).getByText("Goods in transit")).toBeInTheDocument();
    expect(within(list).getByText("Hard decline")).toBeInTheDocument();
    expect(within(list).getByText("Not reflected in the score")).toBeInTheDocument();
    expect(within(sections).getByText("Reflected in the score")).toBeInTheDocument();
    expect(within(dialog).getByText("Blocker")).toBeInTheDocument();
  });

  it("lists rules considered but not used, with their conditions", async () => {
    renderPanel(asRec(case03));
    const { dialog } = await openEvidence("Alpha Insurance");
    expect(within(dialog).getByText("Rules Atlas considered (2)")).toBeInTheDocument();
    expect(within(dialog).getByText("Set this insurer's score")).toBeInTheDocument();
    expect(within(dialog).getByText(/Considered — weaker match/)).toBeInTheDocument();
    expect(within(dialog).getByText("high value cargo")).toBeInTheDocument();
    expect(within(dialog).getAllByText(/matched in endorsements/).length).toBeGreaterThan(0);
  });

  it("states the matched insurer term and its input source for each rule (score effect shown exactly)", async () => {
    renderPanel(asRec(case01));
    const { dialog } = await openEvidence("Alpha Insurance");
    const rules = within(dialog).getByRole("heading", { name: "Rules applied" }).closest(".atlas-block") as HTMLElement;
    expect(within(rules).getByText("+5 points")).toBeInTheDocument();
    expect(within(rules).getByText("Base appetite for this product and risk type")).toBeInTheDocument();
    expect(within(rules).getAllByText("transport fleet").length).toBeGreaterThan(0);
    expect(within(rules).getAllByText(/matched in (primary risk type|occupation\/business description)/).length).toBeGreaterThan(0);
  });

  it("full provenance renders file, section, page and an excerpt labelled as the rule's excerpt", async () => {
    renderPanel(asRec(case01));
    const { dialog } = await openEvidence("Alpha Insurance");
    const provenance = within(dialog).getByRole("heading", { name: "Source guideline provenance" }).closest(".atlas-block") as HTMLElement;
    expect(within(provenance).getByText("guide.pdf · Section 4 · page 4")).toBeInTheDocument();
    expect(within(provenance).getByText("Source excerpt for this rule")).toBeInTheDocument();
    expect(within(provenance).getByText("Synthetic guideline excerpt.")).toBeInTheDocument();
    expect(within(provenance).queryByText("Provenance incomplete")).toBeNull();
    // The excerpt is not presented as proof of a matched term.
    expect(within(provenance).getByText("Synthetic guideline excerpt.").closest("blockquote")).toHaveAttribute(
      "title",
      expect.stringMatching(/not proof of any single matched term/i)
    );
  });

  it("a rule with no provenance says so visibly and invents nothing", async () => {
    renderPanel(asRec(case10));
    const { dialog } = await openEvidence("Beta Insurance");
    const provenance = within(dialog).getByRole("heading", { name: "Source guideline provenance" }).closest(".atlas-block") as HTMLElement;
    expect(within(provenance).getAllByText("Not recorded").length).toBeGreaterThanOrEqual(2);
    expect(within(provenance).getByText("Provenance incomplete")).toBeInTheDocument();
    expect(within(provenance).getByText("Not recorded: source document, file name, section, page, source excerpt.")).toBeInTheDocument();
    expect(within(provenance).queryByText(/page \d/)).toBeNull();
    expect(within(provenance).queryByRole("blockquote")).toBeNull();
    expect(within(dialog).getByText("Rule has no source document recorded")).toBeInTheDocument();
    expect(within(dialog).getByText("Material")).toBeInTheDocument();
  });

  it("an incomplete locator is advisory, names what is absent, and keeps what exists", async () => {
    renderPanel(asRec(case10));
    const { dialog } = await openEvidence("Alpha Insurance");
    expect(within(dialog).getByText("Rule's source location is incomplete")).toBeInTheDocument();
    expect(within(dialog).getByText("Advisory")).toBeInTheDocument();
    expect(within(dialog).getByText("alpha-guide.pdf")).toBeInTheDocument();
    expect(within(dialog).getByText("Missing: page, source excerpt, section.")).toBeInTheDocument();
  });

  it("missing required documents: named, confidence-only, and never a score change", async () => {
    renderPanel(asRec(case07));
    const { dialog } = await openEvidence("Alpha Insurance");
    const docs = within(dialog).getByRole("heading", { name: "Required documents" }).closest(".atlas-block") as HTMLElement;
    expect(within(docs).getByText("Risk survey")).toBeInTheDocument();
    expect(within(docs).getByText("Missing")).toBeInTheDocument();
    expect(within(docs).getByText("Present")).toBeInTheDocument();
    expect(within(docs).getByText(/confidence −0\.10/)).toBeInTheDocument();
    expect(within(docs).getByText(/lowers confidence only. It never changes the score/)).toBeInTheDocument();
  });

  it("no trusted documents: stated plainly in Trusted evidence", async () => {
    renderPanel(asRec(case14));
    const { dialog } = await openEvidence("Alpha Insurance");
    expect(within(dialog).getByText("No trusted documents were available")).toBeInTheDocument();
    expect(within(dialog).getByText(/Atlas counts only active documents with a clean scan/)).toBeInTheDocument();
  });

  it("an AI-inferred decline reads as a possible decline needing a person — not a hard decline", async () => {
    renderPanel(asRec(case06));
    const { dialog } = await openEvidence("Alpha Insurance");
    const triggers = within(dialog).getByRole("heading", { name: "Referral and decline triggers" }).closest(".atlas-block") as HTMLElement;
    expect(within(triggers).getAllByText("Possible decline — needs human confirmation").length).toBeGreaterThan(0);
    expect(within(triggers).getByText(/never as a hard decline/i)).toBeInTheDocument();
    expect(within(triggers).getAllByText("−10 points").length).toBeGreaterThan(0);
    expect(within(dialog).queryByText("Hard decline")).toBeNull();
    expect(within(dialog).queryByText("Ruled out")).toBeNull();
  });

  it("a ruled-out insurer's hard decline is shown with its insurer-owned term or rule-level reason", async () => {
    renderPanel(asRec(case05));
    const { dialog } = await openEvidence("Gamma Insurance");
    const triggers = within(dialog).getByRole("heading", { name: "Referral and decline triggers" }).closest(".atlas-block") as HTMLElement;
    expect(within(triggers).getAllByText("Hard decline").length).toBeGreaterThan(0);
    expect(within(triggers).getByText("No additive score — insurer ruled out")).toBeInTheDocument();
    expect(within(dialog).getByText("Ruled out")).toBeInTheDocument();
    expect(within(dialog).getByText(/Required documents are not checked for an insurer that was ruled out/)).toBeInTheDocument();
  });

  it("a referral that IS reflected shows as a referral trigger with its exact cost", async () => {
    const { default: case04 } = await import("../../tests/powerhouse/fixtures/snapshots/case-04-multi-section-referral.row.json");
    renderPanel(asRec(case04));
    const { dialog } = await openEvidence("Beta Insurance");
    expect(within(dialog).getAllByText("−8 points").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Referral trigger").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Referral required")).toBeInTheDocument();
  });

  it("compatible multi-section: the aggregation limitation is advisory and the drawer says sections are not scored together", async () => {
    renderPanel(asRec(case02));
    const { dialog } = await openEvidence("Alpha Insurance");
    expect(within(dialog).getAllByText(/not combined into the score/i).length).toBeGreaterThan(0);
    expect(within(dialog).getByText("A requested section is shown but not scored")).toBeInTheDocument();
    expect(within(dialog).getByText("Advisory")).toBeInTheDocument();
    expect(within(dialog).queryByText("Blocker")).toBeNull();
  });
});

describe("Evidence Mode — no-data insurers", () => {
  it("are listed as 'No active appetite data available', explicitly not a decline or a zero", () => {
    renderPanel(asRec(case09));
    const panel = screen.getByRole("region", { name: "Intelligence quality" });
    expect(within(panel).getByText("Insurers without appetite data (2)")).toBeInTheDocument();
    expect(within(panel).getByText("Epsilon Insurance")).toBeInTheDocument();
    expect(within(panel).getByText("Foxtrot Insurance")).toBeInTheDocument();
    const list = within(panel).getByText("Insurers without appetite data (2)").closest("details") as HTMLElement;
    expect(within(list).getAllByText("No active appetite data available")).toHaveLength(2);
    expect(within(panel).getByText(/not a decline and not a score of zero/i)).toBeInTheDocument();
    expect(within(panel).queryByText(/poor fit/i)).toBeNull();
  });

  it("the drawer, if asked for a no-data insurer, says the same and shows no score", () => {
    const evidence = resolveEvidence(asRec(case09).evidence_json);
    render(<EvidenceDrawer open onClose={() => undefined} evidence={evidence} insurerId="insurer-epsilon" canViewDiagnostics={false} />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("No active appetite data available")).toBeInTheDocument();
    expect(within(dialog).getByText(/not a decline, not a poor fit, and not a score of zero/i)).toBeInTheDocument();
    expect(within(dialog).queryByText(/internal score/i)).toBeNull();
  });
});

describe("Evidence Mode — historical and future evidence", () => {
  it("evidence_json = null: says detailed evidence was not captured, offers no evidence button, does not crash", () => {
    renderPanel(asRec(histNull));
    expect(screen.getByText("Detailed evidence was not captured for this historical recommendation.", { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Why Atlas ranked this/ })).toBeNull();
    // The recommendation itself still renders.
    expect(screen.getAllByRole("heading", { level: 3 }).length).toBeGreaterThan(0);
  });

  it("evidence_json absent (undefined) behaves the same", () => {
    const rec = { ...asRec(histNull) } as Partial<Recommendation>;
    delete rec.evidence_json;
    renderPanel(rec as Recommendation);
    expect(screen.getByText("Detailed evidence was not captured for this historical recommendation.", { exact: false })).toBeInTheDocument();
  });

  it("v1 'complete': shown as recorded, never promoted to v2 vocabulary", async () => {
    renderPanel(asRec(histComplete));
    const panel = screen.getByRole("region", { name: "Intelligence quality" });
    expect(within(panel).getByText("Phase 1A evidence: complete")).toBeInTheDocument();
    expect(within(panel).getByText("Recorded before the intelligence quality gate")).toBeInTheDocument();
    expect(within(panel).queryByText("Decision ready")).toBeNull();
    const { dialog } = await openEvidence("Alpha Insurance");
    expect(within(dialog).getByText(/Section-by-section evaluation was not captured for this recommendation \(evidence v1\)/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Evidence v1 summary: complete/)).toBeInTheDocument();
    expect(within(dialog).queryByText("Rules Atlas considered", { exact: false })).toBeNull();
    expect(within(dialog).queryByText("Blocker")).toBeNull();
  });

  it("v1 'gaps_present': gaps are listed and explicitly unclassified", async () => {
    renderPanel(asRec(histGaps));
    const panel = screen.getByRole("region", { name: "Intelligence quality" });
    expect(within(panel).getByText("Phase 1A evidence: gaps present")).toBeInTheDocument();
    expect(within(panel).getByText(/Evidence gaps recorded \(\d+\)/)).toBeInTheDocument();
    const { dialog } = await openEvidence("Beta Insurance");
    expect(within(dialog).getAllByText("Not classified (evidence v1)").length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/Evidence v1 recorded these gaps without a severity/)).toBeInTheDocument();
  });

  it("a future/unknown evidence schema is reported as unsupported; the recommendation still renders", () => {
    const future = { ...asRec(case01), evidence_json: { schema_version: "recommendation-evidence-v9", insurers: [], provenance: {}, quality: {}, trusted_documents: [] } };
    renderPanel(future as unknown as Recommendation);
    expect(screen.getByText("Evidence format not supported")).toBeInTheDocument();
    expect(screen.getByText(/recommendation-evidence-v9/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Why Atlas ranked this/ })).toBeNull();
    expect(screen.getAllByRole("heading", { level: 3 }).length).toBeGreaterThan(0);
  });

  it("garbage evidence_json never crashes the panel", () => {
    for (const junk of ["garbage", 7, [], { schema_version: "recommendation-evidence-v2" }]) {
      const { unmount } = renderPanel({ ...asRec(case01), evidence_json: junk } as unknown as Recommendation);
      expect(screen.getByText("Evidence format not supported")).toBeInTheDocument();
      unmount();
    }
  });
});

describe("Evidence Mode — audience and privacy", () => {
  it("ordinary users never see raw JSON or technical IDs, and no diagnostics area", async () => {
    renderPanel(asRec(case05));
    const { dialog } = await openEvidence("Alpha Insurance");
    expect(within(dialog).queryByText(/Diagnostics/)).toBeNull();
    const text = dialog.textContent ?? "";
    for (const forbidden of ["schema_version", "recommendation-evidence-v2", "rule:alpha", "fp_", "insurer-alpha", "gap:", "{\"", "extraction_id"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("managers/administrators get a collapsed diagnostics area with technical IDs", async () => {
    renderPanel(asRec(case05), { canViewDiagnostics: true });
    const { dialog } = await openEvidence("Alpha Insurance");
    const summary = within(dialog).getByText("Diagnostics (internal staff)");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    const details = summary.closest("details") as HTMLElement;
    expect(within(details).getByText("recommendation-evidence-v2")).toBeInTheDocument();
    expect(within(details).getByText("2026-10-section-evaluation-v2")).toBeInTheDocument();
    expect(within(details).getByText("alpha-motor")).toBeInTheDocument();
    // Even diagnostics are labelled values, not a JSON dump.
    expect(details.textContent).not.toContain("{\"");
  });

  it("sensitive client strings (sentinels) never reach the rendered output", async () => {
    renderPanel(asRec(case12), { canViewDiagnostics: true });
    await openEvidence("Alpha Insurance");
    const text = document.body.textContent ?? "";
    for (const sentinel of ["NAME_SENTINEL", "ID_SENTINEL", "PHONE_SENTINEL", "BANK_SENTINEL", "ADDRESS_SENTINEL", "POLICY_SENTINEL", "FREETEXT_SENTINEL"]) {
      expect(text).not.toContain(sentinel);
    }
    for (const forbidden of ["storage_path", "signed_url", "service-role"]) expect(text).not.toContain(forbidden);
  });
});

describe("Evidence Mode — accessibility and operation", () => {
  it("the quality panel and the open drawer have no axe violations", async () => {
    const { container } = renderPanel(asRec(case05));
    expect(await axe(container)).toHaveNoViolations();
    await openEvidence("Alpha Insurance");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("the drawer closes with the close control and returns focus to the trigger", async () => {
    renderPanel(asRec(case01));
    const { user } = await openEvidence("Alpha Insurance");
    await user.click(screen.getByRole("button", { name: "Close panel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByRole("button", { name: /Why Atlas ranked this.*Alpha Insurance/ })[0]).toHaveFocus();
  });

  it("the drawer closes with Escape", async () => {
    renderPanel(asRec(case01));
    const { user } = await openEvidence("Alpha Insurance");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
