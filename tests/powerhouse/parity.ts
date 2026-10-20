/**
 * Old-vs-new parity classification against the frozen production matcher.
 *
 * Every difference between matcher v1 (frozen reference) and the live matcher
 * must fall into a named class, or the comparison throws:
 *
 *   identical   every insurer's v1-projected answer AND the insurer order match
 *   order_only  every insurer's answer matches; only the order of equal-score
 *               insurers differs (v1: arrival order; v2: defined name/id order)
 *   tie_rule    an insurer's scored rule differs because several rules tied on
 *               taxonomy quality (v1: first row wins; v2: canonical-first wins)
 *
 * Anything else — a different score for an untied insurer, a different flag,
 * a different note — is UNEXPECTED and fails loudly.
 */

import type { MatchResult } from "../../worker/src/matcher.js";
import { projectV1 } from "./projection.js";

export type ParityClass = "identical" | "order_only" | "tie_rule";

function withoutOrder<T extends { position: number; rank: number | null }>(item: T) {
  const { position: _position, rank: _rank, ...rest } = item;
  return rest;
}

export function classifyParity(v1: MatchResult, v2: MatchResult): { class: ParityClass; differing: string[] } {
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
  if (differing.length === 0) {
    const sameOrder =
      JSON.stringify(a.insurers.map((i) => i.insurer_id)) === JSON.stringify(b.insurers.map((i) => i.insurer_id));
    if (sameOrder) return { class: "identical", differing: [] };
    // Ordering may only differ among insurers that are tied: the sequence of
    // (ruled_out, score) down the ranking must be exactly the same, so no
    // insurer moved past one with a better or worse outcome.
    const shape = (r: ReturnType<typeof projectV1>) => JSON.stringify(r.insurers.map((i) => [i.ruled_out, i.score]));
    if (shape(a) !== shape(b)) throw new Error("UNEXPECTED: ranking changed beyond the order of tied insurers");
    return { class: "order_only", differing: [] };
  }
  const explained = differing.every((id) => {
    const now = v2.insurers.find((item) => item.insurer_id === id);
    return now?.selection?.basis === "tie_broken_by_canonical_order";
  });
  if (!explained) throw new Error(`UNEXPECTED difference vs frozen v1 matcher for: ${differing.join(", ")}`);
  return { class: "tie_rule", differing };
}
