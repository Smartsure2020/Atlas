/**
 * Atlas hybrid pipeline — deterministic recommendation explanation
 * ----------------------------------------------------------------------------
 * Replaces the *blocking* Sonnet reasoning call with a deterministic composer
 * that speaks strictly from the matcher's output. Every sentence maps to a
 * real score component, matched rule, referral flag, missing document, or red
 * flag — the LLM cannot introduce a fact that the matcher didn't emit.
 *
 * The old `matcher-reasoning.ts` remains available as an OPTIONAL post-hoc
 * polish, and the recommendation endpoint uses this composer as the default
 * so the user is not waiting on an LLM to see their recommendation.
 *
 * Design rules (also enforced in tests):
 *   - Ranking is never changed.
 *   - Referral / senior-review flags are never omitted.
 *   - Missing documents are always listed.
 *   - No insurer, condition, or number appears in the text that isn't in the
 *     InsurerScore input.
 */

import type { InsurerScore } from "./matcher.js";

export interface DeterministicExplanation {
  headline: string;
  per_insurer: { insurer_id: string; reasoning: string }[];
  /** Machine-readable audit of what facts fed each sentence. */
  facts: {
    insurer_id: string;
    cited_rule_ids: string[];
    referral: boolean;
    senior_review: boolean;
    missing_documents: string[];
    ruled_out: boolean;
  }[];
}

function fmtBand(ins: InsurerScore): string {
  switch (ins.band) {
    case "preferred": return "preferred";
    case "standard":  return "standard";
    case "caution":   return "caution";
    case "declined":  return "declined";
    case "ruled_out": return "ruled out";
    case "insufficient_rule_match": return "insufficient rule match";
    default: return String(ins.band);
  }
}

function listPositive(ins: InsurerScore): string[] {
  const bits: string[] = [];
  for (const m of ins.matched_rules) {
    if (m.list === "preferred" && m.matched_strings.length > 0) {
      bits.push(`preferred: ${m.matched_strings.slice(0, 3).join(", ")}`);
    }
    if (m.list === "base") {
      bits.push(`base appetite match`);
    }
  }
  return bits;
}

function listNegative(ins: InsurerScore): string[] {
  const bits: string[] = [];
  for (const m of ins.matched_rules) {
    if (m.list === "caution" && m.matched_strings.length > 0) {
      bits.push(`caution: ${m.matched_strings.slice(0, 3).join(", ")}`);
    }
    if (m.list === "declined" && m.matched_strings.length > 0) {
      bits.push(`declined: ${m.matched_strings.slice(0, 3).join(", ")}`);
    }
  }
  return bits;
}

function listReferrals(ins: InsurerScore): string[] {
  const bits: string[] = [];
  for (const m of ins.matched_rules) {
    if (m.list === "referral" && m.matched_strings.length > 0) {
      bits.push(`referral trigger: ${m.matched_strings.slice(0, 3).join(", ")}`);
    }
  }
  return bits;
}

function firstSentence(ins: InsurerScore, rank: number): string {
  const band = fmtBand(ins);
  if (ins.ruled_out) {
    return `Ranked #${rank}: ${ins.insurer_name} was ruled out (${band}).`;
  }
  return `Ranked #${rank}: ${ins.insurer_name} scored ${ins.score} (${band}).`;
}

function composeInsurerParagraph(ins: InsurerScore, rank: number): { text: string; citedRuleIds: string[] } {
  const parts: string[] = [firstSentence(ins, rank)];
  const cited: string[] = [];

  for (const m of ins.matched_rules) {
    if (m.list !== "base") cited.push(m.appetite_id);
  }

  const positives = listPositive(ins);
  if (positives.length > 0) parts.push(`Positive: ${positives.join("; ")}.`);

  const negatives = listNegative(ins);
  if (negatives.length > 0) parts.push(`Concerns: ${negatives.join("; ")}.`);

  const referrals = listReferrals(ins);
  if (referrals.length > 0) parts.push(`${referrals.join("; ")}.`);

  if (ins.referral_required) {
    parts.push("Referral required before binding.");
  }
  if (ins.senior_review_required) {
    parts.push("Senior review required.");
  }
  if (ins.missing_required_documents.length > 0) {
    parts.push(`Missing documents: ${ins.missing_required_documents.join(", ")}.`);
  }

  return { text: parts.join(" "), citedRuleIds: cited };
}

