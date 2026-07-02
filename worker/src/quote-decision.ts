import type { QuoteReviewStatus } from "./quote-review.js";

export type QuoteDecisionChoice = "proceed" | "refer" | "request_info" | "decline" | "override";

export function validateQuoteDecision(input: {
  quoteReviewStatus?: QuoteReviewStatus | string | null;
  decisionChoice?: QuoteDecisionChoice | string | null;
  decisionStatus?: string | null;
  decisionReason?: string | null;
  overrideReason?: string | null;
  underwriterNotes?: string | null;
}): string | null {
  const reviewStatus = input.quoteReviewStatus ? String(input.quoteReviewStatus) : "";
  const isProceeding =
    input.decisionChoice === "proceed" ||
    input.decisionChoice === "override" ||
    input.decisionStatus === "ready_for_quote";
  if (
    reviewStatus === "declined" &&
    isProceeding &&
    !(input.overrideReason?.trim() || input.decisionReason?.trim())
  ) {
    return "declined_override_reason_required";
  }
  if (
    reviewStatus === "refer" &&
    input.decisionChoice === "refer" &&
    !(input.underwriterNotes?.trim() || input.decisionReason?.trim())
  ) {
    return "referral_notes_required";
  }
  return null;
}
