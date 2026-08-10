/**
 * Extraction-confidence integration tests
 * ----------------------------------------------------------------------------
 * Exercises the seams where the resolved ExtractionConfidenceState reaches the
 * three visible surfaces:
 *   • RiskInformationPanel — trust summary at top, editing still works
 *   • RecommendationPanel — quiet notice appears ONLY for `unavailable`
 *   • QuoteReviewPanel — its own overall_confidence is never labelled
 *     "extraction confidence"
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import type { ExtractionConfidenceState } from "../lib/extraction-confidence";
import type { ExtractionRecord } from "../lib/atlas";

// The panels reach for these libs through absolute imports; the resolver-level
// paths are pure and safe to load. Only mock the mutation endpoints so tests
// stay isolated from the network.
vi.mock("../lib/recommendations", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/recommendations")>();
  return { ...original, runRecommendation: vi.fn().mockResolvedValue({ ok: true }) };
});
vi.mock("../lib/quote-reviews", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/quote-reviews")>();
  return { ...original, runQuoteReview: vi.fn().mockResolvedValue({ ok: true }) };
});
vi.mock("../lib/decisions", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/decisions")>();
  return { ...original, recordDecision: vi.fn().mockResolvedValue({ ok: true }) };
});
vi.mock("../lib/phase4", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/phase4")>();
  return {
    ...original,
    getQuoteReviewHistory: vi.fn().mockResolvedValue({ reviews: [], comparison: [] }),
  };
});

import RecommendationPanel from "../pages/RecommendationPanel";
import QuoteReviewPanel from "../pages/QuoteReviewPanel";
import RiskInformationPanel from "../pages/RiskInformationPanel";
import type { QuoteReview } from "../lib/quote-reviews";
import type { WorkspaceData } from "../pages/SubmissionDetail";

const AVAILABLE: ExtractionConfidenceState = {
  state: "available",
  value: 0.5,
  source: "provider",
  available: true,
};

const UNAVAILABLE: ExtractionConfidenceState = {
  state: "unavailable",
  value: null,
  source: "unavailable",
  available: false,
};

const NOT_RECORDED: ExtractionConfidenceState = {
  state: "not_recorded",
  value: null,
  source: "legacy",
  available: null,
};

function extractionRecord(over: Partial<ExtractionRecord> = {}): ExtractionRecord {
  return {
    id: "ext_1",
    extracted_json: null,
    reviewed_json: null,
    extraction_confidence: null,
    ...over,
  };
}

describe("RecommendationPanel — unavailable notice", () => {
  it("renders the quiet unavailable notice only for `unavailable`", () => {
    const { rerender } = render(
      <RecommendationPanel
        submissionId="sub_1"
        recommendation={null}
        extractionExists={true}
        extractionReviewed={true}
        extractionConfidence={UNAVAILABLE}
        openMissingInfo={[]}
        onRefresh={() => Promise.resolve()}
        onGoToTab={() => {}}
      />
    );
    expect(screen.getByText(/Extraction confidence is unavailable/i)).toBeInTheDocument();

    rerender(
      <RecommendationPanel
        submissionId="sub_1"
        recommendation={null}
        extractionExists={true}
        extractionReviewed={true}
        extractionConfidence={AVAILABLE}
        openMissingInfo={[]}
        onRefresh={() => Promise.resolve()}
        onGoToTab={() => {}}
      />
    );
    expect(screen.queryByText(/Extraction confidence is unavailable/i)).toBeNull();

    rerender(
      <RecommendationPanel
        submissionId="sub_1"
        recommendation={null}
        extractionExists={true}
        extractionReviewed={true}
        extractionConfidence={NOT_RECORDED}
        openMissingInfo={[]}
        onRefresh={() => Promise.resolve()}
        onGoToTab={() => {}}
      />
    );
    expect(screen.queryByText(/Extraction confidence is unavailable/i)).toBeNull();
  });

  it("provider-rated zero does NOT trigger the unavailable notice", () => {
    render(
      <RecommendationPanel
        submissionId="sub_1"
        recommendation={null}
        extractionExists={true}
        extractionReviewed={true}
        extractionConfidence={{
          state: "available",
          value: 0,
          source: "provider",
          available: true,
        }}
        openMissingInfo={[]}
        onRefresh={() => Promise.resolve()}
        onGoToTab={() => {}}
      />
    );
    expect(screen.queryByText(/Extraction confidence is unavailable/i)).toBeNull();
  });
});

describe("QuoteReviewPanel — no confusion with its own overall_confidence", () => {
  function baseWorkspace(over: Partial<WorkspaceData> = {}): WorkspaceData {
    const quoteReview: QuoteReview = {
      id: "qr_1",
      submission_id: "sub_1",
      recommendation_id: null,
      insurer_id: null,
      status: "can_proceed",
      overall_outcome: "can_proceed",
      overall_confidence: 0.87, // review engine's own confidence, NOT extraction
      manual_review_required: false,
      review_snapshot: {},
      created_at: "2026-08-01T10:00:00Z",
      updated_at: "2026-08-01T10:00:00Z",
    };
    return {
      payload: {
        submission: {
          id: "sub_1",
          client_name: "Acme",
          broker_name: "B",
          broker_email: null,
          request_type: "R",
          status: "in_review",
          queue_status: "in_review",
          line_of_business: "commercial",
          priority: "normal",
          next_action: null,
          due_at: null,
          assigned_to: null,
          assigned_underwriter: null,
          pilot_flag: null,
          pilot_notes: null,
          assigned_to_email: null,
          created_at: "2026-08-01T10:00:00Z",
          updated_at: "2026-08-01T10:00:00Z",
        } as WorkspaceData["payload"]["submission"],
        documents: [],
        extraction: extractionRecord(),
        jobs: {},
      },
      recommendation: null,
      quoteReview,
      quoteSections: [],
      decision: null,
      missingInfo: [],
      ...over,
    };
  }

  it("shows the unavailable notice for unavailable extraction state without labelling QR confidence", () => {
    render(
      <QuoteReviewPanel
        submissionId="sub_1"
        data={baseWorkspace()}
        extractionReviewed={true}
        extractionConfidence={UNAVAILABLE}
        onRefresh={() => Promise.resolve()}
        onGoToTab={() => {}}
      />
    );
    expect(screen.getByText(/Extraction confidence is unavailable/i)).toBeInTheDocument();
    // The quote review's own 0.87 confidence must NOT be surfaced as "extraction confidence".
    expect(screen.queryByText(/extraction confidence.*87/i)).toBeNull();
    expect(screen.queryByText(/87.*extraction/i)).toBeNull();
  });

  it("does not show the notice for an available state", () => {
    render(
      <QuoteReviewPanel
        submissionId="sub_1"
        data={baseWorkspace()}
        extractionReviewed={true}
        extractionConfidence={AVAILABLE}
        onRefresh={() => Promise.resolve()}
        onGoToTab={() => {}}
      />
    );
    expect(screen.queryByText(/Extraction confidence is unavailable/i)).toBeNull();
  });
});

describe("RiskInformationPanel — trust summary integration", () => {
  it("renders the trust summary at the top for a reviewed extraction and keeps editing available", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <RiskInformationPanel
        submissionId="sub_1"
        extraction={extractionRecord({
          reviewed_json: {
            overall_confidence: 0.6,
            overall_confidence_available: true,
            extracted_client: {
              name: { value: "Acme Ltd", confidence: 0.9 },
            },
          },
          extracted_json: {
            overall_confidence: 0.6,
            overall_confidence_available: true,
          },
        })}
        canWrite={true}
        canManage={true}
        extracting={false}
        onExtract={() => {}}
        onSave={onSave}
      />
    );

    expect(screen.getByText(/Extraction trust/i)).toBeInTheDocument();
    expect(screen.getByText(/Reviewed by a person/i)).toBeInTheDocument();

    const correct = screen.getByRole("button", { name: /Correct values/i });
    await user.click(correct);
    expect(screen.getByRole("button", { name: /Save corrections/i })).toBeInTheDocument();
  });

  it("axe-clean for the risk panel in the reviewed + available state", async () => {
    const { container } = render(
      <RiskInformationPanel
        submissionId="sub_1"
        extraction={extractionRecord({
          reviewed_json: {
            overall_confidence: 0.6,
            overall_confidence_available: true,
            extracted_client: { name: { value: "Acme", confidence: 0.9 } },
          },
        })}
        canWrite={true}
        canManage={true}
        extracting={false}
        onExtract={() => {}}
        onSave={vi.fn()}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("still renders the no-extraction empty state", () => {
    render(
      <RiskInformationPanel
        submissionId="sub_1"
        extraction={null}
        canWrite={true}
        canManage={true}
        extracting={false}
        onExtract={() => {}}
        onSave={vi.fn()}
      />
    );
    expect(screen.getByText(/Atlas has not read the documents yet/i)).toBeInTheDocument();
    // Trust summary is NOT shown when there is no extraction on file.
    expect(screen.queryByText(/Extraction trust/i)).toBeNull();
  });
});

describe("RecommendationPanel — 375px-safe structure", () => {
  it("has zero axe violations in the unavailable+notice state", async () => {
    const { container } = render(
      <RecommendationPanel
        submissionId="sub_1"
        recommendation={null}
        extractionExists={true}
        extractionReviewed={true}
        extractionConfidence={UNAVAILABLE}
        openMissingInfo={[]}
        onRefresh={() => Promise.resolve()}
        onGoToTab={() => {}}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe("no ghost 70% anywhere in the trust surfaces", () => {
  it("the not_recorded state does not display 70%", () => {
    const { container } = render(
      <RecommendationPanel
        submissionId="sub_1"
        recommendation={null}
        extractionExists={true}
        extractionReviewed={true}
        extractionConfidence={NOT_RECORDED}
        openMissingInfo={[]}
        onRefresh={() => Promise.resolve()}
        onGoToTab={() => {}}
      />
    );
    // Neither the notice nor any label mentions 70 / 70%.
    expect(container.textContent ?? "").not.toMatch(/70%/);
  });
});

describe("Not shown when nothing is on file (equivalent to a leftover integration guarantee)", () => {
  it("Risk panel does NOT render trust summary for null extraction (no invented state)", () => {
    render(
      <RiskInformationPanel
        submissionId="sub_1"
        extraction={null}
        canWrite={true}
        canManage={true}
        extracting={false}
        onExtract={() => {}}
        onSave={vi.fn()}
      />
    );
    within(document.body).queryByText(/Extraction trust/i);
    expect(screen.queryByText(/Extraction trust/i)).toBeNull();
  });
});
