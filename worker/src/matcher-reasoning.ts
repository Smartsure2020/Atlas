/**
 * Atlas Blueprint — recommendation reasoning pass
 * ----------------------------------------------------------------------------
 * Takes the matcher's deterministic InsurerScore[] and asks Claude to write
 * the underwriter-facing explanation around each score. The model is given the
 * numbers, the matched rule lists, and the source quotes from the appetite
 * matrix, and is instructed ONLY to explain — never to produce or alter the
 * scores, never to recommend a different insurer than the matcher's top result.
 *
 * If the reasoning call fails for any reason, the recommendation is still
 * usable: we fall back to a structured assembly of the scoring_notes. This
 * matters — the matcher must remain the source of truth, and the LLM is a
 * presentation layer that can degrade without breaking the recommendation.
 */

import type { InsurerScore } from "./matcher";

export const REASONING_MODEL = "claude-sonnet-4-6";

export const REASONING_SYSTEM_PROMPT = `
You are the reasoning writer for Atlas, an internal underwriting decision-
support tool at a South African short-term insurance administrator.

You are NOT the recommendation engine. The recommendation has already been
computed by deterministic code against the configured appetite matrix. Your
ONLY job is to write the human-readable explanation for the underwriter,
strictly faithful to the numbers and matched rules you are given.

ABSOLUTE RULES:
- Do NOT invent rules, conditions, or appetite information not in the input.
- Do NOT change, justify, or argue with the scores. Take them as given.
- Do NOT recommend a different insurer than the top-ranked one.
- Do NOT produce, suggest, or imply premiums, discounts, or quote terms.
- Each per-insurer explanation must reference at least one of the matched
  rule lists ("preferred", "caution", "referral", "declined", or "base")
  it was given. If the only thing to cite is the base appetite, say so.
- Tone: concise, professional, underwriter-to-underwriter. No marketing
  language, no praise of insurers, no hedging beyond what the rules say.
- Each explanation under 60 words.

Return ONLY a single JSON object in this exact shape:

{
  "headline": "one-sentence summary of the recommendation (under 25 words)",
  "per_insurer": [
    { "insurer_id": "<uuid>", "reasoning": "<under 60 words>" }
  ]
}

Cover every insurer_id that appears in the input. No prose outside the JSON.
`.trim();

export interface ReasoningOutput {
  headline: string;
  per_insurer: { insurer_id: string; reasoning: string }[];
}

/** Build the user-message content the model sees. Only data the model needs. */
export function buildReasoningInput(args: {
  riskSummary: string;
  insurers: InsurerScore[];
  appetiteContext: Map<string, { source_quote?: string; notes?: string | null }>;
}): string {
  const lines: string[] = [];
  lines.push("RISK SUMMARY (extracted, human-reviewed):");
  lines.push(args.riskSummary);
  lines.push("");
  lines.push("MATCHER OUTPUT (do not alter):");
  for (const ins of args.insurers) {
    lines.push(
      `- ${ins.insurer_name} [${ins.insurer_id}] — score ${ins.score}, ` +
        `band ${ins.band}, confidence ${ins.confidence.toFixed(2)}` +
        (ins.referral_required ? ", REFERRAL_REQUIRED" : "") +
        (ins.senior_review_required ? ", SENIOR_REVIEW" : "") +
        (ins.ruled_out ? ", RULED_OUT" : "")
    );
    for (const m of ins.matched_rules) {
      if (m.list === "base") continue;
      const ctx = args.appetiteContext.get(m.appetite_id);
      const src = ctx?.source_quote ? ` [source: "${ctx.source_quote}"]` : "";
      lines.push(
        `    · ${m.list} match: ${m.matched_strings.join("; ") || "(rule-level)"}${src}`
      );
    }
    if (ins.missing_required_documents.length > 0) {
      lines.push(`    · missing required documents: ${ins.missing_required_documents.join("; ")}`);
    }
    for (const n of ins.scoring_notes) {
      lines.push(`    · note: ${n}`);
    }
  }
  return lines.join("\n");
}

/** Strictly validate the model's output. */
export function validateReasoning(obj: unknown): ReasoningOutput | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.headline !== "string") return null;
  if (!Array.isArray(o.per_insurer)) return null;
  const out: ReasoningOutput = { headline: o.headline, per_insurer: [] };
  for (const raw of o.per_insurer) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.insurer_id !== "string" || typeof r.reasoning !== "string") return null;
    out.per_insurer.push({ insurer_id: r.insurer_id, reasoning: r.reasoning });
  }
  return out;
}

/**
 * Deterministic fallback reasoning, used when the LLM call fails or returns
 * an invalid shape. The matcher's notes are the source of truth either way;
 * this just structures them into per-insurer text so the UI still has prose.
 */
export function fallbackReasoning(insurers: InsurerScore[]): ReasoningOutput {
  const top = insurers.find((i) => !i.ruled_out);
  const headline = top
    ? `${top.insurer_name} ranks highest (score ${top.score}); ${
        top.referral_required ? "referral required." : "no referral flagged."
      }`
    : "No insurer scored above the disqualification threshold for this risk.";
  return {
    headline,
    per_insurer: insurers.map((ins) => ({
      insurer_id: ins.insurer_id,
      reasoning: ins.scoring_notes.join(" "),
    })),
  };
}
