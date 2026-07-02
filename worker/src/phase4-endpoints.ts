import { adminClient, audit, json, type AtlasUser } from "./auth";
import type { Env } from "./config";
import {
  buildComparisonRows,
  buildManagerStats,
  communicationDedupeKey,
  generateMissingInfoRequestDraft,
  generateQuoteReviewSummary,
  generateReferralPack,
  transitionCommunication,
  missingInfoFromQuoteReview,
  validateMissingInfoStatusUpdate,
  type MissingInfoItemInput,
  type MissingInfoOwner,
  type MissingInfoStatus,
  type MissingInfoItemType,
  type CommunicationAudience,
  type CommunicationStatus,
  type CommunicationType,
} from "./phase4-workflow";
import { roleCanViewManagerDashboard } from "./phase6-hardening";

async function latestReview(admin: ReturnType<typeof adminClient>, submissionId: string) {
  const { data } = await admin
    .from("atlas_quote_reviews")
    .select("*")
    .eq("submission_id", submissionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data as Record<string, unknown> | null;
}

async function sectionsFor(admin: ReturnType<typeof adminClient>, reviewId: string) {
  const { data } = await admin
    .from("atlas_quote_review_sections")
    .select("*")
    .eq("quote_review_id", reviewId)
    .order("created_at", { ascending: true });
  return (data ?? []) as Record<string, unknown>[];
}

export async function handleListMissingInfo(submissionId: string, env: Env, _user: AtlasUser) {
  const admin = adminClient(env);
  const { data, error } = await admin
    .from("atlas_missing_info_items")
    .select("*")
    .eq("submission_id", submissionId)
    .order("created_at", { ascending: false });
  if (error) return json({ error: "fetch_failed" }, 500);
  return json({ ok: true, items: data ?? [] });
}

export async function handleGenerateMissingInfo(submissionId: string, env: Env, user: AtlasUser) {
  const admin = adminClient(env);
  const review = await latestReview(admin, submissionId);
  if (!review?.id) return json({ error: "no_quote_review", detail: "run_quote_review_first" }, 400);
  const sections = await sectionsFor(admin, String(review.id));
  const snapshot = review.review_snapshot as { reviewed_json?: { missing_information?: { field?: string; reason_required?: string; priority?: string }[] } } | null;
  const generated = missingInfoFromQuoteReview({
    submissionId,
    quoteReviewId: String(review.id),
    sections: sections as any,
    extractionMissing: snapshot?.reviewed_json?.missing_information ?? [],
  });

  const { data: existing } = await admin
    .from("atlas_missing_info_items")
    .select("section_key, item_type, title, description")
    .eq("submission_id", submissionId);
  const existingKeys = new Set(
    ((existing ?? []) as Record<string, unknown>[])
      .map((i) => `${i.section_key ?? ""}|${i.item_type}|${i.title}|${i.description ?? ""}`.toLowerCase())
  );
  const rows = generated
    .filter((i) => !existingKeys.has(`${i.section_key ?? ""}|${i.item_type}|${i.title}|${i.description ?? ""}`.toLowerCase()))
    .map((i) => ({ ...i, submission_id: submissionId, created_by: user.id }));

  if (rows.length > 0) {
    const { error } = await admin.from("atlas_missing_info_items").insert(rows);
    if (error) return json({ error: "store_failed" }, 500);
  }

  await audit(env, {
    submissionId,
    action: "missing_info_generated",
    actorId: user.id,
    metadata: { quote_review_id: review.id, generated_count: rows.length },
  });
  return json({ ok: true, generated_count: rows.length });
}

export async function handleAddMissingInfo(submissionId: string, request: Request, env: Env, user: AtlasUser) {
  const body = (await request.json().catch(() => null)) as Partial<MissingInfoItemInput> | null;
  if (!body?.title?.trim()) return json({ error: "bad_request", detail: "title_required" }, 400);
  const admin = adminClient(env);
  const { data, error } = await admin
    .from("atlas_missing_info_items")
    .insert({
      submission_id: submissionId,
      quote_review_id: body.quote_review_id ?? null,
      section_key: body.section_key ?? null,
      item_type: (body.item_type ?? "other") as MissingInfoItemType,
      title: body.title.trim(),
      description: body.description ?? null,
      status: "open",
      required_by_rule_id: body.required_by_rule_id ?? null,
      source: "manual",
      owner: (body.owner ?? "broker") as MissingInfoOwner,
      due_date: body.due_date ?? null,
      notes: body.notes ?? null,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error || !data) return json({ error: "store_failed" }, 500);
  await audit(env, {
    submissionId,
    action: "missing_info_added",
    actorId: user.id,
    metadata: {
      item_id: data.id,
      quote_review_id: body.quote_review_id ?? null,
      item_type: body.item_type ?? "other",
      owner: body.owner ?? "broker",
    },
  });
  return json({ ok: true, id: data.id }, 201);
}

export async function handleUpdateMissingInfo(itemId: string, request: Request, env: Env, user: AtlasUser) {
  const body = (await request.json().catch(() => null)) as {
    status?: MissingInfoStatus;
    notes?: string | null;
    owner?: MissingInfoOwner;
    due_date?: string | null;
  } | null;
  if (!body) return json({ error: "bad_request" }, 400);
  if (body.status) {
    const validation = validateMissingInfoStatusUpdate({ status: body.status, notes: body.notes });
    if (validation) return json({ error: "bad_request", detail: validation }, 400);
  }
  const update: Record<string, unknown> = {};
  if (body.status) {
    update.status = body.status;
    if (["received", "waived", "not_required"].includes(body.status)) update.resolved_at = new Date().toISOString();
    else update.resolved_at = null;
  }
  if ("notes" in body) update.notes = body.notes ?? null;
  if (body.owner) update.owner = body.owner;
  if ("due_date" in body) update.due_date = body.due_date ?? null;

  const admin = adminClient(env);
  const { data, error } = await admin
    .from("atlas_missing_info_items")
    .update(update)
    .eq("id", itemId)
    .select("submission_id")
    .single();
  if (error || !data) return json({ error: "update_failed" }, 500);
  await audit(env, {
    submissionId: (data as { submission_id: string }).submission_id,
    action: "missing_info_updated",
    actorId: user.id,
    metadata: { item_id: itemId, fields: Object.keys(update) },
  });
  return json({ ok: true });
}

export async function handleGeneratePhase4Draft(
  submissionId: string,
  draftType: "missing-info" | "referral-pack" | "quote-summary",
  request: Request,
  env: Env,
  _user: AtlasUser
) {
  const body = (await request.json().catch(() => ({}))) as { recipient?: "broker" | "client" | "internal"; notes?: string };
  const admin = adminClient(env);
  const review = await latestReview(admin, submissionId);
  if (!review?.id) return json({ error: "no_quote_review", detail: "run_quote_review_first" }, 400);
  const sections = await sectionsFor(admin, String(review.id));
  const { data: missing } = await admin
    .from("atlas_missing_info_items")
    .select("*")
    .eq("submission_id", submissionId)
    .order("created_at", { ascending: true });
  const { data: decision } = await admin
    .from("atlas_decisions")
    .select("*")
    .eq("submission_id", submissionId)
    .eq("quote_review_id", String(review.id))
    .order("decided_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const text =
    draftType === "missing-info"
      ? generateMissingInfoRequestDraft({
          recipient: body.recipient ?? "broker",
          items: (missing ?? []) as any,
        })
      : draftType === "referral-pack"
      ? generateReferralPack({
          review: review as any,
          sections: sections as any,
          missingItems: (missing ?? []) as any,
          consultantNotes: body.notes,
        })
      : generateQuoteReviewSummary({
          review: review as any,
          sections: sections as any,
          decision: (decision as any) ?? null,
        });

  return json({ ok: true, draft: text });
}

export async function handleListCommunications(submissionId: string, env: Env, _user: AtlasUser) {
  const admin = adminClient(env);
  const { data, error } = await admin
    .from("atlas_communications")
    .select("*")
    .eq("submission_id", submissionId)
    .order("created_at", { ascending: false });
  if (error) return json({ error: "fetch_failed" }, 500);
  return json({ ok: true, communications: data ?? [] });
}

export async function handleSaveCommunication(
  submissionId: string,
  request: Request,
  env: Env,
  user: AtlasUser
) {
  const body = (await request.json().catch(() => null)) as {
    quote_review_id?: string | null;
    communication_type?: CommunicationType;
    audience?: CommunicationAudience;
    subject?: string | null;
    body?: string;
    related_missing_info_item_ids?: string[] | null;
    related_section_keys?: string[] | null;
    notes?: string | null;
  } | null;
  if (!body?.body?.trim() || !body.communication_type) return json({ error: "bad_request" }, 400);
  const admin = adminClient(env);
  const dedupe = communicationDedupeKey({
    submission_id: submissionId,
    quote_review_id: body.quote_review_id ?? null,
    communication_type: body.communication_type,
    audience: body.audience ?? "unknown",
    body: body.body,
  });
  const { data: existing } = await admin
    .from("atlas_communications")
    .select("id")
    .eq("submission_id", submissionId)
    .eq("quote_review_id", body.quote_review_id ?? null)
    .eq("communication_type", body.communication_type)
    .eq("audience", body.audience ?? "unknown")
    .eq("body", body.body.trim())
    .limit(1)
    .maybeSingle();
  if (existing?.id) return json({ ok: true, id: existing.id, duplicate: true });

  const { data, error } = await admin
    .from("atlas_communications")
    .insert({
      submission_id: submissionId,
      quote_review_id: body.quote_review_id ?? null,
      communication_type: body.communication_type,
      audience: body.audience ?? "unknown",
      subject: body.subject ?? null,
      body: body.body.trim(),
      status: "draft",
      related_missing_info_item_ids: body.related_missing_info_item_ids ?? null,
      related_section_keys: body.related_section_keys ?? null,
      created_by: user.id,
      notes: body.notes ?? `dedupe:${dedupe.slice(0, 64)}`,
    })
    .select("id")
    .single();
  if (error || !data) return json({ error: "store_failed" }, 500);
  await audit(env, {
    submissionId,
    action: "communication_saved",
    actorId: user.id,
    metadata: {
      communication_id: data.id,
      quote_review_id: body.quote_review_id ?? null,
      communication_type: body.communication_type,
      audience: body.audience ?? "unknown",
      related_missing_info_count: body.related_missing_info_item_ids?.length ?? 0,
    },
  });
  return json({ ok: true, id: data.id, duplicate: false }, 201);
}

export async function handleUpdateCommunication(
  communicationId: string,
  request: Request,
  env: Env,
  user: AtlasUser
) {
  const body = (await request.json().catch(() => null)) as {
    status?: CommunicationStatus;
    notes?: string | null;
    mark_related_missing_requested?: boolean;
  } | null;
  if (!body) return json({ error: "bad_request" }, 400);
  if (!body.status && !("notes" in body)) return json({ error: "bad_request" }, 400);
  const admin = adminClient(env);
  const { data: current } = await admin
    .from("atlas_communications")
    .select("*")
    .eq("id", communicationId)
    .single();
  if (!current) return json({ error: "not_found" }, 404);

  const update: Record<string, unknown> = {};
  if (body.status) Object.assign(update, transitionCommunication({ current: current.status as CommunicationStatus, next: body.status }));
  if ("notes" in body) update.notes = body.notes ?? null;

  const { error } = await admin
    .from("atlas_communications")
    .update(update)
    .eq("id", communicationId);
  if (error) return json({ error: "update_failed" }, 500);

  if (body.status === "sent_manually" && body.mark_related_missing_requested) {
    const ids = Array.isArray(current.related_missing_info_item_ids)
      ? current.related_missing_info_item_ids
      : [];
    if (ids.length > 0) {
      await admin
        .from("atlas_missing_info_items")
        .update({ status: "requested" })
        .in("id", ids);
    }
  }

  await audit(env, {
    submissionId: current.submission_id,
    action: "communication_updated",
    actorId: user.id,
    metadata: { communication_id: communicationId, status: body.status ?? null },
  });
  return json({ ok: true });
}

export async function handleGetQuoteReviewHistory(submissionId: string, env: Env, _user: AtlasUser) {
  const admin = adminClient(env);
  const { data: reviews, error } = await admin
    .from("atlas_quote_reviews")
    .select("*")
    .eq("submission_id", submissionId)
    .order("created_at", { ascending: false });
  if (error) return json({ error: "fetch_failed" }, 500);
  const reviewRows = (reviews ?? []) as Record<string, unknown>[];
  const reviewIds = reviewRows.map((r) => String(r.id));
  const { data: sections } = reviewIds.length
    ? await admin.from("atlas_quote_review_sections").select("*").in("quote_review_id", reviewIds)
    : { data: [] };
  const { data: decisions } = reviewIds.length
    ? await admin.from("atlas_decisions").select("*").in("quote_review_id", reviewIds)
    : { data: [] };
  const { data: missing } = reviewIds.length
    ? await admin.from("atlas_missing_info_items").select("*").in("quote_review_id", reviewIds)
    : { data: [] };
  const sectionsByReview: Record<string, Record<string, unknown>[]> = {};
  for (const section of (sections ?? []) as Record<string, unknown>[]) {
    const id = String(section.quote_review_id);
    sectionsByReview[id] = [...(sectionsByReview[id] ?? []), section];
  }
  const decisionsByReview: Record<string, Record<string, unknown>> = {};
  for (const decision of (decisions ?? []) as Record<string, unknown>[]) {
    if (decision.quote_review_id && !decisionsByReview[String(decision.quote_review_id)]) {
      decisionsByReview[String(decision.quote_review_id)] = decision;
    }
  }
  const missingByReview: Record<string, Record<string, unknown>[]> = {};
  for (const item of (missing ?? []) as Record<string, unknown>[]) {
    if (!item.quote_review_id) continue;
    const id = String(item.quote_review_id);
    missingByReview[id] = [...(missingByReview[id] ?? []), item];
  }
  const comparison = buildComparisonRows({
    reviews: reviewRows as any,
    sectionsByReview: sectionsByReview as any,
    decisionsByReview: decisionsByReview as any,
    missingItemsByReview: missingByReview as any,
  });
  return json({ ok: true, reviews: reviewRows, sections_by_review: sectionsByReview, decisions_by_review: decisionsByReview, comparison });
}

export async function handleGetManagerStats(request: Request, env: Env, user: AtlasUser) {
  if (!roleCanViewManagerDashboard(user.role)) return json({ error: "forbidden", detail: "manager_only" }, 403);
  const admin = adminClient(env);
  const url = new URL(request.url);
  const filters = {
    dateRange: url.searchParams.get("date_range") as "7d" | "30d" | "90d" | "all" | null,
    status: url.searchParams.get("status"),
    insurerId: url.searchParams.get("insurer_id"),
    consultantId: url.searchParams.get("consultant_id"),
    lineOfBusiness: url.searchParams.get("line_of_business"),
    outcome: url.searchParams.get("outcome"),
  };
  const [{ data: submissions }, { data: reviews }, { data: missing }, { data: decisions }, { data: sections }, { data: communications }] =
    await Promise.all([
      admin.from("atlas_submissions").select("id"),
      admin.from("atlas_quote_reviews").select("*").order("created_at", { ascending: false }).limit(200),
      admin.from("atlas_missing_info_items").select("*").limit(500),
      admin.from("atlas_decisions").select("decision_choice, ai_recommendation_accepted").limit(500),
      admin.from("atlas_quote_review_sections").select("*").limit(500),
      admin.from("atlas_communications").select("*").limit(500),
    ]);
  const stats = buildManagerStats({
    submissions: (submissions ?? []) as any,
    reviews: (reviews ?? []) as any,
    missingItems: (missing ?? []) as any,
    decisions: (decisions ?? []) as any,
    sections: (sections ?? []) as any,
    communications: (communications ?? []) as any,
    filters: filters as any,
  });
  return json({ ok: true, stats });
}
