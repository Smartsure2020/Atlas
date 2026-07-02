/**
 * Atlas Blueprint — decision gate rules
 * ----------------------------------------------------------------------------
 * Pure logic for the security-critical decision checks, extracted from
 * decision-endpoints.ts so it can be unit-tested without a Supabase stub.
 *
 * Two rules live here:
 *
 * (1) RULED-OUT OVERRIDE NEEDS A MANAGER. Selecting an insurer the matcher
 *     ruled out contradicts a hard appetite rule; only manager/admin may do
 *     it. The check matches by insurer_id when both sides carry one (exact),
 *     falling back to case-insensitive name comparison. It applies to ANY
 *     decision that selects a ruled-out insurer — including one claiming
 *     ai_recommendation_accepted, since the matcher's top pick is never a
 *     ruled-out insurer, so such a claim cannot be a genuine accept.
 *
 * (2) PROCEEDING NEEDS A RECOMMENDATION. A proceed/override decision that
 *     names an insurer must be judged against a recommendation. The SERVER
 *     resolves which one (client-supplied id, else the latest for the
 *     submission); if none exists at all, the decision is refused rather than
 *     silently skipping the ruled-out check. Close-out decisions (refer,
 *     request_info, decline, closed) remain valid without one.
 */

export interface RuledOutEntry {
  insurer_id?: string | null;
  insurer_name?: string | null;
}

export interface RecommendationForGate {
  id: string;
  recommended_insurer: string | null;
  not_recommended_json: RuledOutEntry[];
}

export type DecisionGateInput = {
  decisionChoice?: string | null;
  decisionStatus?: string | null;
  selectedInsurer?: string | null;
  selectedInsurerId?: string | null;
  recommendation: RecommendationForGate | null;
  /** roleCanManageAppetite(user.role) — manager/admin. */
  canManage: boolean;
};

export type DecisionGateResult =
  | { ok: true; ruledOutOverride: boolean }
  | { ok: false; error: "recommendation_required" | "ruled_out_override_forbidden" };

/** Does the selected insurer appear in the recommendation's ruled-out list? */
export function isRuledOutSelection(
  recommendation: RecommendationForGate | null,
  selectedInsurer?: string | null,
  selectedInsurerId?: string | null
): boolean {
  if (!recommendation) return false;
  const ruledOut = recommendation.not_recommended_json ?? [];
  const selId = selectedInsurerId?.trim() || null;
  const selName = selectedInsurer?.trim().toLowerCase() || null;
  return ruledOut.some((r) => {
    if (selId && r.insurer_id && r.insurer_id === selId) return true;
    if (selName && (r.insurer_name ?? "").trim().toLowerCase() === selName) return true;
    return false;
  });
}

/** Is this decision moving the submission forward with a named insurer? */
function isProceedLike(input: DecisionGateInput): boolean {
  return (
    input.decisionChoice === "proceed" ||
    input.decisionChoice === "override" ||
    input.decisionStatus === "ready_for_quote"
  );
}

export function evaluateDecisionGate(input: DecisionGateInput): DecisionGateResult {
  const hasSelection = Boolean(input.selectedInsurer?.trim() || input.selectedInsurerId?.trim());

  // (2) Proceeding with an insurer requires a recommendation to judge against.
  if (!input.recommendation && hasSelection && isProceedLike(input)) {
    return { ok: false, error: "recommendation_required" };
  }

  // (1) Ruled-out selection is manager/admin only, whatever the flags claim.
  if (hasSelection && isRuledOutSelection(input.recommendation, input.selectedInsurer, input.selectedInsurerId)) {
    if (!input.canManage) return { ok: false, error: "ruled_out_override_forbidden" };
    return { ok: true, ruledOutOverride: true };
  }

  return { ok: true, ruledOutOverride: false };
}
