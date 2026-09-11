/**
 * Atlas — shared storage-reference helper for cleanup detection & deletion.
 * ----------------------------------------------------------------------------
 * A single testable function used by BOTH detectCleanupCandidates and
 * processApprovedCleanup in phase4-background.ts. Extracted so the same
 * decision powers detection and deletion, and so tests can drive the exact
 * production code path.
 *
 * Fails CLOSED: on any DB error the helper returns
 * `ok:false, referenced:true` so callers treat the path as still-referenced
 * and refuse to delete.
 */

export const CLIENT_DOCS_BUCKET = "atlas-client-docs";
export const INSURER_DOCS_BUCKET = "atlas-insurer-docs";

// Phase 5B attachment states in which a storage_path is a legitimate
// reservation — the path may already have bytes (uploaded/ingested), may be
// about to have bytes (downloading), or may have retried back to pending
// after a partial upload failure. All four are protected from orphan
// classification and from cleanup deletion.
export const PHASE5B_ACTIVE_STATES: readonly string[] = [
  "pending",
  "downloading",
  "uploaded",
  "ingested",
];

export interface StorageReferenceCheck {
  ok: boolean;
  referenced: boolean;
  reason: "document" | "attachment_phase5b" | "insurer_document" | "db_error_fail_closed" | "none";
}

/**
 * Minimal admin shape we depend on. Kept as a structural interface so tests
 * can pass an in-memory fake without pulling the whole SupabaseClient type.
 */
export interface ReferenceCheckAdmin {
  from(table: string): {
    select(cols?: string): {
      eq(field: string, value: unknown): unknown;
    } & {
      eq(field: string, value: unknown): {
        in?: (field: string, values: unknown[]) => unknown;
        limit(n: number): {
          maybeSingle(): Promise<{ data: unknown; error: unknown }>;
        };
      };
    };
  };
}

export async function findActiveStorageReference(
  // Loose type — the real admin (SupabaseClient) implements a
  // superset. Kept `any` so we don't hard-couple this module to the
  // Supabase client's generics.
  admin: { from: (table: string) => any },
  bucket: string,
  storagePath: string,
): Promise<StorageReferenceCheck> {
  const doc = await admin
    .from("atlas_documents")
    .select("id")
    .eq("storage_path", storagePath)
    .limit(1)
    .maybeSingle();
  if (doc.error) return { ok: false, referenced: true, reason: "db_error_fail_closed" };
  if (doc.data?.id) return { ok: true, referenced: true, reason: "document" };

  if (bucket === CLIENT_DOCS_BUCKET) {
    const att = await admin
      .from("atlas_intake_graph_attachments")
      .select("id")
      .eq("storage_path", storagePath)
      .in("state", PHASE5B_ACTIVE_STATES as string[])
      .limit(1)
      .maybeSingle();
    if (att.error) return { ok: false, referenced: true, reason: "db_error_fail_closed" };
    if (att.data?.id) return { ok: true, referenced: true, reason: "attachment_phase5b" };
  }

  if (bucket === INSURER_DOCS_BUCKET) {
    const ins = await admin
      .from("atlas_insurer_documents")
      .select("id")
      .eq("storage_path", storagePath)
      .limit(1)
      .maybeSingle();
    if (ins.error) return { ok: false, referenced: true, reason: "db_error_fail_closed" };
    if (ins.data?.id) return { ok: true, referenced: true, reason: "insurer_document" };
  }

  return { ok: true, referenced: false, reason: "none" };
}
