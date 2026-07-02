/**
 * Atlas Blueprint — patch for worker/src/recommendation-endpoints.ts
 * ----------------------------------------------------------------------------
 * The deriveRisk() function changes shape. Before, it picked a single
 * product_line and a single risk_type from the extraction. Now it builds
 * CANDIDATE LISTS, drawing from every place in the extraction where "what
 * cover does this submission need" naturally lives.
 *
 * Why: the diagnostic showed Claude's extraction had put cover information
 * across three places:
 *   - cover_sections (e.g. "Office Contents", "Public Liability", "Motor
 *     Commercial", "Electronic Equipment", "SASRIA")  ← the gold here
 *   - secondary_risk_types (e.g. "Motor Commercial (3 vehicles - LDVs)",
 *     "Electronic Equipment", "Office Contents")
 *   - primary_risk_type (e.g. "Commercial - Electrical Contractor")  ← industry
 *
 * The matcher needs the *cover* values to match appetite rows organised by
 * cover section. By passing all candidates forward, the matcher's substring
 * logic can find the best alignment for each insurer rule.
 *
 * One edit. Find the existing deriveRisk() function and replace it with the
 * version below. Also update the call to matchInsurers() — the input shape
 * changed; old field names are gone.
 * ============================================================================
 */

// ----- REPLACE the existing deriveRisk() function with this: -----

/*

function deriveRisk(
  reviewed: Record<string, unknown>,
  availableDocs: string[]
): MatchInputRisk {
  const rc = (reviewed.risk_classification as Record<string, unknown>) ?? {};
  const cc = (reviewed.current_cover as Record<string, unknown>) ?? {};
  const ec = (reviewed.extracted_client as Record<string, unknown>) ?? {};

  // Helper: take a fieldStr() value and break a "A, B, C" or a JS array into
  // individual candidate strings so each can match an appetite row independently.
  const splitCandidates = (s: string): string[] =>
    s
      .split(/[,;]|\bor\b|\band\b/i)
      .map((x) => x.trim())
      .filter((x) => x.length > 0);

  // PRODUCT CANDIDATES — every label that describes WHAT COVER this submission
  // needs, in priority of specificity:
  //   1. current_cover.cover_sections is gold — these are literally the sections
  //      of cover ("Office Contents", "Motor Commercial"). They map straight to
  //      appetite rows organised by product line.
  //   2. risk_classification.secondary_risk_types — often the same set, phrased
  //      slightly differently by the extraction prompt.
  //   3. risk_classification.primary_risk_type — sometimes an industry label
  //      (poor for matching), sometimes a cover label (great). Included as a
  //      fallback candidate.
  const productCandidates: string[] = [];
  productCandidates.push(...splitCandidates(fieldStr(cc.cover_sections)));
  productCandidates.push(...splitCandidates(fieldStr(rc.secondary_risk_types)));
  const primaryRiskType = fieldStr(rc.primary_risk_type);
  if (primaryRiskType) productCandidates.push(primaryRiskType);

  // RISK CANDIDATES — labels that describe the KIND of risk (commercial vs
  // personal, body corporate vs free-standing, etc.). Drawn from business
  // sector, secondary types (some carry kind information), and complexity.
  const riskCandidates: string[] = [];
  const businessSector = fieldStr(rc.business_sector);
  if (businessSector) riskCandidates.push(...splitCandidates(businessSector));
  riskCandidates.push(...splitCandidates(fieldStr(rc.secondary_risk_types)));
  if (primaryRiskType) riskCandidates.push(primaryRiskType);
  const complexity = fieldStr(rc.complexity_level);
  if (complexity) riskCandidates.push(complexity);

  // Features pool unchanged — broad text the matcher's substring logic can
  // scan against an appetite row's preferred/caution/declined lists.
  const features: string[] = [];
  const push = (s: string) => { if (s) features.push(s); };
  push(fieldStr(rc.primary_risk_type));
  push(fieldStr(rc.secondary_risk_types));
  push(fieldStr(rc.business_sector));
  push(fieldStr(rc.complexity_level));
  push(fieldStr(ec.occupation_or_business_description));
  push(fieldStr(ec.risk_address));
  push(fieldStr(ec.entity_type));
  push(fieldStr(cc.cover_sections));
  push(fieldStr(cc.endorsements));
  push(fieldStr(cc.exclusions));
  const reds = (reviewed.red_flags as { issue?: string }[]) ?? [];
  for (const r of reds) if (r?.issue) push(r.issue);

  const overall_confidence =
    typeof reviewed.overall_confidence === "number" ? reviewed.overall_confidence : 0.7;

  return {
    product_candidates: productCandidates,
    risk_candidates: riskCandidates,
    features,
    available_documents: availableDocs,
    overall_confidence,
  };
}

*/


// ----- The call site doesn't change.
//
//   const risk = deriveRisk(reviewedJson, availableDocs);
//   ...
//   const result = matchInsurers(risk, appetite);
//
// matchInsurers's signature is unchanged (still takes MatchInputRisk); only
// the shape of MatchInputRisk changed, which is fully internal to the
// matcher import.
// ============================================================================

export {}; // documentation file
