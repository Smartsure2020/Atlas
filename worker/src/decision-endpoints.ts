/**
 * Atlas Blueprint — decision endpoints
 * ----------------------------------------------------------------------------
 * POST /api/submissions/:id/decision
 *   Records the underwriter's decision against the latest recommendation.
 *   Any underwriter may accept / override-to-secondary / close / refer.
 *   MANAGER (admin) required ONLY when overriding to an insurer the matcher
 *   ruled out (i.e. selected_insurer appears in the recommendation's
 *   not_recommended_json). Enforced server-side; the UI also disables the
 *   action for non-admin users, but the server is the authoritative gate.
 *
 * GET  /api/submissions/:id/decision
 *   Returns the latest decision for the submission, or null.
 *
 * Override reason is structured: override_reason_code from a fixed enum,
 * optional free-text override_reason. The 'other' code requires the free
 * text (enforced here, since the constraint is conditional on accept vs override).
 */

import { adminClient, audit, json, type AtlasUser } from "./auth";
import type { Env } from "./config";
import { validateQuoteDecision } from "./quote-decision";
import { roleCanManageAppetite } from "./phase6-hardening";
import { evaluateDecisionGate, type RecommendationForGate } from "./decision-rules";

const OVERRIDE_CODES = new Set([
  "client_preference",
  "broker_relationship",
  "claims_history_factor",
  "pricing_factor",
  "capacity_constraint",
  "client_request",
  "other",
]);

const DECISION_STATUSES = new Set([
  "ready_for_quote",
  "referred",
  "closed",
]);

interface DecisionInput {
  quote_review_id?: string;
  recommendation_id?: string;
  selected_insurer?: string;
  selected_insurer_id?: string | null;
  decision_status?: "ready_for_quote" | "referred" | "closed";
  decision_choice?: "proceed" | "refer" | "request_info" | "decline" | "override";
  decision_reason?: string;
  ai_recommendation_accepted?: boolean;
  override_reason_code?: string;
  override_reason?: string;
  underwriter_notes?: string;
}

