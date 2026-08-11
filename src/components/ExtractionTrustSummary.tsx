/**
 * Atlas — extraction trust summary
 * ----------------------------------------------------------------------------
 * A compact metric strip that surfaces four distinct facts about an extraction:
 *
 *   1. Overall extraction confidence (with the correct availability treatment)
 *   2. Confidence provenance
 *   3. Human review status
 *   4. Field/evidence health
 *
 * The four things belong together on both the Overview and Risk Information
 * tabs so the underwriter can see, in one glance, whether the summary they are
 * about to act on carries a provider rating, whether a person has confirmed it,
 * and how much of the field evidence is confirmed vs uncertain.
 *
 * Semantics live in `src/lib/extraction-confidence.ts` — this component is
 * strictly presentational.
 */

import { useMemo } from "react";
import { StatusBadge } from "./ui";
import {
  formatExtractionConfidence,
  resolveExtractionConfidence,
  type ExtractionConfidenceState,
} from "../lib/extraction-confidence";
import type { ExtractionRecord } from "../lib/atlas";
import { countByBand } from "../lib/extraction-fields";
import { CONFIDENCE_BAND, type ConfidenceBand } from "../lib/status";

interface ExtractionTrustSummaryProps {
  /**
   * The full extraction record from the submission endpoint, or null if
   * Atlas has not read the documents yet.
   */
  extraction: ExtractionRecord | null;
  /**
   * Pre-resolved confidence state. When present the component uses this
   * instead of re-running the resolver — matches the state passed to the
   * ranking and quote-review surfaces.
   */
  state?: ExtractionConfidenceState;
  /** Optional heading override; defaults to "Extraction trust". */
  heading?: string;
}

const FIELD_BANDS: ConfidenceBand[] = [
  "confirmed",
  "likely",
  "uncertain",
  "conflicting",
  "missing",
];

export default function ExtractionTrustSummary({
  extraction,
  state,
  heading = "Extraction trust",
}: ExtractionTrustSummaryProps) {
  const resolved = state ?? resolveExtractionConfidence(extraction);
  const formatted = formatExtractionConfidence(resolved);

  const reviewed = Boolean(extraction?.reviewed_json);
  const summary = (extraction?.reviewed_json ?? extraction?.extracted_json ?? null) as
    | Record<string, unknown>
    | null;

  const bandCounts = useMemo(() => {
    if (!summary) return null;
    return FIELD_BANDS.reduce<Record<ConfidenceBand, number>>(
      (acc, band) => {
        acc[band] = countByBand(summary, reviewed, [band]);
        return acc;
      },
      { confirmed: 0, likely: 0, uncertain: 0, conflicting: 0, missing: 0 }
    );
  }, [summary, reviewed]);

  const confidenceTone = confidenceToneFor(resolved);
  const humanReviewLabel = reviewed ? "Reviewed by a person" : "Awaiting human review";
  const humanReviewTone: "success" | "warning" = reviewed ? "success" : "warning";

  return (
    <section
      className="atlas-trust"
      aria-labelledby="atlas-trust-heading"
    >
      <div className="atlas-trust__head">
        <h2 id="atlas-trust-heading" className="atlas-trust__heading">
          {heading}
        </h2>
        <p className="atlas-trust__hint">
          Overall extraction confidence, provenance, human review, and field-level evidence health.
        </p>
      </div>

      <dl className="atlas-trust__grid">
        <div className="atlas-trust__cell">
          <dt className="atlas-trust__label">Overall confidence</dt>
          <dd className="atlas-trust__value">
            <span
              className={`atlas-trust__metric atlas-trust__metric--${confidenceTone}`}
              data-available={resolved.state === "available" ? "true" : "false"}
            >
              {formatted.headline}
            </span>
            <p className="atlas-trust__explain">{formatted.explanation}</p>
          </dd>
        </div>

        <div className="atlas-trust__cell">
          <dt className="atlas-trust__label">Provenance</dt>
          <dd className="atlas-trust__value">
            <span className="atlas-trust__provenance">{formatted.provenance}</span>
          </dd>
        </div>

        <div className="atlas-trust__cell">
          <dt className="atlas-trust__label">Human review</dt>
          <dd className="atlas-trust__value">
            <StatusBadge
              status={{
                label: humanReviewLabel,
                tone: humanReviewTone,
                description: reviewed
                  ? "An underwriter has confirmed the extracted risk information."
                  : "Atlas read this from the documents. It is not underwriting fact until a person confirms it.",
              }}
            />
          </dd>
        </div>

        <div className="atlas-trust__cell atlas-trust__cell--wide">
          <dt className="atlas-trust__label">Field evidence</dt>
          <dd className="atlas-trust__value">
            {bandCounts ? (
              <ul className="atlas-trust__bands">
                {FIELD_BANDS.filter((band) => bandCounts[band] > 0).map((band) => (
                  <li key={band}>
                    <StatusBadge
                      status={{
                        ...CONFIDENCE_BAND[band],
                        label: `${bandCounts[band]} ${CONFIDENCE_BAND[band].label.toLowerCase()}`,
                      }}
                    />
                  </li>
                ))}
                {FIELD_BANDS.every((band) => bandCounts[band] === 0) && (
                  <li>
                    <span className="atlas-trust__provenance">No structured fields extracted.</span>
                  </li>
                )}
              </ul>
            ) : (
              <span className="atlas-trust__provenance">No fields to count.</span>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function confidenceToneFor(
  state: ExtractionConfidenceState
): "available" | "unavailable" | "not-recorded" | "legacy" {
  if (state.state === "available") return state.source === "legacy" ? "legacy" : "available";
  if (state.state === "unavailable") return "unavailable";
  return "not-recorded";
}
