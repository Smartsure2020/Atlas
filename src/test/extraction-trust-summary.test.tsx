/**
 * ExtractionTrustSummary component tests
 * ----------------------------------------------------------------------------
 * Verifies the four scenario-shaped renderings and their accessibility:
 *   provider zero        → visible 0%, Provider rating label
 *   explicitly unavailable → "Unavailable", no percentage at all
 *   not recorded         → "Not recorded", no percentage
 *   legacy valid number  → number + Legacy rating
 * plus human-review isolation and field-band count fidelity.
 */

import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { axe } from "vitest-axe";
import ExtractionTrustSummary from "../components/ExtractionTrustSummary";
import type { ExtractionRecord } from "../lib/atlas";

function extraction(over: Partial<ExtractionRecord>): ExtractionRecord {
  return {
    id: "ext_test",
    extracted_json: null,
    reviewed_json: null,
    extraction_confidence: null,
    ...over,
  };
}

describe("ExtractionTrustSummary rendering", () => {
  it("shows 0% and Provider rating for a provider-rated zero", () => {
    render(
      <ExtractionTrustSummary
        extraction={extraction({
          extracted_json: {
            overall_confidence: 0,
            overall_confidence_available: true,
            overall_confidence_source: "provider",
          },
        })}
      />
    );
    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(screen.getByText(/Provider rating/i)).toBeInTheDocument();
  });

  it("shows Unavailable and NO percentage when explicitly unavailable", () => {
    const { container } = render(
      <ExtractionTrustSummary
        extraction={extraction({
          extracted_json: {
            overall_confidence: 0,
            overall_confidence_available: false,
            overall_confidence_source: "unavailable",
          },
        })}
      />
    );
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    // No percentage character anywhere in the metric.
    const metric = container.querySelector(".atlas-trust__metric");
    expect(metric?.textContent ?? "").not.toMatch(/%/);
  });

  it("shows Not recorded when nothing is on file", () => {
    render(
      <ExtractionTrustSummary
        extraction={extraction({
          extracted_json: {},
          reviewed_json: {},
        })}
      />
    );
    expect(screen.getByText("Not recorded")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("shows a legacy number with a Legacy rating label", () => {
    render(
      <ExtractionTrustSummary
        extraction={extraction({ extraction_confidence: 0.42 })}
      />
    );
    expect(screen.getByText("42%")).toBeInTheDocument();
    expect(screen.getByText(/Legacy rating/i)).toBeInTheDocument();
  });

  it("human review status is separate from provider provenance", () => {
    render(
      <ExtractionTrustSummary
        extraction={extraction({
          extracted_json: {
            overall_confidence: 0.6,
            overall_confidence_available: true,
            overall_confidence_source: "provider",
          },
          reviewed_json: {
            overall_confidence: 0.6,
            overall_confidence_available: true,
          },
        })}
      />
    );
    expect(screen.getByText(/Reviewed by a person/i)).toBeInTheDocument();
    // Provenance still labelled as a rating source, not overwritten by review.
    expect(screen.getByText(/Provider rating/i)).toBeInTheDocument();
  });

  it("counts field bands correctly", () => {
    render(
      <ExtractionTrustSummary
        extraction={extraction({
          extracted_json: {
            extracted_client: {
              name: { value: "Foo", confidence: 0.95 },
              entity_type: { value: "PTY", confidence: 0.85 },
            },
            claims: {
              claims_history_available: { value: null, confidence: 0 },
            },
          },
        })}
      />
    );
    // Exactly two confirmed fields (name + entity_type both >= 0.85 → "confirmed" band).
    expect(screen.getByText(/^2 confirmed$/i)).toBeInTheDocument();
  });

  it("has zero axe violations for a common state", async () => {
    const { container } = render(
      <ExtractionTrustSummary
        extraction={extraction({
          extracted_json: {
            overall_confidence: 0.7,
            overall_confidence_available: true,
            overall_confidence_source: "provider",
          },
        })}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it("uses a semantic dl with dt/dd pairs", () => {
    const { container } = render(
      <ExtractionTrustSummary
        extraction={extraction({
          extracted_json: {
            overall_confidence: 0.5,
            overall_confidence_available: true,
          },
        })}
      />
    );
    const dl = container.querySelector("dl");
    expect(dl).not.toBeNull();
    // Every dd must be preceded by a dt (structural sanity).
    const dl2 = dl!;
    const kids = within(dl2).getAllByRole("term").length;
    const values = within(dl2).getAllByRole("definition").length;
    expect(kids).toBeGreaterThan(0);
    expect(values).toBeGreaterThan(0);
    expect(kids).toBe(values);
  });
});