export async function handleRecordDecision(
  submissionId: string,
  request: Request,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as DecisionInput | null;
  if (!body) return json({ error: "bad_request" }, 400);

  const decisionChoice = body.decision_choice ?? null;
  const decisionStatus =
    body.decision_status ??
    (decisionChoice === "refer"
      ? "referred"
      : decisionChoice === "proceed" || decisionChoice === "override"
      ? "ready_for_quote"
      : decisionChoice === "request_info" || decisionChoice === "decline"
      ? "closed"
      : undefined);

  if (!decisionStatus || !DECISION_STATUSES.has(decisionStatus)) {
    return json({ error: "bad_request", detail: "decision_status_required" }, 400);
  }

  // For overrides, override_reason_code is required. For accepts, it must be null.
  const accepted = body.ai_recommendation_accepted === true;
  if (!accepted) {
    if (!body.override_reason_code || !OVERRIDE_CODES.has(body.override_reason_code)) {
      return json(
        { error: "bad_request", detail: "override_reason_code_required" },
        400
      );
    }
    // 'other' requires free-text to give meaning to the choice.
    if (body.override_reason_code === "other" && !body.override_reason?.trim()) {
      return json(
        { error: "bad_request", detail: "override_reason_required_for_other" },
        400
      );
    }
  }

  const admin = adminClient(env);

  let quoteReview: Record<string, unknown> | null = null;
  if (body.quote_review_id) {
    const { data } = await admin
      .from("atlas_quote_reviews")
      .select("*")
      .eq("id", body.quote_review_id)
      .single();
    if (!data || data.submission_id !== submissionId) {
      return json({ error: "quote_review_mismatch" }, 400);
    }
    quoteReview = data as Record<string, unknown>;
  }

  // Fetch the recommendation this decision is being made against. The SERVER
  // resolves it: a client-supplied id is verified against the submission, and
  // when none is supplied we load the submission's latest recommendation —
  // the ruled-out gate must not depend on the client volunteering the id.
  let recommendation: RecommendationForGate | null = null;
  let recommendationSource: "client" | "latest" | "none" = "none";

  if (body.recommendation_id) {
    const { data } = await admin
      .from("atlas_recommendations")
      .select("id, submission_id, recommended_insurer, not_recommended_json")
      .eq("id", body.recommendation_id)
      .single();
    if (!data || data.submission_id !== submissionId) {
      return json({ error: "recommendation_mismatch" }, 400);
    }
    recommendation = {
      id: data.id,
      recommended_insurer: data.recommended_insurer,
      not_recommended_json:
        (data.not_recommended_json as { insurer_id: string; insurer_name: string }[]) ?? [],
    };
    recommendationSource = "client";
  } else {
    const { data } = await admin
      .from("atlas_recommendations")
      .select("id, recommended_insurer, not_recommended_json")
      .eq("submission_id", submissionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) {
      recommendation = {
        id: data.id,
        recommended_insurer: data.recommended_insurer,
        not_recommended_json:
          (data.not_recommended_json as { insurer_id: string; insurer_name: string }[]) ?? [],
      };
      recommendationSource = "latest";
    }
  }

  if (quoteReview) {
    const decisionError = validateQuoteDecision({
      quoteReviewStatus: String(quoteReview.status ?? ""),
      decisionChoice,
      decisionStatus,
      decisionReason: body.decision_reason,
      overrideReason: body.override_reason,
      underwriterNotes: body.underwriter_notes,
    });
    if (decisionError) return json({ error: "bad_request", detail: decisionError }, 400);
  }

  // ---- THE SECURITY-CRITICAL CHECK ----
  // Overriding to an insurer the matcher RULED OUT requires manager/admin.
  // Plain consultants can accept, override to a secondary, refer, or close —
  // but forcing a ruled-out insurer through (the act that contradicts a hard
  // appetite rule) needs senior sign-off. The gate runs against the server-
  // resolved recommendation, and a proceed/override that names an insurer is
  // refused outright when no recommendation exists to judge it against.
  const gate = evaluateDecisionGate({
    decisionChoice,
    decisionStatus,
    selectedInsurer: body.selected_insurer ?? null,
    selectedInsurerId: body.selected_insurer_id ?? null,
    recommendation,
    canManage: roleCanManageAppetite(user.role),
  });
  if (!gate.ok && gate.error === "recommendation_required") {
    return json(
      {
        error: "bad_request",
        detail: "recommendation_required",
        message: "Run a recommendation before proceeding with an insurer.",
      },
      400
    );
  }
  if (!gate.ok) {
    await audit(env, {
      submissionId,
      action: "decision_blocked_ruled_out_override",
      actorId: user.id,
      metadata: {
        selected_insurer: body.selected_insurer ?? null,
        selected_insurer_id: body.selected_insurer_id ?? null,
        recommendation_id: recommendation?.id ?? null,
        recommendation_source: recommendationSource,
      },
    });
    return json(
      {
        error: "forbidden",
        detail: "manager_required_for_ruled_out_override",
      },
      403
    );
  }
  const isRuledOutOverride = gate.ruledOutOverride;

  // ---- Insert the decision ----
  const { data: row, error } = await admin
    .from("atlas_decisions")
    .insert({
      submission_id: submissionId,
      quote_review_id: quoteReview?.id ?? null,
      recommendation_id: recommendation?.id ?? null,
      selected_insurer: body.selected_insurer ?? null,
      selected_insurer_id: body.selected_insurer_id ?? null,
      decision_status: decisionStatus,
      decision_choice: decisionChoice,
      decision_reason: body.decision_reason ?? null,
      underwriter_notes: body.underwriter_notes ?? null,
      ai_recommendation_accepted: accepted,
      override_reason_code: accepted ? null : body.override_reason_code,
      override_reason: accepted ? null : body.override_reason ?? null,
      decision_snapshot: {
        quote_review: quoteReview,
        recommendation,
        selected_insurer: body.selected_insurer ?? null,
        decision_choice: decisionChoice,
        decision_status: decisionStatus,
      },
      decided_by: user.id,
    })
    .select("id")
    .single();
  if (error || !row) return json({ error: "store_failed" }, 500);

  // ---- Update submission status to match the decision ----
  // Map the decision_status to atlas_submission_status. closed → closed,
  // referred → referred_to_insurer, ready_for_quote → ready_for_quote.
  const submissionStatus =
    decisionChoice === "request_info"
      ? "missing_info_requested"
      : decisionStatus === "referred"
      ? "referred_to_insurer"
      : decisionStatus; // ready_for_quote or closed maps 1:1
  await admin
    .from("atlas_submissions")
    .update({ status: submissionStatus })
    .eq("id", submissionId);

  // ---- Audit ----
  const action = accepted
    ? "decision_accepted"
    : isRuledOutOverride
    ? "decision_override_ruled_out"
    : "decision_overridden";
  await audit(env, {
    submissionId,
    action,
    actorId: user.id,
    metadata: {
      decision_id: row.id,
      recommendation_id: recommendation?.id ?? null,
      recommendation_source: recommendationSource,
      quote_review_id: quoteReview?.id ?? null,
      selected_insurer: body.selected_insurer ?? null,
      decision_status: decisionStatus,
      decision_choice: decisionChoice,
      override_reason_code: accepted ? null : body.override_reason_code,
      ai_recommendation_was: recommendation?.recommended_insurer ?? null,
    },
  });

  return json({ ok: true, decision_id: row.id }, 201);
}

export async function handleGetDecision(
  submissionId: string,
  env: Env,
  _user: AtlasUser
): Promise<Response> {
  const admin = adminClient(env);
  const { data, error } = await admin
    .from("atlas_decisions")
    .select(
      "id, recommendation_id, selected_insurer, selected_insurer_id, " +
        "quote_review_id, decision_status, decision_choice, decision_reason, " +
        "underwriter_notes, ai_recommendation_accepted, override_reason_code, " +
        "override_reason, decision_snapshot, decided_by, decided_at"
    )
    .eq("submission_id", submissionId)
    .order("decided_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return json({ error: "fetch_failed" }, 500);
  return json({ ok: true, decision: data });
}
