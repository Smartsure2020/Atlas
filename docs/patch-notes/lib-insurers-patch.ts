/**
 * Atlas Blueprint — patch for src/lib/insurers.ts
 * ----------------------------------------------------------------------------
 * Documentation only. APPEND this to the bottom of the existing
 * src/lib/insurers.ts (Phase 2A). Nothing in the file changes; this is purely
 * additive.
 * ============================================================================
 */

/*

// ---- Manual appetite rule creation (added in refine) ----

export function addAppetiteRule(
  insurerId: string,
  rule: {
    product_line: string;
    risk_type: string;
    appetite_level: "preferred" | "standard" | "caution" | "declined";
    preferred_risks?: string[];
    caution_risks?: string[];
    declined_risks?: string[];
    required_documents?: string[];
    referral_triggers?: string[];
    notes?: string;
  }
) {
  return api<{ ok: true; id: string }>(`/api/insurers/${insurerId}/appetite`, {
    method: "POST",
    body: JSON.stringify(rule),
  });
}

*/

export {}; // documentation file
