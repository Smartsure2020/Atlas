/**
 * Atlas Blueprint — recommendation endpoints
 * ----------------------------------------------------------------------------
 * POST /api/submissions/:id/recommend  (any underwriter; input must be reviewed)
 * GET  /api/submissions/:id/recommendation  (latest cached)
 *
 * Phase 2B orchestrator. The flow:
 *   1. Load the submission's latest extraction. REQUIRE reviewed_json (the
 *      input gate — recommendations only run against human-confirmed data).
 *   2. Derive the matcher's input (product_candidates, risk_candidates, features,
 *      available_documents) from the reviewed summary.
 *   3. Load all active appetite rows.
 *   4. Run matchInsurers() — pure code, deterministic.
 *   5. Call Claude for the reasoning pass (with deterministic fallback if it
 *      fails). The model never alters scores.
 *   6. Insert a row into atlas_recommendations (cached — re-run creates a new
 *      row; history is preserved).
 *   7. Audit-log; update submission status to ready_for_quote / referred_to_insurer
 *      based on the top result (a tentative status that the human decision in
 *      Phase 3 will confirm or override).
 */

import { adminClient, audit, json, type AtlasUser } from "./auth";
import {
  MATCHER_VERSION,
  insurersWithoutActiveRules,
  matchInsurers,
  type InsurerScore,
  type MatchInputRisk,
  type RiskFeature,
} from "./matcher";
import { TAXONOMY_VERSION } from "./taxonomy";
import type { AppetiteRow } from "./matcher-types";
import {
  REASONING_MODEL,
  REASONING_SYSTEM_PROMPT,
  buildReasoningInput,
  fallbackReasoning,
  validateReasoning,
  type ReasoningOutput,
} from "./matcher-reasoning";
import type { Env } from "./config";
import {
  beginJob,
  buildRecommendationFingerprint,
  completeJob,
  failJob,
} from "./phase7-jobs";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// ----------------------------------------------------------------------------
// Risk derivation: turn the reviewed extraction into the matcher's inputs.
// Kept narrow and explicit so the matcher's substring matching has clean text
// to work with, not raw nested JSON.
// ----------------------------------------------------------------------------

interface FieldShape { value: unknown; confidence?: number }
const isField = (x: unknown): x is FieldShape =>
  !!x && typeof x === "object" && "value" in (x as object);

const fieldStr = (f: unknown): string => {
  if (!isField(f)) return "";
  const v = f.value;
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return valueStrings(v).join(", ");
  if (typeof v === "object") return valueStrings(v).join(", ");
  return String(v);
};

function valueStrings(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const s = String(value).trim();
    return s ? [s] : [];
  }
  if (Array.isArray(value)) return value.flatMap(valueStrings);
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(valueStrings);
  return [];
}

