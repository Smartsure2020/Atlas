/**
 * Atlas Blueprint — Governance disclaimer
 * ----------------------------------------------------------------------------
 * Renders on EVERY recommendation. This is a governance requirement, not
 * decoration: Atlas is decision-support only. It is a single shared component
 * (one source of truth for the wording) and is intended to be a fixed part of
 * the recommendation surface, not an easily-removed afterthought.
 */

const DISCLAIMER_TEXT =
  "Atlas provides decision-support only. Final underwriting decisions, insurer " +
  "selection, pricing, discounts, and quote terms must be reviewed and approved " +
  "by an authorised underwriter.";

export function GovernanceDisclaimer() {
  return (
    <div className="atlas-disclaimer" role="note" aria-label="Governance notice">
      <span className="atlas-disclaimer__mark" aria-hidden="true">
        ⚠
      </span>
      <p className="atlas-disclaimer__text">{DISCLAIMER_TEXT}</p>
    </div>
  );
}

export { DISCLAIMER_TEXT };
