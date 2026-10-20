/**
 * Old-vs-new parity classification against the frozen production matcher.
 *
 * Every difference between matcher v1 (frozen reference) and the live matcher
 * must fall into a named class, or the comparison throws:
 *
 *   identical        every insurer's v1-projected answer AND the insurer order match
 *   order_only        every insurer's answer matches; only the order of equal-score
 *                     insurers differs (v1: arrival order; v2: defined name/id order).
 *                     The ranking SHAPE — (ruled_out, score) down the list — must be
 *                     identical, so no insurer moved past a better or worse one.
 *   tie_rule          an insurer's scored rule differs because several rules tied on
 *                     taxonomy quality (v1: first row wins; v2: canonical-first wins)
 *   portfolio_order   an insurer with TWO OR MORE active portfolio rules, where the
 *                     rows arrive in a different order. Portfolio rules are applied in
 *                     row order (a hard decline stops the loop), so the descriptive
 *                     trail — matched_rules order, scoring notes, the portfolio rule an
 *                     insurer is "scored against" when ruled out, score components, the
 *                     order of required-document evidence — can differ while every
 *                     AUTHORITATIVE field is equal: score, band, rule status, ruled_out,
 *                     referral / manual / senior-review flags, confidence and its
 *                     availability, and the SET of missing required documents.
 *
 * Anything else — a different score for an untied insurer, a different flag, a
 * different note on a single-portfolio insurer — is UNEXPECTED and fails loudly.
 */

import type { MatchResult } from "../../worker/src/matcher.js";
import { projectV1 } from "./projection.js";

export type ParityClass = "identical" | "order_only" | "tie_rule" | "portfolio_order";

export interface ParityContext {
  /** Active portfolio-rule count per insurer id (enables the portfolio_order class). */
  portfolioRuleCounts?: ReadonlyMap<string, number>;
}

export interface ParityResult {
  /** The fixture-level class (precedence: tie_rule > portfolio_order > order_only > identical). */
  class: ParityClass;
  differing: string[];
  /** Differing insurers by the reason each is explained. */
  byClass: { tie_rule: string[]; portfolio_order: string[] };
}

function withoutOrder<T extends { position: number; rank: number | null }>(item: T) {
  const { position: _position, rank: _rank, ...rest } = item;
  return rest;
}

type Projected = ReturnType<typeof projectV1>["insurers"][number];

/** The authoritative fields only; descriptive trails (notes, matched order…) are excluded. */
function authoritative(item: Projected) {
  return {
    score: item.score,
    band: item.band,
    rule_status: item.rule_status,
    ruled_out: item.ruled_out,
    referral_required: item.referral_required,
    manual_review_required: item.manual_review_required,
    senior_review_required: item.senior_review_required,
    confidence: item.confidence,
    confidence_available: item.confidence_available,
    missing_required_documents: [...item.missing_required_documents].sort(),
  };
}

export function classifyParity(v1: MatchResult, v2: MatchResult, context: ParityContext = {}): ParityResult {
  const a = projectV1(v1);
  const b = projectV1(v2);
  const aById = new Map(a.insurers.map((item) => [item.insurer_id, item]));
  const bById = new Map(b.insurers.map((item) => [item.insurer_id, item]));
  if (aById.size !== bById.size || [...aById.keys()].some((id) => !bById.has(id))) {
    throw new Error("UNEXPECTED: v1 and v2 disagree on which insurers were scored");
  }
  const differing: string[] = [];
  for (const [id, old] of aById) {
    if (JSON.stringify(withoutOrder(old)) !== JSON.stringify(withoutOrder(bById.get(id)!))) differing.push(id);
  }
  const shape = (r: ReturnType<typeof projectV1>) => JSON.stringify(r.insurers.map((i) => [i.ruled_out, i.score]));
  const byClass = { tie_rule: [] as string[], portfolio_order: [] as string[] };

  if (differing.length === 0) {
    const sameOrder =
      JSON.stringify(a.insurers.map((i) => i.insurer_id)) === JSON.stringify(b.insurers.map((i) => i.insurer_id));
    if (sameOrder) return { class: "identical", differing: [], byClass };
    if (shape(a) !== shape(b)) throw new Error("UNEXPECTED: ranking changed beyond the order of tied insurers");
    return { class: "order_only", differing: [], byClass };
  }

  for (const id of differing) {
    const now = v2.insurers.find((item) => item.insurer_id === id);
    if (now?.selection?.basis === "tie_broken_by_canonical_order") {
      byClass.tie_rule.push(id);
      continue;
    }
    const portfolioRules = context.portfolioRuleCounts?.get(id) ?? 0;
    const sameAuthority = JSON.stringify(authoritative(aById.get(id)!)) === JSON.stringify(authoritative(bById.get(id)!));
    if (portfolioRules >= 2 && sameAuthority) {
      byClass.portfolio_order.push(id);
      continue;
    }
    throw new Error(`UNEXPECTED difference vs frozen v1 matcher for ${id} (portfolio rules: ${portfolioRules}, authoritative fields equal: ${sameAuthority})`);
  }
  return {
    class: byClass.tie_rule.length > 0 ? "tie_rule" : "portfolio_order",
    differing,
    byClass,
  };
}