function deriveRisk(reviewed: Record<string, unknown>, availableDocs: string[]): MatchInputRisk {
  const rc = (reviewed.risk_classification as Record<string, unknown>) ?? {};
  const cc = (reviewed.current_cover as Record<string, unknown>) ?? {};
  const ec = (reviewed.extracted_client as Record<string, unknown>) ?? {};

  const splitCandidates = (s: string): string[] =>
    s
      .split(/[,;]|\bor\b|\band\b/i)
      .map((x) => x.trim())
      .filter((x) => x.length > 0);

  // cover_sections is gold; secondary_risk_types often overlaps; primary_risk_type
  // is a fallback (sometimes industry label, sometimes cover label).
  const productCandidates: string[] = [];
  productCandidates.push(...splitCandidates(fieldStr(rc.product_line)));
  productCandidates.push(...splitCandidates(fieldStr(rc.risk_type)));
  productCandidates.push(...splitCandidates(fieldStr(cc.cover_sections)));
  productCandidates.push(...splitCandidates(fieldStr(rc.secondary_risk_types)));
  const primaryRiskType = fieldStr(rc.primary_risk_type);
  if (primaryRiskType) productCandidates.push(primaryRiskType);

  const riskCandidates: string[] = [];
  riskCandidates.push(...splitCandidates(fieldStr(rc.risk_type)));
  const businessSector = fieldStr(rc.business_sector);
  if (businessSector) riskCandidates.push(...splitCandidates(businessSector));
  riskCandidates.push(...splitCandidates(fieldStr(rc.secondary_risk_types)));
  if (primaryRiskType) riskCandidates.push(primaryRiskType);
  const complexity = fieldStr(rc.complexity_level);
  if (complexity) riskCandidates.push(complexity);

  // Features carry a source label so scoring notes can show WHERE a rule term
  // matched, and red-flag issues are marked ai_inferred — the matcher treats
  // those as needing human confirmation instead of hard-ruling insurers out.
  const features: RiskFeature[] = [];
  const push = (text: string, source: string, aiInferred = false) => {
    if (text) features.push({ text, source, ai_inferred: aiInferred });
  };
  push(fieldStr(rc.primary_risk_type), "primary risk type");
  push(fieldStr(rc.secondary_risk_types), "secondary risk types");
  push(fieldStr(rc.business_sector), "business sector");
  push(fieldStr(rc.complexity_level), "complexity level");
  push(fieldStr(ec.occupation_or_business_description), "occupation/business description");
  push(fieldStr(ec.risk_address), "risk address");
  push(fieldStr(ec.entity_type), "entity type");
  push(fieldStr(cc.cover_sections), "cover sections");
  push(fieldStr(cc.endorsements), "endorsements");
  push(fieldStr(cc.exclusions), "exclusions");
  const reds = (reviewed.red_flags as { issue?: string }[]) ?? [];
  for (const r of reds) if (r?.issue) push(r.issue, "red flag", true);

  const overall_confidence =
    typeof reviewed.overall_confidence === "number" ? reviewed.overall_confidence : 0.7;

  return {
    product_candidates: productCandidates,
    section_candidates: splitCandidates(fieldStr(cc.cover_sections)),
    risk_candidates: riskCandidates,
    features,
    available_documents: availableDocs,
    overall_confidence,
  };
}

/** A short risk-summary string handed to the reasoning pass for context. */
function buildRiskSummary(reviewed: Record<string, unknown>): string {
  const ec = (reviewed.extracted_client as Record<string, unknown>) ?? {};
  const rc = (reviewed.risk_classification as Record<string, unknown>) ?? {};
  const cc = (reviewed.current_cover as Record<string, unknown>) ?? {};
  const parts: string[] = [];
  const client = fieldStr(ec.name);
  if (client) parts.push(`Client: ${client}`);
  const occ = fieldStr(ec.occupation_or_business_description);
  if (occ) parts.push(`Occupation/business: ${occ}`);
  const addr = fieldStr(ec.risk_address);
  if (addr) parts.push(`Risk address: ${addr}`);
  const primary = fieldStr(rc.primary_risk_type);
  if (primary) parts.push(`Primary risk: ${primary}`);
  const secondary = fieldStr(rc.secondary_risk_types);
  if (secondary) parts.push(`Secondary: ${secondary}`);
  const sections = fieldStr(cc.cover_sections);
  if (sections) parts.push(`Cover sections: ${sections}`);
  const insurer = fieldStr(cc.current_insurer);
  if (insurer) parts.push(`Current insurer: ${insurer}`);
  return parts.join("\n");
}

// ----------------------------------------------------------------------------
// POST /api/submissions/:id/recommend
// ----------------------------------------------------------------------------