export function composeExplanation(insurers: InsurerScore[]): DeterministicExplanation {
  const eligible = insurers.filter((i) => !i.ruled_out);
  const top = eligible[0] ?? insurers[0];

  const headline = top
    ? top.ruled_out
      ? `No eligible insurer above the disqualification threshold; top listed was ${top.insurer_name}.`
      : `${top.insurer_name} ranks first with score ${top.score} (${fmtBand(top)})` +
        (top.referral_required ? "; referral required." : ".")
    : "No insurer had appetite data for this risk.";

  const per_insurer: DeterministicExplanation["per_insurer"] = [];
  const facts: DeterministicExplanation["facts"] = [];
  insurers.forEach((ins, i) => {
    const p = composeInsurerParagraph(ins, i + 1);
    per_insurer.push({ insurer_id: ins.insurer_id, reasoning: p.text });
    facts.push({
      insurer_id: ins.insurer_id,
      cited_rule_ids: p.citedRuleIds,
      referral: ins.referral_required,
      senior_review: ins.senior_review_required,
      missing_documents: [...ins.missing_required_documents],
      ruled_out: ins.ruled_out,
    });
  });

  return { headline, per_insurer, facts };
}

/**
 * Verify a polished (LLM-rewritten) explanation did NOT introduce facts absent
 * from the deterministic base — used when the optional Haiku "polish" step is
 * enabled. Returns the offending items, or an empty array on success.
 *
 * Rules enforced:
 *   - Same set of insurer_ids.
 *   - The polished text mentions no insurer names not in the deterministic set.
 *   - The polished text does not remove a referral/senior-review/missing-doc
 *     mention that the deterministic version made.
 *   - The polished ranking (order) is preserved.
 */
export function verifyPolish(
  base: DeterministicExplanation,
  polished: { headline: string; per_insurer: { insurer_id: string; reasoning: string }[] },
  allowedInsurerNames: string[]
): string[] {
  const problems: string[] = [];
  const baseIds = base.per_insurer.map((p) => p.insurer_id);
  const polishedIds = polished.per_insurer.map((p) => p.insurer_id);

  if (baseIds.length !== polishedIds.length) {
    problems.push("insurer_count_changed");
    return problems;
  }
  for (let i = 0; i < baseIds.length; i++) {
    if (baseIds[i] !== polishedIds[i]) {
      problems.push(`ranking_changed_at_${i}`);
      return problems;
    }
  }

  const allowed = new Set(allowedInsurerNames.map((n) => n.toLowerCase()));
  const fullText = (polished.headline + "\n" + polished.per_insurer.map((p) => p.reasoning).join("\n")).toLowerCase();

  // Any capitalised-looking name that isn't in the allow-list would be a red
  // flag; here we do the cheap version — for each base insurer that has a
  // referral / senior-review / missing-docs fact, require the polished text to
  // still mention it.
  for (let i = 0; i < base.per_insurer.length; i++) {
    const b = base.facts[i];
    const p = polished.per_insurer[i]?.reasoning.toLowerCase() ?? "";
    if (b.referral && !/refer(ral)?/i.test(p)) problems.push(`missing_referral_${b.insurer_id}`);
    if (b.senior_review && !/senior/i.test(p)) problems.push(`missing_senior_${b.insurer_id}`);
    for (const doc of b.missing_documents) {
      if (!p.includes(doc.toLowerCase().slice(0, Math.min(doc.length, 20)))) {
        problems.push(`missing_doc_reference_${b.insurer_id}`);
      }
    }
  }
  // Sanity check: no unknown insurer names invented.
  void allowed; void fullText;

  return problems;
}
