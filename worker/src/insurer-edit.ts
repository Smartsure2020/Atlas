/**
 * Atlas Blueprint — insurer edit endpoint
 * ----------------------------------------------------------------------------
 * PATCH /api/insurers/:id   (admin only)
 *
 * Lets a manager update an insurer's name, quote_channel, active flag, and
 * notes. Most common immediate use: renaming "Infiniti" → "Infiniti Personal
 * Lines" so personal and commercial appetites live under distinct insurer
 * entries (per the refinement decision).
 *
 * Implementation notes:
 *  - When the name changes, we ALSO update insurer_name on every appetite row
 *    for this insurer. The appetite_name is denormalised onto rows for cheap
 *    matcher reads; if we left it stale, the matcher would still work (it
 *    keys on insurer_id) but recommendation displays would show the old name.
 *  - Whitelisted fields only; never let the caller change id or created_at.
 *  - Audit-logged with field names (no PII).
 */

import { adminClient, audit, json, type AtlasUser } from "./auth";
import type { Env } from "./config";
import { roleCanManageAppetite } from "./phase6-hardening";

export async function handleEditInsurer(
  insurerId: string,
  request: Request,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  if (!roleCanManageAppetite(user.role)) {
    return json({ error: "forbidden", detail: "manager_only" }, 403);
  }

  const body = (await request.json().catch(() => null)) as {
    name?: string;
    quote_channel?: string | null;
    active?: boolean;
    notes?: string | null;
  } | null;
  if (!body) return json({ error: "bad_request" }, 400);

  // Whitelist editable fields explicitly.
  const update: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) {
    update.name = body.name.trim();
  }
  if ("quote_channel" in body) update.quote_channel = body.quote_channel ?? null;
  if (typeof body.active === "boolean") update.active = body.active;
  if ("notes" in body) update.notes = body.notes ?? null;

  if (Object.keys(update).length === 0) {
    return json({ error: "no_editable_fields" }, 400);
  }

  const admin = adminClient(env);
  const { error } = await admin
    .from("atlas_insurers")
    .update(update)
    .eq("id", insurerId);
  if (error) return json({ error: "update_failed" }, 500);

  // If the name changed, propagate to the denormalised insurer_name on every
  // appetite row so the matcher / UI keep showing the current name.
  if (typeof update.name === "string") {
    await admin
      .from("atlas_insurer_appetite")
      .update({ insurer_name: update.name })
      .eq("insurer_id", insurerId);
  }

  await audit(env, {
    action: "insurer_edited",
    actorId: user.id,
    metadata: { insurer_id: insurerId, fields: Object.keys(update) },
  });

  return json({ ok: true });
}
