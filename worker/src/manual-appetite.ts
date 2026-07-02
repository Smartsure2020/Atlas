/**
 * Atlas Blueprint — manual appetite rule creation
 * ----------------------------------------------------------------------------
 * POST /api/insurers/:id/appetite
 *
 * Admin-only. Creates an appetite rule directly with source='manual' and
 * is_active=true (no confirm step — a manager creating a rule explicitly is
 * the act of confirming it). Supports both:
 *   - PRODUCT rules: real product_line and risk_type values.
 *   - PORTFOLIO rules: product_line="*" AND risk_type="*".
 *
 * The same edit/deactivate/snapshot machinery from Phase 2A applies after
 * creation — manual rules are first-class citizens, not a special case.
 */

import { adminClient, audit, json, type AtlasUser } from "./auth";
import type { Env } from "./config";
import { roleCanManageAppetite } from "./phase6-hardening";

export async function handleAddAppetiteRule(
  insurerId: string,
  request: Request,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  if (!roleCanManageAppetite(user.role)) {
    return json({ error: "forbidden", detail: "manager_only" }, 403);
  }

  const body = (await request.json().catch(() => null)) as {
    product_line?: string;
    risk_type?: string;
    appetite_level?: "preferred" | "standard" | "caution" | "declined";
    preferred_risks?: string[];
    caution_risks?: string[];
    declined_risks?: string[];
    required_documents?: string[];
    referral_triggers?: string[];
    notes?: string;
    rating_notes?: string;
    line_of_business?: "personal" | "commercial" | "both" | null;
    source_quote?: string | null;
    source_page?: number | null;
    source_section?: string | null;
    source_file_name?: string | null;
    ingestion_confidence?: number | null;
  } | null;

  if (
    !body ||
    !body.product_line ||
    !body.risk_type ||
    !body.appetite_level ||
    !["preferred", "standard", "caution", "declined"].includes(body.appetite_level)
  ) {
    return json({ error: "bad_request" }, 400);
  }

  const admin = adminClient(env);

  // Fetch the insurer for the denormalised name on the appetite row.
  const { data: insurer } = await admin
    .from("atlas_insurers")
    .select("id, name")
    .eq("id", insurerId)
    .single();
  if (!insurer) return json({ error: "insurer_not_found" }, 404);

  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? (v as unknown[]).map(String).filter((s) => s.trim().length > 0) : [];
  const lineOfBusiness =
    body.line_of_business && ["personal", "commercial", "both"].includes(body.line_of_business)
      ? body.line_of_business
      : null;
  const sourcePage =
    typeof body.source_page === "number" && Number.isFinite(body.source_page) && body.source_page > 0
      ? Math.trunc(body.source_page)
      : null;
  const ingestionConfidence =
    typeof body.ingestion_confidence === "number" &&
    Number.isFinite(body.ingestion_confidence) &&
    body.ingestion_confidence >= 0 &&
    body.ingestion_confidence <= 1
      ? body.ingestion_confidence
      : null;

  const now = new Date().toISOString();

  const { data: row, error } = await admin
    .from("atlas_insurer_appetite")
    .insert({
      insurer_id: insurerId,
      insurer_name: insurer.name,
      product_line: body.product_line.trim(),
      risk_type: body.risk_type.trim(),
      appetite_level: body.appetite_level,
      preferred_risks: arr(body.preferred_risks),
      caution_risks: arr(body.caution_risks),
      declined_risks: arr(body.declined_risks),
      required_documents: arr(body.required_documents),
      referral_triggers: arr(body.referral_triggers),
      notes: typeof body.notes === "string" ? body.notes : null,
      rating_notes: typeof body.rating_notes === "string" ? body.rating_notes : null,
      line_of_business: lineOfBusiness,
      source_quote: typeof body.source_quote === "string" ? body.source_quote : null,
      source_page: sourcePage,
      source_section: typeof body.source_section === "string" ? body.source_section : null,
      source_file_name: typeof body.source_file_name === "string" ? body.source_file_name : null,
      ingestion_confidence: ingestionConfidence,
      source: "manual",
      source_document_id: null,
      is_active: true,
      confirmed_by: user.id,
      confirmed_at: now,
    })
    .select("id")
    .single();

  if (error || !row) return json({ error: "create_failed" }, 500);

  // Snapshot the new row into history (same machinery as ingestion-created rows).
  const { data: snap } = await admin
    .from("atlas_insurer_appetite")
    .select("*")
    .eq("id", row.id)
    .single();
  if (snap) {
    await admin.from("atlas_appetite_history").insert({
      appetite_id: row.id,
      change_type: "created",
      snapshot_json: snap,
      changed_by: user.id,
    });
  }

  await audit(env, {
    action: "appetite_manual_added",
    actorId: user.id,
    metadata: {
      insurer_id: insurerId,
      appetite_id: row.id,
      product_line: body.product_line,
      risk_type: body.risk_type,
      is_portfolio: body.product_line === "*" && body.risk_type === "*",
    },
  });

  return json({ ok: true, id: row.id }, 201);
}
