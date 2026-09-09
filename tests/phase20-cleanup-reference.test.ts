/**
 * Phase 20 — Cleanup reference-check helper (Checkpoint 5).
 * ---------------------------------------------------------------------------
 * Drives `findActiveStorageReference` (the shared helper used by BOTH
 * detectCleanupCandidates and processApprovedCleanup) against an in-memory
 * admin fake. This proves runtime cleanup safety — not just SQL predicate
 * mirroring in the Postgres gate.
 *
 * Every assertion targets a real code path in production: the helper's
 * bucket-aware branching, its fail-closed on DB errors, and its treatment
 * of every Phase 5B state that carries a reserved storage_path (pending,
 * downloading, uploaded, ingested).
 */

import { findActiveStorageReference, type StorageReferenceCheck } from "../worker/src/cleanup-reference.js";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function eq<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

interface FakeState {
  documents: Array<{ id: string; storage_path: string }>;
  attachments: Array<{ id: string; storage_path: string; state: string }>;
  insurer: Array<{ id: string; storage_path: string }>;
  errorOn: null | "documents" | "attachments" | "insurer";
}

function newState(): FakeState {
  return { documents: [], attachments: [], insurer: [], errorOn: null };
}

class FakeQ {
  private filters: Array<(r: Record<string, unknown>) => boolean> = [];
  constructor(private rows: Array<Record<string, unknown>>, private errorMode: boolean) {}
  select(_cols?: string) { return this; }
  eq(field: string, value: unknown) { this.filters.push((r) => r[field] === value); return this; }
  in(field: string, values: unknown[]) { const set = new Set(values); this.filters.push((r) => set.has(r[field] as never)); return this; }
  limit(_n: number) { return this; }
  async maybeSingle() {
    if (this.errorMode) return { data: null, error: { message: "simulated DB failure" } as unknown };
    const rows = this.rows.filter((r) => this.filters.every((f) => f(r)));
    return { data: rows[0] ?? null, error: null as unknown };
  }
}

function makeAdmin(state: FakeState): unknown {
  return {
    from(table: string) {
      const errorMode = state.errorOn === (
        table === "atlas_documents" ? "documents"
        : table === "atlas_intake_graph_attachments" ? "attachments"
        : table === "atlas_insurer_documents" ? "insurer"
        : null
      );
      const rows: Array<Record<string, unknown>> =
        table === "atlas_documents" ? state.documents as never
        : table === "atlas_intake_graph_attachments" ? state.attachments as never
        : table === "atlas_insurer_documents" ? state.insurer as never
        : [];
      return new FakeQ(rows, errorMode);
    },
  };
}

const CLIENT = "atlas-client-docs";
const INSURER = "atlas-insurer-docs";

// -------------------------------------------------------------------
// Positive references: every Phase 5B active state must be recognised.
// -------------------------------------------------------------------

for (const state of ["pending", "downloading", "uploaded", "ingested"]) {
  test(`cp5: attachment state='${state}' + non-null storage_path is recognised as a reference`, async () => {
    const s = newState();
    const path = `sub/graph/att.pdf`;
    s.attachments.push({ id: "a1", storage_path: path, state });
    const r = await findActiveStorageReference(makeAdmin(s) as never, CLIENT, path);
    eq(r.ok, true, "ok");
    eq(r.referenced, true, "referenced");
    eq(r.reason, "attachment_phase5b", "reason");
  });
}

test("cp5: attachment in terminal 'skipped' state does NOT reserve the path", async () => {
  const s = newState();
  const path = `sub/graph/att.pdf`;
  s.attachments.push({ id: "a1", storage_path: path, state: "skipped" });
  const r = await findActiveStorageReference(makeAdmin(s) as never, CLIENT, path);
  eq(r.referenced, false, "skipped is terminal, not reserved");
  eq(r.reason, "none", "reason");
});

test("cp5: attachment in terminal 'failed_permanent' state does NOT reserve the path", async () => {
  const s = newState();
  const path = `sub/graph/att.pdf`;
  s.attachments.push({ id: "a1", storage_path: path, state: "failed_permanent" });
  const r = await findActiveStorageReference(makeAdmin(s) as never, CLIENT, path);
  eq(r.referenced, false, "failed_permanent is terminal, not reserved");
});

test("cp5: atlas_documents reference wins (any bucket, any state)", async () => {
  const s = newState();
  s.documents.push({ id: "d1", storage_path: "sub/graph/att.pdf" });
  const r = await findActiveStorageReference(makeAdmin(s) as never, CLIENT, "sub/graph/att.pdf");
  eq(r.referenced, true, "referenced");
  eq(r.reason, "document", "reason");
});

test("cp5: insurer document reference recognised for insurer bucket", async () => {
  const s = newState();
  s.insurer.push({ id: "i1", storage_path: "insurer/x.pdf" });
  const r = await findActiveStorageReference(makeAdmin(s) as never, INSURER, "insurer/x.pdf");
  eq(r.referenced, true, "referenced");
  eq(r.reason, "insurer_document", "reason");
});

test("cp5: insurer document is NOT queried for client bucket (bucket-aware branching)", async () => {
  const s = newState();
  // Only a match in the insurer table with a client-shaped path.
  s.insurer.push({ id: "i1", storage_path: "sub/graph/att.pdf" });
  const r = await findActiveStorageReference(makeAdmin(s) as never, CLIENT, "sub/graph/att.pdf");
  eq(r.referenced, false, "insurer rows are not checked for the client bucket");
});

test("cp5: no reference anywhere → ok=true referenced=false", async () => {
  const s = newState();
  const r = await findActiveStorageReference(makeAdmin(s) as never, CLIENT, "sub/graph/att.pdf");
  eq(r.ok, true, "ok");
  eq(r.referenced, false, "not referenced");
  eq(r.reason, "none", "reason");
});

// -------------------------------------------------------------------
// Fail-closed on DB errors.
// -------------------------------------------------------------------

test("cp5: DB error on documents lookup → fail-closed (ok=false referenced=true)", async () => {
  const s = newState();
  s.errorOn = "documents";
  const r = await findActiveStorageReference(makeAdmin(s) as never, CLIENT, "any/path");
  eq(r.ok, false, "not ok");
  eq(r.referenced, true, "safe default is still-referenced");
  eq(r.reason, "db_error_fail_closed", "reason");
});

test("cp5: DB error on attachments lookup → fail-closed", async () => {
  const s = newState();
  s.errorOn = "attachments";
  const r = await findActiveStorageReference(makeAdmin(s) as never, CLIENT, "any/path");
  eq(r.ok, false, "not ok");
  eq(r.referenced, true, "safe default is still-referenced");
});

test("cp5: DB error on insurer lookup → fail-closed", async () => {
  const s = newState();
  s.errorOn = "insurer";
  const r = await findActiveStorageReference(makeAdmin(s) as never, INSURER, "insurer/x.pdf");
  eq(r.ok, false, "not ok");
  eq(r.referenced, true, "safe default is still-referenced");
});

// -------------------------------------------------------------------
// Runner
// -------------------------------------------------------------------

async function main() {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`ok  ${t.name}`); }
    catch (e) { failed++; console.error(`FAIL ${t.name}`); console.error("  " + (e as Error).message); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exit(1);
}

// Structural narrowing so TS keeps the type import "live"
export type _Check = StorageReferenceCheck;
void main();
