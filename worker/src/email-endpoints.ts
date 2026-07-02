/**
 * Atlas Blueprint — email draft generation
 * ----------------------------------------------------------------------------
 * Four endpoints, one per email type. All produce copyable text only —
 * NEVER auto-send. The underwriter pastes the result into their email client,
 * reviews, and sends manually. That's the governance posture: AI assists,
 * human commits.
 *
 * POST /api/submissions/:id/emails/broker-missing-info
 * POST /api/submissions/:id/emails/broker-acknowledgement
 * POST /api/submissions/:id/emails/insurer-submission
 * POST /api/submissions/:id/emails/internal-summary
 *
 * Returns: { ok: true, subject: string, body: string, draft_id: string }
 *
 * Each call is on-demand (generated when the user clicks the relevant button),
 * not pre-generated. This means the draft always reflects the LATEST reviewed
 * extraction and decision — important when the underwriter has made
 * corrections after the recommendation ran.
 */

import { adminClient, audit, json, type AtlasUser } from "./auth";
import type { Env } from "./config";
import { logOperationError } from "./phase6-hardening";

const EMAIL_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

type EmailType =
  | "broker_missing_info"
  | "broker_acknowledgement"
  | "insurer_submission"
  | "internal_summary";

type RecommendationEmailContext = {
  id: string;
  recommended_insurer: string | null;
  secondary_options_json: unknown;
  reasoning_json: unknown;
  referral_required: boolean | null;
  senior_review_required: boolean | null;
};

type DecisionEmailContext = {
  id: string;
  selected_insurer: string | null;
  decision_status: string | null;
  underwriter_notes: string | null;
  ai_recommendation_accepted: boolean | null;
  override_reason_code: string | null;
  override_reason: string | null;
};

const SYSTEM_PROMPTS: Record<EmailType, string> = {
  broker_missing_info: `
You are drafting an internal underwriter's email TO A BROKER, requesting
missing information so the underwriter can quote.

RULES:
- Polite, professional, succinct. South African short-term insurance context.
- Address the broker by name if known; otherwise "Hi" / "Good day".
- Open with one sentence acknowledging the submission/risk.
- List ONLY the genuinely missing items from missing_information. Use a clean
  bulleted list. Do NOT pad with items not actually missing.
- Briefly explain why each item is needed if priority is high — for medium
  or low priority, just list it.
- Close with a clear ask ("Could you send these through at your earliest
  convenience so we can progress the quote?") and sign off generically
  ("Kind regards" — no name).
- DO NOT mention pricing, premiums, or commit to a quote outcome.
- DO NOT name a specific insurer unless the decision has selected one and
  the broker would expect to know.
- Return ONLY a JSON object: {"subject": "...", "body": "..."}
- The body uses plain text with \\n line breaks. No HTML, no markdown.
`.trim(),

  broker_acknowledgement: `
You are drafting an internal underwriter's email TO A BROKER, acknowledging
receipt of a quote request.

RULES:
- Brief and reassuring. Two short paragraphs at most.
- Acknowledge the submission and confirm what's being assessed (client/risk
  in one line).
- Indicate next steps generally — "we're reviewing the documents" — without
  committing to a timeline if not provided.
- DO NOT mention pricing, premiums, or commit to a quote outcome.
- Sign off generically ("Kind regards").
- Return ONLY a JSON object: {"subject": "...", "body": "..."}
- The body uses plain text with \\n line breaks.
`.trim(),

  insurer_submission: `
You are drafting an internal underwriter's email TO AN INSURER, submitting a
risk for quotation.

RULES:
- Professional and structured. Use clear sections in the body:
  CLIENT, RISK, COVER REQUIRED, CLAIMS HISTORY, CURRENT COVER, ANY REFERRAL FLAGS.
- Use ONLY the information present in the reviewed extraction. Do NOT invent
  details. If a field is blank, omit that line — don't write "N/A".
- The tone is underwriter-to-underwriter: factual, no marketing language.
- If referral flags or senior-review flags are present on the recommendation,
  surface them prominently — the recipient needs to see them.
- DO NOT propose pricing or terms.
- Return ONLY a JSON object: {"subject": "...", "body": "..."}
- The body uses plain text with \\n line breaks. No HTML, no markdown.
`.trim(),

  internal_summary: `
You are drafting an INTERNAL underwriter-to-team summary note for a submission
that has been processed by Atlas.

RULES:
- Crisp, scannable. This is a handover note, not a letter.
- Use a structured layout: CLIENT, RISK, RECOMMENDED ROUTE, KEY RISK NOTES,
  OPEN ITEMS.
- Surface red flags, missing information, and referral triggers explicitly.
- If the underwriter has overridden the AI recommendation, make that obvious
  along with the override reason.
- DO NOT include any external-facing content.
- Return ONLY a JSON object: {"subject": "...", "body": "..."}
- The body uses plain text with \\n line breaks.
`.trim(),
};

