/**
 * Atlas Blueprint — Recommendation panel
 * ----------------------------------------------------------------------------
 * Drops into SubmissionDetail.tsx as its own section, beneath the extraction.
 * This is the surface where Phase 2B's matcher output lands — and where the
 * GovernanceDisclaimer finally renders for the first time, as a fixed element
 * at the top, never dismissible.
 *
 * States:
 *   - no extraction yet         → quiet placeholder (parent has the extract UI)
 *   - extraction not reviewed   → run button disabled, hint to review first
 *   - reviewed, no rec yet      → run button enabled
 *   - running                   → "Computing recommendation…"
 *   - cached recommendation     → full render + re-run button
 *   - error                     → inline error + retry
 */

import { useEffect, useState } from "react";
import { GovernanceDisclaimer } from "../components/GovernanceDisclaimer";
import {
  getRecommendation,
  runRecommendation,
  type Recommendation,
  type ScoredInsurer,
} from "../lib/recommendations";

interface Props {
  submissionId: string;
  /** From the submission detail load: whether an extraction exists at all, and
   *  whether its reviewed_json is set. Used to gate the Run button. */
  extractionExists: boolean;
  extractionReviewed: boolean;
  /** Bumps when the parent saves a review, so we can refresh state. */
  reviewVersion?: number;
}

export default function RecommendationPanel({
  submissionId,
  extractionExists,
  extractionReviewed,
  reviewVersion = 0,
}: Props) {
  const [loading, setLoading] = useState(true);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await getRecommendation(submissionId);
      setRecommendation(res.recommendation);
    } catch {
      // Quiet on initial load — most likely "no recommendation yet" rather
      // than a real failure; the user will retry via the run button.
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [submissionId, reviewVersion]);

  async function onRun(force = false) {
    setRunning(true);
    setError(null);
    try {
      const res = await runRecommendation(submissionId, { force });
      if (res.skipped && res.message) setError(res.message);
      await load();
    } catch (e) {
      const msg = (e as Error).message;
      setError(
        msg === "extraction_not_reviewed"
          ? "Review the extraction before running a recommendation."
          : msg === "no_extraction"
          ? "Run the extraction first."
          : msg === "matrix_empty"
          ? "No active appetite rules in the matrix yet — a manager needs to populate the Insurers section."
          : "Could not compute the recommendation. Please try again."
      );
    } finally {
      setRunning(false);
    }
  }

  // -- Initial loading shimmer is brief; only show if it actually takes a moment --
  if (loading && !recommendation) {
    return null; // don't flash an empty panel
  }

  // No extraction at all → parent screen surfaces the Extract button; we're quiet.
  if (!extractionExists) {
    return null;
  }

  // Header: always shows the disclaimer above any recommendation content, even
  // when there's nothing to recommend yet. The disclaimer is unconditional.
  return (
    <div className="atlas-card atlas-reco">
      <GovernanceDisclaimer />

      <div className="atlas-card__head">
        <h3 className="atlas-h3">Insurer recommendation</h3>
        <div className="atlas-card__actions">
          {recommendation && (
            <span className="atlas-muted" style={{ fontSize: 12 }}>
              {new Date(recommendation.created_at).toLocaleString()}
            </span>
          )}
          <button
            className="atlas-btn atlas-btn--primary atlas-btn--small"
            onClick={() => onRun()}
            disabled={running || !extractionReviewed}
            title={
              !extractionReviewed
                ? "Review the extraction before running a recommendation."
                : recommendation
                ? "Re-run against the current reviewed extraction."
                : ""
            }
          >
            {running
              ? "Computing…"
              : recommendation
              ? "Re-run recommendation"
              : "Run recommendation"}
          </button>
          {recommendation && (
            <button
              className="atlas-btn atlas-btn--small"
              onClick={() => onRun(true)}
              disabled={running || !extractionReviewed}
              title="Force a new run even if Atlas thinks inputs are unchanged."
            >
              Force rerun
            </button>
          )}
        </div>
      </div>

      {!extractionReviewed && (
        <div
          className="atlas-disclaimer"
          role="note"
          style={{ marginTop: 0 }}
        >
          <span className="atlas-disclaimer__mark" aria-hidden="true">ⓘ</span>
          <div className="atlas-disclaimer__text">
            <strong>Review the extraction before running a recommendation.</strong>
            <ol style={{ margin: "6px 0 0 18px", padding: 0, fontSize: 13 }}>
              <li>Click <em>Correct</em> on the risk summary above.</li>
              <li>Edit anything Claude misread, then click <em>Save corrections</em>.</li>
              <li>The <em>Run recommendation</em> button below will enable.</li>
            </ol>
          </div>
        </div>
      )}

      {error && <div className="atlas-inline-error" style={{ marginTop: 12 }}>{error}</div>}

      {recommendation && <RecommendationView rec={recommendation} />}
    </div>
  );
}

// ----------------------------------------------------------------------------
// The full rendered recommendation
// ----------------------------------------------------------------------------

