/**
 * Atlas — backfill file_hash for existing documents
 * ---------------------------------------------------------------------------
 * One-shot operational script. Downloads each document from Supabase storage,
 * computes a SHA-256 hash, and writes it to the file_hash column.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/backfill-file-hashes.ts
 *
 * Safety:
 *   - Read-only on storage (download only, no deletes).
 *   - Writes only file_hash, file_size_bytes, and content_type columns.
 *   - Skips rows that already have a file_hash.
 *   - Dry run by default — pass --apply to actually write.
 *   - Processes one document at a time to avoid memory pressure.
 */

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  process.exit(1);
}

const dryRun = !process.argv.includes("--apply");
if (dryRun) {
  console.log("DRY RUN — pass --apply to write changes.\n");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface DocumentRow {
  id: string;
  storage_path: string;
  file_hash: string | null;
}

async function sha256(data: ArrayBuffer): Promise<string> {
  const hash = createHash("sha256");
  hash.update(Buffer.from(data));
  return hash.digest("hex");
}

async function backfillTable(
  tableName: string,
  bucketName: string,
): Promise<{ processed: number; skipped: number; failed: number }> {
  console.log(`\n--- ${tableName} (bucket: ${bucketName}) ---`);

  const { data: rows, error } = await supabase
    .from(tableName)
    .select("id, storage_path, file_hash")
    .is("file_hash", null)
    .not("storage_path", "is", null)
    .order("created_at", { ascending: true });

  if (error) {
    console.error(`  Failed to query ${tableName}: ${error.message}`);
    return { processed: 0, skipped: 0, failed: 1 };
  }

  const documents = (rows ?? []) as DocumentRow[];
  console.log(`  ${documents.length} documents without file_hash.`);

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const doc of documents) {
    if (!doc.storage_path) {
      skipped++;
      continue;
    }

    try {
      const { data: blob, error: downloadError } = await supabase.storage
        .from(bucketName)
        .download(doc.storage_path);

      if (downloadError || !blob) {
        console.error(`  SKIP ${doc.id}: download failed — ${downloadError?.message ?? "no data"}`);
        failed++;
        continue;
      }

      const buffer = await blob.arrayBuffer();
      const hash = await sha256(buffer);

      console.log(`  ${doc.id} → ${hash.slice(0, 16)}… (${buffer.byteLength} bytes)`);

      if (!dryRun) {
        const { error: updateError } = await supabase
          .from(tableName)
          .update({
            file_hash: hash,
            file_size_bytes: buffer.byteLength,
            content_type: blob.type || null,
          })
          .eq("id", doc.id);

        if (updateError) {
          console.error(`  FAIL ${doc.id}: update failed — ${updateError.message}`);
          failed++;
          continue;
        }
      }

      processed++;
    } catch (err) {
      console.error(`  FAIL ${doc.id}: ${(err as Error).message}`);
      failed++;
    }
  }

  return { processed, skipped, failed };
}

async function main() {
  const clientResult = await backfillTable("atlas_documents", "atlas-client-docs");
  const insurerResult = await backfillTable("atlas_insurer_documents", "atlas-insurer-docs");

  const total = {
    processed: clientResult.processed + insurerResult.processed,
    skipped: clientResult.skipped + insurerResult.skipped,
    failed: clientResult.failed + insurerResult.failed,
  };

  console.log(`\n=== Summary ===`);
  console.log(`  Processed: ${total.processed}`);
  console.log(`  Skipped:   ${total.skipped}`);
  console.log(`  Failed:    ${total.failed}`);
  if (dryRun) console.log(`\n  (Dry run — no changes written. Pass --apply to write.)`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
