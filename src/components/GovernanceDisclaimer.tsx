/**
 * Atlas Blueprint — Governance disclaimer
 * ----------------------------------------------------------------------------
 * Renders on EVERY recommendation. This is a governance requirement, not
 * decoration: Atlas is decision-support only. It is a single shared component
 * (one source of truth for the wording) and is intended to be a fixed part of
 * the recommendation surface, not an easily-removed afterthought.
 */

import { Notice } from "./ui";

const DISCLAIMER_TEXT =
  "Atlas provides decision-support only. Final underwriting decisions, insurer " +
  "selection, pricing, discounts, and quote terms must be reviewed and approved " +
  "by an authorised underwriter.";

export function GovernanceDisclaimer() {
  return (
    <Notice tone="warning" role="note" title="Decision-support only">
      {DISCLAIMER_TEXT}
    </Notice>
  );
}

export { DISCLAIMER_TEXT };