function RecommendationView({ rec }: { rec: Recommendation }) {
  const top = rec.reasoning_json.top;
  return (
    <div className="atlas-reco__body">
      <p className="atlas-reco__headline">{rec.reasoning_json.headline}</p>

      {top ? (
        <InsurerBlock insurer={top} variant="top" />
      ) : (
        <div className="atlas-reco__nothing">
          No insurer scored above the disqualification threshold for this risk.
        </div>
      )}

      {rec.secondary_options_json.length > 0 && (
        <>
          <div className="atlas-reco__divider">Secondary options</div>
          {rec.secondary_options_json.map((ins) => (
            <InsurerBlock key={ins.insurer_id} insurer={ins} variant="secondary" />
          ))}
        </>
      )}

      {rec.not_recommended_json.length > 0 && (
        <>
          <div className="atlas-reco__divider">Not recommended</div>
          {rec.not_recommended_json.map((ins) => (
            <InsurerBlock key={ins.insurer_id} insurer={ins} variant="ruled_out" />
          ))}
        </>
      )}

      {rec.reasoning_json.no_data_for?.length > 0 && (
        <div className="atlas-reco__nodata">
          <strong>No appetite data on file for:</strong>{" "}
          {rec.reasoning_json.no_data_for.map((i) => i.insurer_name).join(", ")}
          {" — these insurers have no active appetite rules in the matrix, so Atlas could not consider them. This is a data gap, not a rejection."}
        </div>
      )}
    </div>
  );
}

function InsurerBlock({
  insurer,
  variant,
}: {
  insurer: ScoredInsurer;
  variant: "top" | "secondary" | "ruled_out";
}) {
  return (
    <div className={`atlas-reco__insurer atlas-reco__insurer--${variant} atlas-reco__insurer--${insurer.band}`}>
      <div className="atlas-reco__insurer-head">
        <div className="atlas-reco__insurer-name">{insurer.insurer_name}</div>
        <div className="atlas-reco__insurer-meta">
          {!insurer.ruled_out && (
            <span className="atlas-reco__score">Score {insurer.score}</span>
          )}
          <span className={`atlas-level atlas-level--${insurer.band}`}>{insurer.band}</span>
          {insurer.referral_required && (
            <span className="atlas-flag atlas-flag--referral">Referral</span>
          )}
          {insurer.senior_review_required && (
            <span className="atlas-flag atlas-flag--senior">Senior review</span>
          )}
          {insurer.manual_review_required && (
            <span className="atlas-flag atlas-flag--manual">Manual review</span>
          )}
          {!insurer.ruled_out && (
            <span className="atlas-muted" style={{ fontSize: 12 }}>
              · confidence {Math.round(insurer.confidence * 100)}%
            </span>
          )}
        </div>
      </div>

      {insurer.reasoning && (
        <p className="atlas-reco__reasoning">{insurer.reasoning}</p>
      )}

      {insurer.manual_review_required && (
        <div className="atlas-reco__manual">
          The matrix did not contain a reliable product-level rule for this submission. Review the unmatched sections before treating this as a recommendation.
        </div>
      )}

      <details className="atlas-reco__detail">
        <summary>Show matched rules and scoring detail</summary>
        <div className="atlas-reco__detail-body">
          {(insurer.matched_rules ?? [])
            .map((m, i) => (
              <div key={i} className="atlas-reco__matched">
                <span className={`atlas-tone--${
                  m.list === "preferred" ? "ok"
                  : m.list === "declined" || m.list === "portfolio_declined" ? "danger"
                  : m.list === "caution" || m.list === "referral" || m.list === "portfolio_caution" || m.list === "portfolio_referral" ? "warn"
                  : "neutral"
                }`}>
                  {m.list}
                </span>
                : {m.matched_strings.join("; ") || `${m.rule_product_line ?? "rule"} / ${m.rule_risk_type ?? "rule"}`}
                {(m.source_file_name || m.source_section || m.source_page || m.source_quote) && (
                  <div className="atlas-reco__evidence">
                    {[m.source_file_name, m.source_section, m.source_page ? `page ${m.source_page}` : null]
                      .filter(Boolean)
                      .join(" / ")}
                    {m.source_quote && <blockquote>{m.source_quote}</blockquote>}
                  </div>
                )}
              </div>
            ))}
          {((insurer.unmatched_sections ?? []).length > 0 ||
            (insurer.unmatched_product_candidates ?? []).length > 0 ||
            (insurer.nearby_rule_matches ?? []).length > 0) && (
            <div className="atlas-reco__matched atlas-tone--warn">
              {(insurer.unmatched_sections ?? []).length > 0 && (
                <div><strong>Unmatched sections:</strong> {(insurer.unmatched_sections ?? []).join("; ")}</div>
              )}
              {(insurer.unmatched_product_candidates ?? []).length > 0 && (
                <div><strong>Unmatched products:</strong> {(insurer.unmatched_product_candidates ?? []).join("; ")}</div>
              )}
              {(insurer.nearby_rule_matches ?? []).length > 0 && (
                <div><strong>Nearby rules:</strong> {(insurer.nearby_rule_matches ?? []).join("; ")}</div>
              )}
            </div>
          )}
          {(insurer.missing_required_documents ?? []).length > 0 && (
            <div className="atlas-reco__matched atlas-tone--warn">
              <strong>Missing required documents:</strong>{" "}
              {(insurer.missing_required_documents ?? []).join("; ")}
            </div>
          )}
          {(insurer.scoring_notes ?? []).length > 0 && (
            <ul className="atlas-reco__notes">
              {(insurer.scoring_notes ?? []).map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          )}
        </div>
      </details>
    </div>
  );
}