/**
 * Where each LLM email draft lands in atlas_communications, so every piece of
 * AI-generated external-facing text is a durable, auditable record with the
 * normal draft → copied → sent_manually lifecycle — not ephemeral response
 * JSON that vanishes if the user doesn't separately save it.
 */
const EMAIL_COMMUNICATION: Record<
  EmailType,
  { communication_type: string; audience: string }
> = {
  broker_missing_info: { communication_type: "missing_info_request", audience: "broker" },
  broker_acknowledgement: { communication_type: "broker_note", audience: "broker" },
  insurer_submission: { communication_type: "other", audience: "insurer" },
  internal_summary: { communication_type: "internal_note", audience: "internal" },
};

function emailTypeFromPath(suffix: string): EmailType | null {
  switch (suffix) {
    case "/broker-missing-info": return "broker_missing_info";
    case "/broker-acknowledgement": return "broker_acknowledgement";
    case "/insurer-submission": return "insurer_submission";
    case "/internal-summary": return "internal_summary";
    default: return null;
  }
}

export async function handleGenerateEmail(
  submissionId: string,
  emailType: EmailType,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  const admin = adminClient(env);

  // ---- Gather context: submission, latest extraction (reviewed), latest
  // recommendation, latest decision. Whatever is present is used; anything
  // missing is simply omitted from the input to Claude.
  const [subRes, extRes, recRes, decRes] = await Promise.all([
    admin.from("atlas_submissions")
      .select("id, broker_name, broker_email, client_name, request_type, status")
      .eq("id", submissionId).single(),
    admin.from("atlas_extractions")
      .select("id, extracted_json, reviewed_json")
      .eq("submission_id", submissionId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("atlas_recommendations")
      .select(
        "id, recommended_insurer, secondary_options_json, " +
          "reasoning_json, referral_required, senior_review_required"
      )
      .eq("submission_id", submissionId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("atlas_decisions")
      .select(
        "id, selected_insurer, decision_status, underwriter_notes, " +
          "ai_recommendation_accepted, override_reason_code, override_reason"
      )
      .eq("submission_id", submissionId)
      .order("decided_at", { ascending: false }).limit(1).maybeSingle(),
  ]);

  if (subRes.error || !subRes.data) return json({ error: "submission_not_found" }, 404);

  // Use reviewed JSON when present (authoritative); fall back to raw extraction.
  const extractionForEmail =
    extRes.data?.reviewed_json ?? extRes.data?.extracted_json ?? null;

  // ---- Build the input message for Claude. Plain text, structured. ----
  const inputLines: string[] = [];
  inputLines.push("=== SUBMISSION ===");
  inputLines.push(`Client: ${subRes.data.client_name ?? "—"}`);
  inputLines.push(`Broker: ${subRes.data.broker_name ?? "—"}`);
  if (subRes.data.broker_email) inputLines.push(`Broker email: ${subRes.data.broker_email}`);
  inputLines.push(`Request type: ${subRes.data.request_type ?? "—"}`);

  if (extractionForEmail) {
    inputLines.push("\n=== REVIEWED RISK SUMMARY ===");
    inputLines.push(JSON.stringify(extractionForEmail, null, 2));
  }

  const recommendation = recRes.data as RecommendationEmailContext | null;
  if (recommendation) {
    inputLines.push("\n=== RECOMMENDATION ===");
    inputLines.push(`Top: ${recommendation.recommended_insurer ?? "—"}`);
    inputLines.push(`Referral required: ${recommendation.referral_required}`);
    inputLines.push(`Senior review required: ${recommendation.senior_review_required}`);
    inputLines.push(`Reasoning: ${JSON.stringify(recommendation.reasoning_json)}`);
  }

  const decision = decRes.data as DecisionEmailContext | null;
  if (decision) {
    inputLines.push("\n=== DECISION ===");
    inputLines.push(`Status: ${decision.decision_status}`);
    inputLines.push(`Selected: ${decision.selected_insurer ?? "—"}`);
    inputLines.push(`AI recommendation accepted: ${decision.ai_recommendation_accepted}`);
    if (!decision.ai_recommendation_accepted) {
      inputLines.push(`Override reason code: ${decision.override_reason_code ?? "—"}`);
      if (decision.override_reason) {
        inputLines.push(`Override reason: ${decision.override_reason}`);
      }
    }
    if (decision.underwriter_notes) {
      inputLines.push(`Underwriter notes: ${decision.underwriter_notes}`);
    }
  }

  inputLines.push(
    `\nDraft the email per your instructions and return ONLY the JSON object.`
  );

  // ---- Call Claude ----
  let result: { subject: string; body: string };
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: EMAIL_MODEL,
        max_tokens: 2000,
        system: SYSTEM_PROMPTS[emailType],
        messages: [{ role: "user", content: inputLines.join("\n") }],
      }),
    });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.text()).slice(0, 200).replace(/\s+/g, " "); } catch {}
      console.error("email_anthropic_error", res.status, detail);
      return json({ error: "email_generation_failed", status: res.status, detail }, 502);
    }
    const data = (await res.json()) as {
      content?: { type: string; text?: string }[];
    };
    const text = data.content?.filter((b) => b.type === "text").map((b) => b.text).join("") ?? "";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    if (typeof parsed?.subject !== "string" || typeof parsed?.body !== "string") {
      return json({ error: "email_invalid_shape" }, 502);
    }
    result = { subject: parsed.subject, body: parsed.body };
  } catch {
    return json({ error: "email_parse_failed" }, 502);
  }

  // ---- Persist the draft as a communication record ----
  // Reviewed extraction is authoritative; a draft built from a raw
  // (unreviewed) extraction is labelled so nobody sends unverified facts.
  const basedOnReviewed = Boolean(extRes.data?.reviewed_json);
  const target = EMAIL_COMMUNICATION[emailType];
  const notes = [
    "AI-generated email draft. Review before sending — Atlas never sends automatically.",
    basedOnReviewed ? null : "Based on an UNREVIEWED AI extraction; verify facts before use.",
  ]
    .filter(Boolean)
    .join(" ");

  let draftId: string | null = null;
  const { data: saved, error: saveErr } = await admin
    .from("atlas_communications")
    .insert({
      submission_id: submissionId,
      communication_type: target.communication_type,
      audience: target.audience,
      subject: result.subject,
      body: result.body,
      status: "draft",
      created_by: user.id,
      notes,
    })
    .select("id")
    .single();
  if (saveErr || !saved) {
    // The draft was already generated; return it rather than discarding paid
    // work, but say plainly that it was NOT persisted.
    logOperationError({
      endpoint: `/api/submissions/${submissionId}/emails`,
      operation: "persist_email_draft",
      code: "store_failed",
      submissionId,
      status: 500,
    });
  } else {
    draftId = saved.id;
  }

  await audit(env, {
    submissionId,
    action: "email_draft_generated",
    actorId: user.id,
    metadata: {
      email_type: emailType,
      draft_id: draftId,
      draft_persisted: Boolean(draftId),
      based_on_reviewed_extraction: basedOnReviewed,
      // Length only — we never log the email body itself (it contains client PII).
      body_length: result.body.length,
      subject_length: result.subject.length,
    },
  });

  return json({
    ok: true,
    ...result,
    draft_id: draftId,
    draft_persisted: Boolean(draftId),
    based_on: basedOnReviewed ? "reviewed_extraction" : "raw_extraction",
  });
}

export { emailTypeFromPath };
