/**
 * Atlas Blueprint — HOUSE RULES (internal underwriting heuristics)
 * ----------------------------------------------------------------------------
 * ⚠ These checks are NOT sourced from any insurer guideline or appetite
 * document. They are Smartsure house heuristics that were previously hardcoded
 * inside quote-review.ts. They live here, in one reviewable place, so the
 * underwriting team owns them explicitly: add, remove, or adjust deliberately,
 * and know that findings produced from this file are labelled "House rule" in
 * quote-review output rather than presented as insurer appetite.
 *
 * If a rule here should really be insurer-specific, it belongs in the
 * atlas_insurer_appetite matrix (as caution_risks / referral_triggers /
 * required_documents), not in this file.
 */

/**
 * Cover sections that warrant a second look when they are the ONLY section
 * being quoted (moral-hazard / anti-selection concern when written in
 * isolation).
 */
export const ISOLATION_SENSITIVE_SECTIONS = new Set([
  "public_liability",
  "theft",
  "business_all_risks",
  "accidental_damage",
  "accounts_receivable",
]);

/**
 * Section-name terms that normally carry an excess; a quote for such a
 * section with no excess stated should be reviewed rather than assumed free.
 */
export const EXCESS_SENSITIVE_SECTION_TERMS = [
  "theft",
  "glass",
  "accidental",
  "electronic",
  "fire",
  "motor",
];

/**
 * Business-description exposure checks: when the insured's occupation matches
 * `businessPattern` and none of the quoted section keys satisfies
 * `hasExpectedSection`, the quote review raises `finding`.
 */
export interface BusinessExposureRule {
  businessPattern: RegExp;
  hasExpectedSection: (quotedSectionKeys: string[]) => boolean;
  finding: string;
}

export const BUSINESS_EXPOSURE_RULES: BusinessExposureRule[] = [
  {
    businessPattern: /restaurant|hotel|food|franchise/,
    hasExpectedSection: (keys) => keys.includes("public_liability"),
    finding:
      "House rule: food or hospitality exposure detected without a clear liability/product liability section.",
  },
  {
    businessPattern: /motor|vehicle|fleet|transport|delivery|courier/,
    hasExpectedSection: (keys) => keys.some((k) => k.includes("motor") || k === "goods_in_transit"),
    finding:
      "House rule: motor or transit exposure detected without a clear motor/GIT section.",
  },
];