export async function handleRunRecommendation(
  submissionId: string,
  request: Request,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { force?: boolean };
  const admin = adminClient(env);

  // ---- Load latest extraction; require reviewed_json (input gate) ----
  const { data: extraction } = await admin
    .from("atlas_extractions")
    .select("id, submission_id, extracted_json, reviewed_json, reviewed_at, overall_confidence:extraction_confidence")
    .eq("submission_id", submissionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!extraction) {
    return json({ error: "no_extraction", detail: "run_extraction_first" }, 400);
  }
  if (!extraction.reviewed_json) {
    return json(
      { error: "extraction_not_reviewed", detail: "review_extraction_first" },
      400
    );
  }

  // ---- Build documents-available list ----
  const { data: docs } = await admin
    .from("atlas_documents")
    .select("document_type")
    .eq("submission_id", submissionId);
  const docList = (docs ?? []) as { document_type: string | null }[];
  const availableDocs: string[] = docList
    .map((d) => d.document_type)
    .filter((x: string | null): x is string => typeof x === "string" && x.length > 0);

  // The reviewed JSON also carries an overall_confidence inside it; prefer
  // the table column we already select but fall back to the JSON value.
  const reviewedJson = extraction.reviewed_json as Record<string, unknown>;
  if (typeof reviewedJson.overall_confidence !== "number") {
    reviewedJson.overall_confidence =
      typeof extraction.overall_confidence === "number" ? extraction.overall_confidence : 0.7;
  }

  const risk = deriveRisk(reviewedJson, availableDocs);

  // ---- Load the live matrix ----
  const { data: appetiteRaw } = await admin
    .from("atlas_insurer_appetite")
    .select(
      "id, insurer_id, insurer_name, product_line, risk_type, appetite_level, " +
        "preferred_risks, caution_risks, declined_risks, required_documents, " +
        "referral_triggers, notes, rating_notes, line_of_business, source_quote, " +
        "source_page, source_section, source_file_name, ingestion_confidence, " +
        "source, source_document_id, is_active, updated_at"
    )
    .eq("is_active", true);
  const appetite = (appetiteRaw ?? []) as unknown as AppetiteRow[];

  if (appetite.length === 0) {
    return json(
      { error: "matrix_empty", detail: "no_active_appetite_rules" },
      409
    );
  }

  const inputFp = buildRecommendationFingerprint({
    submissionId,
    extractionId: extraction.id,
    reviewedAt: extraction.reviewed_at ?? null,
    activeRuleIds: ((appetiteRaw ?? []) as unknown as { id: string; updated_at?: string | null }[]).map(
      (a) => `${a.id}:${a.updated_at ?? ""}`
    ),
  });
  const job = await beginJob(
    admin,
    {
      submissionId,
      jobType: "recommendation",
      inputFingerprint: inputFp,
      createdBy: user.id,
      metadata: { extraction_id: extraction.id, active_rules: appetite.length },
    },
    { force: body.force === true }
  );
  if (job.action === "unchanged_completed") {
    return json({
      ok: true,
      skipped: true,
      reason: "unchanged_input",
      message: job.message,
      recommendation_id: job.resultReferenceId,
      previous_job_id: job.previousJobId,
    });
  }
  if (job.action === "duplicate_running") {
    return json({ error: "job_already_running", detail: job.message, job_id: job.previousJobId }, 409);
  }

  // ---- Match deterministically ----
  const result = matchInsurers(risk, appetite);

  // Insurers with ZERO active rules never enter the matcher (its input is
  // appetite rows), so surface them explicitly: the underwriter must see
  // "Atlas has no appetite data for X" rather than X silently vanishing.
  const { data: insurerRows } = await admin
    .from("atlas_insurers")
    .select("id, name")
    .eq("active", true);
  result.no_data_for = [
    ...result.no_data_for,
    ...insurersWithoutActiveRules(
      (insurerRows ?? []) as { id: string; name: string }[],
      appetite
    ),
  ];

  // ---- Build reasoning context map (id -> source_quote/notes) ----
  // Prefer stored guideline evidence, with notes as a fallback for older rows.
  const ctx = new Map<string, { source_quote?: string; notes?: string | null }>();
  for (const a of appetite) {
    ctx.set(a.id, { source_quote: a.source_quote ?? a.notes ?? undefined, notes: a.notes });
  }

  // ---- Reasoning pass (with deterministic fallback) ----
  const riskSummary = buildRiskSummary(reviewedJson);
  let reasoning: ReasoningOutput;
  let usedFallbackReasoning = false;
  try {
    const inputText = buildReasoningInput({
      riskSummary,
      insurers: result.insurers,
      appetiteContext: ctx,
    });

    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: REASONING_MODEL,
        max_tokens: 2048,
        system: REASONING_SYSTEM_PROMPT,
        messages: [{ role: "user", content: inputText }],
      }),
    });

    if (!res.ok) throw new Error(`anthropic_${res.status}`);
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = data.content?.filter((b) => b.type === "text").map((b) => b.text).join("") ?? "";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    const validated = validateReasoning(parsed);
    if (validated) {
      reasoning = validated;
    } else {
      reasoning = fallbackReasoning(result.insurers);
      usedFallbackReasoning = true;
    }
  } catch {
    reasoning = fallbackReasoning(result.insurers);
    usedFallbackReasoning = true;
  }

  // ---- Cache the recommendation ----
  const top = result.insurers.find((i) => !i.ruled_out) ?? null;
  const secondaries = result.insurers.filter(
    (i) => !i.ruled_out && i !== top
  );
  const notRecommended = result.insurers.filter((i) => i.ruled_out);

  const reasoningById = new Map(reasoning.per_insurer.map((r) => [r.insurer_id, r.reasoning]));
  const enriched = (s: InsurerScore) => ({
    ...s,
    reasoning: reasoningById.get(s.insurer_id) ?? "",
  });

  const recommendationRow = {
    submission_id: submissionId,
    recommended_insurer: top?.insurer_name ?? null,
    secondary_options_json: secondaries.map(enriched),
    not_recommended_json: notRecommended.map(enriched),
    reasoning_json: {
      headline: reasoning.headline,
      top: top ? enriched(top) : null,
      no_data_for: result.no_data_for,
      manual_review_required: top?.manual_review_required ?? false,
      unmatched_sections: top?.unmatched_sections ?? [],
      unmatched_product_candidates: top?.unmatched_product_candidates ?? [],
      // Reconstruction snapshot: the exact derived input the matcher ran on,
      // and which matcher/taxonomy behaviour produced the scores. Without
      // this, explaining an old recommendation would mean replaying CURRENT
      // code against the reviewed JSON — wrong after any matcher change.
      matcher_input: risk,
      matcher_version: MATCHER_VERSION,
      taxonomy_version: TAXONOMY_VERSION,
      reasoning_source: usedFallbackReasoning ? "fallback" : "llm",
    },
    confidence_score: top?.confidence ?? 0,
    referral_required: top?.referral_required ?? false,
    senior_review_required: top?.senior_review_required || top?.manual_review_required || false,
    extraction_id: extraction.id,
  };

  const { data: recRow, error: recErr } = await admin
    .from("atlas_recommendations")
    .insert(recommendationRow)
    .select("id")
    .single();
  if (recErr || !recRow) {
    await failJob(admin, job.jobId, { errorCode: "recommendation_failed", errorMessage: "Could not store recommendation row." });
    return json({ error: "store_failed" }, 500);
  }

  // ---- Move the submission status tentatively (human decides in Phase 3) ----
  const newStatus = top
    ? top.manual_review_required
      ? "in_review"
      : top.senior_review_required || top.referral_required
      ? "referred_to_insurer"
      : "ready_for_quote"
    : "in_review";
  await admin.from("atlas_submissions").update({ status: newStatus }).eq("id", submissionId);

  // ---- Audit ----
  await audit(env, {
    submissionId,
    action: "recommendation_run",
    actorId: user.id,
    metadata: {
      recommendation_id: recRow.id,
      extraction_id: extraction.id,
      top_insurer: top?.insurer_name ?? null,
      top_score: top?.score ?? null,
      referral_required: top?.referral_required ?? false,
      senior_review_required: top?.senior_review_required ?? false,
      manual_review_required: top?.manual_review_required ?? false,
      insurers_considered: result.insurers.length,
      no_data_for_count: result.no_data_for.length,
      reasoning_source: usedFallbackReasoning ? "fallback" : "llm",
    },
  });

  await completeJob(admin, job.jobId, {
    resultReferenceId: recRow.id,
    metadata: {
      recommendation_id: recRow.id,
      extraction_id: extraction.id,
      input_fingerprint: inputFp,
      reasoning_source: usedFallbackReasoning ? "fallback" : "llm",
    },
  });

  return json({ ok: true, recommendation_id: recRow.id });
}

// ----------------------------------------------------------------------------
// GET /api/submissions/:id/recommendation
// Returns the cached latest recommendation row for a submission.
// ----------------------------------------------------------------------------

export async function handleGetRecommendation(
  submissionId: string,
  env: Env,
  _user: AtlasUser
): Promise<Response> {
  const admin = adminClient(env);
  const { data, error } = await admin
    .from("atlas_recommendations")
    .select(
      "id, recommended_insurer, secondary_options_json, not_recommended_json, " +
        "reasoning_json, confidence_score, referral_required, " +
        "senior_review_required, extraction_id, created_at"
    )
    .eq("submission_id", submissionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return json({ error: "fetch_failed" }, 500);
  return json({ ok: true, recommendation: data });
}
