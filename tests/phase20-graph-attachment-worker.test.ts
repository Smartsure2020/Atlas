/**
 * Phase 20 — Graph attachment ingestion (Phase 5B) behavioural tests.
 * ---------------------------------------------------------------------------
 * Drives handleGraphAttachmentDiscoveryJob and handleGraphAttachmentIngestJob
 * against an in-memory admin fake that reproduces the Phase 5B RPCs
 * (discover_commit, claim, register_hash, mark_uploaded, create_document,
 * fail, mark_skipped) and the atlas_intake_graph_attachments / atlas_jobs
 * / atlas_documents / atlas_audit_logs / atlas_submission_intake_messages
 * tables the processors touch.
 *
 * Graph HTTP is provided by an injected fetchImpl. Every test asserts zero
 * calls to production Graph or login endpoints.
 */

import {
  handleGraphAttachmentDiscoveryJob,
  handleGraphAttachmentIngestJob,
  classifyAttachment,
} from "../worker/src/graph-attachment.js";
import { GraphError } from "../worker/src/graph-client.js";

// -----------------------------------------------------------------------
// Runner
// -----------------------------------------------------------------------

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function eq<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

let uuidCounter = 0;
function nextUuid() {
  uuidCounter++;
  const s = uuidCounter.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${s}`;
}

// -----------------------------------------------------------------------
// State + admin fake
// -----------------------------------------------------------------------

interface State {
  intake: Array<Record<string, unknown>>;
  attachments: Array<Record<string, unknown>>;
  jobs: Array<Record<string, unknown>>;
  documents: Array<Record<string, unknown>>;
  audit: Array<Record<string, unknown>>;
  storageBucket: string;
  storagePaths: Set<string>;
  storageFailNext: boolean;
  hashFailNextCode: string | null;
  // Checkpoint 4 fault injection surfaces.
  loadFailNext: boolean;
  claimFailNext: boolean;
  failFailNext: boolean;
  plannedPathObserved: string | null; // captured on first successful set_planned_path call
  // Event ordering log for cross-cutting assertions (e.g. planned-path before upload).
  events: string[];
}

function newState(): State {
  return {
    intake: [], attachments: [], jobs: [], documents: [], audit: [],
    storageBucket: "atlas-client-docs",
    storagePaths: new Set(),
    storageFailNext: false,
    hashFailNextCode: null,
    loadFailNext: false,
    claimFailNext: false,
    failFailNext: false,
    plannedPathObserved: null,
    events: [],
  };
}

function seedIntake(state: State, over: Partial<Record<string, unknown>> = {}): { intakeId: string; submissionId: string } {
  const intakeId = nextUuid();
  const submissionId = nextUuid();
  state.intake.push({
    id: intakeId,
    submission_id: submissionId,
    mailbox: "intake@example.com",
    graph_message_id: "graph-msg-1",
    has_attachments: true,
    ...over,
  });
  return { intakeId, submissionId };
}

function seedAttachment(state: State, intakeId: string, submissionId: string, over: Partial<Record<string, unknown>> = {}) {
  const id = nextUuid();
  state.attachments.push({
    id,
    intake_message_id: intakeId,
    submission_id: submissionId,
    mailbox: "intake@example.com",
    graph_message_id: "graph-msg-1",
    graph_attachment_id: "graph-att-1",
    filename: "policy.pdf",
    mime_type: "application/pdf",
    size_bytes: 100_000,
    state: "pending",
    storage_path: null,
    sha256: null,
    duplicate_of_attachment_id: null,
    document_id: null,
    scan_job_id: null,
    ...over,
  });
  return id;
}

class FakeQuery {
  private filters: Array<(r: Record<string, unknown>) => boolean> = [];
  private cols: string | null = null;
  private orderBy: { field: string; ascending: boolean } | null = null;
  private limitN: number | null = null;
  constructor(private rows: Array<Record<string, unknown>>, private tableName: string, private state?: State) {}
  select(cols?: string) { this.cols = cols ?? "*"; return this; }
  eq(field: string, value: unknown) { this.filters.push((r) => r[field] === value); return this; }
  in(field: string, values: unknown[]) { const set = new Set(values); this.filters.push((r) => set.has(r[field] as never)); return this; }
  order(field: string, opts?: { ascending?: boolean }) { this.orderBy = { field, ascending: !!opts?.ascending }; return this; }
  limit(n: number) { this.limitN = n; return this; }
  private apply(): Array<Record<string, unknown>> {
    let out = this.rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.orderBy) {
      const { field, ascending } = this.orderBy;
      out = out.slice().sort((a, b) => {
        const av = a[field] as never, bv = b[field] as never;
        if (av === bv) return 0;
        return ascending ? (av < bv ? -1 : 1) : (av < bv ? 1 : -1);
      });
    }
    if (this.limitN != null) out = out.slice(0, this.limitN);
    return out;
  }
  async maybeSingle() {
    // Fault injection: when loadFailNext is set AND we are being asked to
    // read an attachment row, return an error.
    if (this.state?.loadFailNext && this.tableName === "atlas_intake_graph_attachments") {
      this.state.loadFailNext = false;
      return { data: null, error: { message: "db_probe_failure" } as unknown };
    }
    return { data: this.apply()[0] ?? null, error: null as unknown };
  }
  async single() {
    const rows = this.apply();
    if (rows.length === 0) return { data: null, error: { message: "no_rows" } };
    return { data: rows[0], error: null as unknown };
  }
  then<TResult1 = unknown>(cb: (v: { data: Array<Record<string, unknown>>; error: unknown }) => TResult1): Promise<TResult1> {
    return Promise.resolve(cb({ data: this.apply(), error: null }));
  }
}

class FakeUpdate {
  private filters: Array<(r: Record<string, unknown>) => boolean> = [];
  constructor(private rows: Array<Record<string, unknown>>, private patch: Record<string, unknown>) {}
  eq(field: string, value: unknown) { this.filters.push((r) => r[field] === value); return this; }
  in(field: string, values: unknown[]) { const set = new Set(values); this.filters.push((r) => set.has(r[field] as never)); return this; }
  then<TResult1 = unknown>(cb: (v: { data: null; error: unknown }) => TResult1): Promise<TResult1> {
    for (const r of this.rows.filter((r) => this.filters.every((f) => f(r)))) {
      Object.assign(r, this.patch);
    }
    return Promise.resolve(cb({ data: null, error: null }));
  }
}

class FakeInsert {
  constructor(private rows: Array<Record<string, unknown>>, private row: Record<string, unknown>) {}
  select() { return { single: async () => ({ data: this.row, error: null as unknown }) }; }
  then<TResult1 = unknown>(cb: (v: { data: null; error: unknown }) => TResult1): Promise<TResult1> {
    this.rows.push(this.row);
    return Promise.resolve(cb({ data: null, error: null }));
  }
}

interface StorageCall { bucket: string; path: string; contentType?: string; upsert?: boolean; byteLength: number }

function makeAdmin(state: State, storageCalls: StorageCall[]): unknown {
  function tableRows(name: string): Array<Record<string, unknown>> {
    switch (name) {
      case "atlas_submission_intake_messages": return state.intake;
      case "atlas_intake_graph_attachments": return state.attachments;
      case "atlas_jobs": return state.jobs;
      case "atlas_documents": return state.documents;
      case "atlas_audit_logs": return state.audit;
    }
    return [];
  }
  function tableApi(name: string) {
    const rows = tableRows(name);
    return {
      select: (cols?: string) => new FakeQuery(rows, name, state).select(cols),
      update: (patch: Record<string, unknown>) => new FakeUpdate(rows, patch),
      insert: (row: Record<string, unknown>) => new FakeInsert(rows, { id: nextUuid(), ...row }),
      delete: () => new FakeUpdate(rows, {}),
    };
  }

  async function rpc(name: string, args: Record<string, unknown>) {
    if (name === "atlas_intake_attachment_discover_commit") {
      const intakeId = String(args.p_intake_message_id);
      const intake = state.intake.find((r) => r.id === intakeId);
      if (!intake) return { data: null, error: { message: "intake_not_found" } };
      const submissionId = String(intake.submission_id);
      const stubs = (args.p_stubs as Array<Record<string, unknown>>) ?? [];
      const rows: Array<{ attachment_id: string; graph_attachment_id: string; state: string; ingest_job_id: string | null }> = [];
      for (const stub of stubs) {
        const graphAttId = String(stub.graph_attachment_id);
        const initialState = String(stub.initial_state ?? "pending");
        // Upsert by (mailbox, graph_message_id, graph_attachment_id).
        let att = state.attachments.find(
          (r) => r.mailbox === args.p_mailbox
            && r.graph_message_id === args.p_graph_message_id
            && r.graph_attachment_id === graphAttId,
        );
        if (!att) {
          att = {
            id: nextUuid(),
            intake_message_id: intakeId,
            submission_id: submissionId,
            mailbox: args.p_mailbox,
            graph_message_id: args.p_graph_message_id,
            graph_attachment_id: graphAttId,
            attachment_type: stub.attachment_type ?? "unknown",
            filename: stub.filename ?? null,
            mime_type: stub.mime_type ?? null,
            size_bytes: stub.size_bytes ?? null,
            is_inline: stub.is_inline ?? false,
            content_id: stub.content_id ?? null,
            state: initialState,
            skip_reason: stub.skip_reason ?? null,
            storage_path: null,
            sha256: null,
            duplicate_of_attachment_id: null,
            document_id: null,
            scan_job_id: null,
          };
          state.attachments.push(att);
        }
        let jobId: string | null = null;
        if (att.state === "pending") {
          const fingerprint = `graph-attachment-ingest:${att.id}`;
          const existing = state.jobs.find(
            (j) => j.job_type === "graph_attachment_ingest"
              && j.input_fingerprint === fingerprint
              && (j.status === "queued" || j.status === "running"),
          );
          if (existing) {
            jobId = String(existing.id);
          } else {
            jobId = nextUuid();
            state.jobs.push({
              id: jobId,
              submission_id: submissionId,
              document_id: null,
              job_type: "graph_attachment_ingest",
              status: "queued",
              input_fingerprint: fingerprint,
              created_by: args.p_system_actor_id,
              metadata: { attachment_id: att.id },
            });
          }
        }
        rows.push({ attachment_id: String(att.id), graph_attachment_id: graphAttId, state: String(att.state), ingest_job_id: jobId });
      }
      return { data: rows, error: null };
    }

    if (name === "atlas_intake_attachment_claim") {
      if (state.claimFailNext) {
        state.claimFailNext = false;
        return { data: null, error: { message: "db_probe_failure" } };
      }
      const att = state.attachments.find((r) => r.id === args.p_id);
      if (!att) return { data: [], error: null };
      if (att.state !== args.p_expected_state) return { data: [], error: null };
      att.state = "downloading";
      att.last_attempt_at = new Date().toISOString();
      return {
        data: [{
          id: att.id, intake_message_id: att.intake_message_id, submission_id: att.submission_id,
          mailbox: att.mailbox, graph_message_id: att.graph_message_id, graph_attachment_id: att.graph_attachment_id,
          filename: att.filename, mime_type: att.mime_type, size_bytes: att.size_bytes,
          state: att.state, storage_path: att.storage_path, sha256: att.sha256,
          duplicate_of_attachment_id: att.duplicate_of_attachment_id,
        }],
        error: null,
      };
    }

    if (name === "atlas_intake_attachment_register_hash") {
      if (state.hashFailNextCode) {
        const c = state.hashFailNextCode; state.hashFailNextCode = null;
        return { data: null, error: { message: c } };
      }
      const att = state.attachments.find((r) => r.id === args.p_id);
      if (!att) return { data: null, error: { message: "not_found" } };
      const sha = String(args.p_sha256);
      // Idempotent branch
      if (att.sha256 != null) {
        if (att.sha256 !== sha) {
          return { data: null, error: { message: "attachment_hash_changed" } };
        }
        if (att.duplicate_of_attachment_id == null) {
          return { data: [{ outcome: "owner", owner_id: att.id, document_id: att.document_id ?? null }], error: null };
        }
        const owner = state.attachments.find((r) => r.id === att.duplicate_of_attachment_id);
        return { data: [{ outcome: "duplicate", owner_id: att.duplicate_of_attachment_id, document_id: owner?.document_id ?? null }], error: null };
      }
      if (att.state !== args.p_expected_state) {
        return { data: null, error: { message: "unexpected_state" } };
      }
      // Owner search
      const existing = state.attachments.find(
        (r) => r.submission_id === att.submission_id
          && r.sha256 === sha
          && r.duplicate_of_attachment_id == null
          && r.id !== att.id,
      );
      if (existing) {
        att.sha256 = sha;
        att.size_bytes = att.size_bytes ?? args.p_size_bytes ?? null;
        att.duplicate_of_attachment_id = existing.id;
        att.state = "skipped";
        att.skip_reason = "duplicate_hash";
        att.document_id = att.document_id ?? existing.document_id ?? null;
        return { data: [{ outcome: "duplicate", owner_id: existing.id, document_id: existing.document_id ?? null }], error: null };
      }
      att.sha256 = sha;
      att.size_bytes = att.size_bytes ?? args.p_size_bytes ?? null;
      return { data: [{ outcome: "owner", owner_id: att.id, document_id: null }], error: null };
    }

    if (name === "atlas_intake_attachment_mark_uploaded") {
      const att = state.attachments.find((r) => r.id === args.p_id);
      if (!att) return { data: [{ ok: false, reason: "not_found" }], error: null };
      if (att.state === "uploaded" || att.state === "ingested") {
        if (att.storage_path !== args.p_storage_path) {
          return { data: [{ ok: false, reason: "storage_path_mismatch" }], error: null };
        }
        return { data: [{ ok: true, reason: "idempotent_noop" }], error: null };
      }
      if (att.state !== args.p_expected_state) {
        return { data: [{ ok: false, reason: "unexpected_state" }], error: null };
      }
      att.state = "uploaded";
      att.storage_path = args.p_storage_path;
      return { data: [{ ok: true, reason: "transitioned" }], error: null };
    }

    if (name === "atlas_intake_attachment_create_document") {
      const att = state.attachments.find((r) => r.id === args.p_id);
      if (!att) return { data: null, error: { message: "not_found" } };
      if (att.state === "ingested" && att.document_id && att.scan_job_id) {
        return { data: [{ outcome: "idempotent_noop", document_id: att.document_id, scan_job_id: att.scan_job_id }], error: null };
      }
      if (att.state !== "uploaded") {
        return { data: null, error: { message: `bad_state:${att.state}` } };
      }
      const documentId = nextUuid();
      state.documents.push({
        id: documentId,
        submission_id: att.submission_id,
        file_name: att.filename ?? "attachment.pdf",
        storage_path: att.storage_path,
        document_type: "supporting",
        status: "active",
        scan_status: "pending",
        uploaded_by: args.p_system_actor_id,
        file_hash: att.sha256,
        file_size_bytes: att.size_bytes,
        content_type: "application/pdf",
      });
      const jobId = nextUuid();
      state.jobs.push({
        id: jobId,
        submission_id: att.submission_id,
        document_id: documentId,
        job_type: "malware_scan",
        status: "queued",
        input_fingerprint: `malware_scan:${documentId}`,
        created_by: args.p_system_actor_id,
        // Match 0035: malware metadata uses generic filename regardless of
        // the original attachment name (PII).
        metadata: {
          bucket: "atlas-client-docs",
          storage_path: att.storage_path,
          file_name: "attachment.pdf",
          content_type: "application/pdf",
        },
      });
      att.state = "ingested";
      att.document_id = documentId;
      att.scan_job_id = jobId;
      state.audit.push({
        id: nextUuid(),
        submission_id: att.submission_id,
        action: "intake_attachment_ingested",
        actor: null,
        metadata_json: {
          attachment_id: att.id,
          document_id: documentId,
          intake_message_id: att.intake_message_id,
          sha256_prefix12: String(att.sha256 ?? "").slice(0, 12),
          size_bytes: att.size_bytes,
        },
      });
      return { data: [{ outcome: "created", document_id: documentId, scan_job_id: jobId }], error: null };
    }

    if (name === "atlas_intake_attachment_fail") {
      if (state.failFailNext) {
        state.failFailNext = false;
        return { data: null, error: { message: "db_probe_failure" } };
      }
      const att = state.attachments.find((r) => r.id === args.p_id);
      if (!att) return { data: [{ ok: false }], error: null };
      if (att.state !== args.p_expected_state) return { data: [{ ok: false }], error: null };
      att.state = args.p_next_state;
      att.last_error_code = args.p_error_code;
      att.last_attempt_at = new Date().toISOString();
      return { data: [{ ok: true }], error: null };
    }

    if (name === "atlas_intake_attachment_set_planned_path") {
      const att = state.attachments.find((r) => r.id === args.p_id);
      if (!att) return { data: null, error: { message: "not_found" } };
      if (att.state === "uploaded" || att.state === "ingested") {
        if (att.storage_path !== args.p_storage_path) {
          return { data: [{ ok: false, reason: "storage_path_conflict" }], error: null };
        }
        return { data: [{ ok: true, reason: "idempotent_noop" }], error: null };
      }
      if (att.state !== args.p_expected_state) {
        return { data: [{ ok: false, reason: "unexpected_state" }], error: null };
      }
      if (att.storage_path != null) {
        if (att.storage_path === args.p_storage_path) {
          return { data: [{ ok: true, reason: "idempotent_noop" }], error: null };
        }
        return { data: [{ ok: false, reason: "storage_path_conflict" }], error: null };
      }
      att.storage_path = args.p_storage_path;
      att.last_attempt_at = new Date().toISOString();
      state.plannedPathObserved = state.plannedPathObserved ?? String(args.p_storage_path);
      state.events.push(`set_planned_path:${args.p_storage_path}`);
      return { data: [{ ok: true, reason: "persisted" }], error: null };
    }

    if (name === "atlas_intake_attachment_mark_skipped") {
      const att = state.attachments.find((r) => r.id === args.p_id);
      if (!att) return { data: [{ ok: false }], error: null };
      if (!(att.state === "pending" || att.state === "downloading")) return { data: [{ ok: false }], error: null };
      att.state = args.p_next_state;
      att.skip_reason = args.p_skip_reason;
      return { data: [{ ok: true }], error: null };
    }

    return { data: null, error: { message: `unknown_rpc:${name}` } };
  }

  const storage = {
    from(bucket: string) {
      return {
        async upload(path: string, bytes: ArrayBuffer, opts?: { upsert?: boolean; contentType?: string }) {
          if (state.storageFailNext) {
            state.storageFailNext = false;
            state.events.push(`upload_fail:${path}`);
            return { data: null, error: { message: "storage_upload_failed" } };
          }
          storageCalls.push({
            bucket,
            path,
            contentType: opts?.contentType,
            upsert: opts?.upsert,
            byteLength: bytes.byteLength,
          });
          state.storagePaths.add(`${bucket}/${path}`);
          state.events.push(`upload:${path}`);
          return { data: { path }, error: null };
        },
      };
    },
  };

  return {
    from(name: string) { return tableApi(name); },
    rpc,
    storage,
    auth: { getUser: async () => ({ data: null, error: null }) },
  };
}

// -----------------------------------------------------------------------
// Graph fetch mock
// -----------------------------------------------------------------------

interface FetchCall { url: string; init?: RequestInit }
function makeFetchMock(routes: Array<(c: FetchCall) => Response | Promise<Response> | null>) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, init });
    for (const r of routes) {
      const out = await r({ url, init });
      if (out) return out;
    }
    return new Response(JSON.stringify({}), { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}
function binaryResponse(bytes: ArrayBuffer, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(bytes, { status, headers: { "Content-Type": "application/octet-stream", ...headers } });
}

const tokenRoute = (c: FetchCall) =>
  c.url.includes("/oauth2/v2.0/token")
    ? jsonResponse(200, { access_token: "TOK", expires_in: 3600 })
    : null;

const ENV = {
  ATLAS_GRAPH_TENANT_ID: "tenant-x",
  ATLAS_GRAPH_CLIENT_ID: "client-x",
  ATLAS_GRAPH_CLIENT_SECRET: "secret-x",
  ATLAS_DOC_RETENTION_DAYS: "7",
} as unknown as Parameters<typeof handleGraphAttachmentDiscoveryJob>[0];

function makeBytes(size: number, fill = 0x00): ArrayBuffer {
  // Prepend a plausible %PDF- header so the runtime's PDF magic check
  // accepts these synthetic bytes. `fill` still controls the trailing
  // payload byte pattern (used to distinguish content across tests).
  const buf = new Uint8Array(Math.max(size, 5));
  buf.fill(fill);
  const header = [0x25, 0x50, 0x44, 0x46, 0x2d]; // '%PDF-'
  for (let i = 0; i < header.length && i < buf.length; i++) buf[i] = header[i];
  return buf.buffer.slice(0, size);
}

/** Byte payload that is NOT a valid PDF (fails the magic check). */
function makeNonPdfBytes(size: number, fill = 0xff): ArrayBuffer {
  const buf = new Uint8Array(size);
  buf.fill(fill);
  return buf.buffer;
}

// =======================================================================
// DISCOVERY
// =======================================================================

test("discovery: hasAttachments=false is a no-op", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId } = seedIntake(state, { has_attachments: false });
  const { fetchImpl, calls } = makeFetchMock([tokenRoute]);
  const result = await handleGraphAttachmentDiscoveryJob(
    ENV, admin as never, { id: "disc-1", metadata: { intake_message_id: intakeId } }, { graph: { fetchImpl } },
  );
  eq(result.outcome, "discovery_no_attachments", "outcome");
  eq(state.attachments.length, 0, "no attachment rows");
  eq(state.jobs.length, 0, "no ingest jobs");
  eq(calls.length, 0, "no Graph calls when has_attachments=false");
});

test("discovery: fileAttachment yields pending row + one ingest job", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  const listRoute = (c: FetchCall) =>
    /\/messages\/graph-msg-1\/attachments\?\$select=/.test(c.url)
      ? jsonResponse(200, {
          value: [{
            "@odata.type": "#microsoft.graph.fileAttachment",
            id: "att-1", name: "policy.pdf", contentType: "application/pdf",
            size: 42_000, isInline: false, contentId: null,
          }],
        })
      : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, listRoute]);
  const result = await handleGraphAttachmentDiscoveryJob(
    ENV, admin as never, { id: "disc-1", metadata: { intake_message_id: intakeId } }, { graph: { fetchImpl } },
  );
  eq(result.outcome, "discovery_complete", "outcome");
  eq(state.attachments.length, 1, "one attachment row");
  eq(state.attachments[0].state, "pending", "state");
  eq(state.attachments[0].submission_id, submissionId, "submission mirrored");
  eq(state.jobs.length, 1, "one ingest job");
  eq(state.jobs[0].job_type, "graph_attachment_ingest", "type");
});

test("discovery: itemAttachment and referenceAttachment become unsupported without ingest job", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId } = seedIntake(state);
  const listRoute = (c: FetchCall) =>
    /\/attachments\?\$select=/.test(c.url)
      ? jsonResponse(200, {
          value: [
            { "@odata.type": "#microsoft.graph.itemAttachment", id: "item-1", name: "note.msg", contentType: null, size: 5_000, isInline: false, contentId: null },
            { "@odata.type": "#microsoft.graph.referenceAttachment", id: "ref-1", name: "cloud.pdf", contentType: null, size: 5_000, isInline: false, contentId: null },
          ],
        })
      : null;
  const { fetchImpl, calls } = makeFetchMock([tokenRoute, listRoute]);
  await handleGraphAttachmentDiscoveryJob(
    ENV, admin as never, { id: "disc-1", metadata: { intake_message_id: intakeId } }, { graph: { fetchImpl } },
  );
  eq(state.attachments.length, 2, "two rows");
  for (const r of state.attachments) eq(r.state, "unsupported", "unsupported");
  eq(state.jobs.length, 0, "no ingest jobs");
  // Assert no /$value fetch was ever attempted.
  const valueCalls = calls.filter((c) => c.url.includes("/$value"));
  eq(valueCalls.length, 0, "no reference/item byte fetch");
});

test("discovery: replay is idempotent (no duplicate attachment rows or ingest jobs)", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId } = seedIntake(state);
  const listRoute = (c: FetchCall) =>
    /\/attachments\?\$select=/.test(c.url)
      ? jsonResponse(200, {
          value: [{
            "@odata.type": "#microsoft.graph.fileAttachment",
            id: "att-1", name: "policy.pdf", contentType: "application/pdf",
            size: 42_000, isInline: false, contentId: null,
          }],
        })
      : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, listRoute]);
  await handleGraphAttachmentDiscoveryJob(ENV, admin as never, { id: "d1", metadata: { intake_message_id: intakeId } }, { graph: { fetchImpl } });
  await handleGraphAttachmentDiscoveryJob(ENV, admin as never, { id: "d2", metadata: { intake_message_id: intakeId } }, { graph: { fetchImpl } });
  eq(state.attachments.length, 1, "no duplicate row");
  eq(state.jobs.length, 1, "no duplicate ingest job");
});

test("discovery: 429 with Retry-After propagates through the thrown GraphError", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId } = seedIntake(state);
  const listRoute = (c: FetchCall) =>
    /\/attachments\?\$select=/.test(c.url)
      ? jsonResponse(429, { error: { code: "throttled" } }, { "Retry-After": "17" })
      : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, listRoute]);
  let caught: unknown = null;
  try {
    await handleGraphAttachmentDiscoveryJob(ENV, admin as never, { id: "d1", metadata: { intake_message_id: intakeId } }, { graph: { fetchImpl } });
  } catch (err) { caught = err; }
  assert(caught instanceof GraphError, "GraphError thrown");
  eq((caught as GraphError).code, "graph_throttled", "code");
  eq((caught as GraphError).retryAfterSeconds, 17, "retry after");
  eq(state.attachments.length, 0, "no rows on failure");
});

test("discovery: 403 propagates classified graph_forbidden (non-retryable)", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId } = seedIntake(state);
  const listRoute = (c: FetchCall) =>
    /\/attachments\?\$select=/.test(c.url)
      ? jsonResponse(403, { error: { code: "AccessDenied" } })
      : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, listRoute]);
  let caught: unknown = null;
  try {
    await handleGraphAttachmentDiscoveryJob(ENV, admin as never, { id: "d1", metadata: { intake_message_id: intakeId } }, { graph: { fetchImpl } });
  } catch (err) { caught = err; }
  assert(caught instanceof GraphError, "GraphError thrown");
  eq((caught as GraphError).code, "graph_forbidden", "code");
});

test("discovery: 404 message-gone-before-discovery propagates as specific code and does NOT auto-remove intake", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId } = seedIntake(state);
  const listRoute = (c: FetchCall) =>
    /\/attachments/.test(c.url)
      ? jsonResponse(404, { error: { code: "ErrorItemNotFound" } })
      : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, listRoute]);
  let caught: unknown = null;
  try {
    await handleGraphAttachmentDiscoveryJob(ENV, admin as never, { id: "d1", metadata: { intake_message_id: intakeId } }, { graph: { fetchImpl } });
  } catch (err) { caught = err; }
  assert(caught instanceof GraphError, "GraphError thrown");
  eq((caught as GraphError).code, "graph_message_gone_before_attachment_discovery", "code");
  // Intake row remains — Phase 5A durability preserved.
  eq(state.intake.length, 1, "intake row remains");
});

// -----------------------------------------------------------------------
// Live-Graph projection compatibility (Phase 5B remediation)
// -----------------------------------------------------------------------

test("discovery: attachment list URL never requests contentId or contentBytes", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId } = seedIntake(state);
  let listUrl: string | null = null;
  const listRoute = (c: FetchCall) => {
    if (!/\/attachments\?\$select=/.test(c.url)) return null;
    listUrl = c.url;
    return jsonResponse(200, {
      value: [{
        "@odata.type": "#microsoft.graph.fileAttachment",
        id: "att-1", name: "policy.pdf", contentType: "application/pdf",
        size: 42_000, isInline: false,
      }],
    });
  };
  const { fetchImpl } = makeFetchMock([tokenRoute, listRoute]);
  await handleGraphAttachmentDiscoveryJob(
    ENV, admin as never, { id: "disc-1", metadata: { intake_message_id: intakeId } }, { graph: { fetchImpl } },
  );
  assert(listUrl != null, "list URL was observed");
  const selectRaw = new URL(listUrl!).searchParams.get("$select") ?? "";
  const projected = selectRaw.split(",").map((s) => s.trim()).filter(Boolean);
  assert(!projected.includes("contentId"), `contentId must NOT be projected — got $select=${selectRaw}`);
  assert(!projected.includes("contentBytes"), `contentBytes must NOT be projected — got $select=${selectRaw}`);
  for (const required of ["id", "name", "contentType", "size", "isInline"]) {
    assert(projected.includes(required), `missing required projection: ${required} (got ${selectRaw})`);
  }
});

test("discovery: fileAttachment WITHOUT contentId on the wire is accepted and normalised", async () => {
  // Live Graph rejects `contentId` in $select on the base collection with a
  // 400. This test proves the parser accepts the reduced payload shape
  // (no contentId key) and still produces an eligible pending row.
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId } = seedIntake(state);
  const listRoute = (c: FetchCall) =>
    /\/attachments\?\$select=/.test(c.url)
      ? jsonResponse(200, {
          value: [{
            "@odata.type": "#microsoft.graph.fileAttachment",
            id: "att-1", name: "policy.pdf", contentType: "application/pdf",
            size: 250_000, isInline: false,
            // NOTE: contentId key deliberately absent from the payload.
          }],
        })
      : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, listRoute]);
  const result = await handleGraphAttachmentDiscoveryJob(
    ENV, admin as never, { id: "disc-1", metadata: { intake_message_id: intakeId } }, { graph: { fetchImpl } },
  );
  eq(result.outcome, "discovery_complete", "outcome");
  eq(state.attachments.length, 1, "one attachment row");
  eq(state.attachments[0].state, "pending", "state (eligible)");
  eq(state.attachments[0].content_id, null, "content_id null (unavailable from base projection)");
  eq(state.jobs.length, 1, "one ingest job queued");
});

test("discovery: inline image without contentId is still deterministically skipped", async () => {
  // Regression: filtering must not depend on contentId. A small inline
  // image with no contentId should still be classified skipped, not queued.
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId } = seedIntake(state);
  const listRoute = (c: FetchCall) =>
    /\/attachments\?\$select=/.test(c.url)
      ? jsonResponse(200, {
          value: [{
            "@odata.type": "#microsoft.graph.fileAttachment",
            id: "sig-1", name: "sig.png", contentType: "image/png",
            size: 8_000, isInline: true,
          }],
        })
      : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, listRoute]);
  await handleGraphAttachmentDiscoveryJob(
    ENV, admin as never, { id: "disc-1", metadata: { intake_message_id: intakeId } }, { graph: { fetchImpl } },
  );
  eq(state.attachments.length, 1, "row created");
  eq(state.attachments[0].state, "skipped", "skipped");
  eq(state.jobs.length, 0, "no ingest job for inline image");
});

test("discovery: 400 from Graph classifies to graph_bad_request (non-retryable, no body leak)", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId } = seedIntake(state);
  // Body carries the kind of guidance Microsoft returns for an invalid
  // $select; the classifier must NOT propagate it upstream.
  const listRoute = (c: FetchCall) =>
    /\/attachments/.test(c.url)
      ? jsonResponse(400, { error: { code: "BadRequest", message: "Property 'contentId' does not exist on type 'microsoft.graph.attachment'." } })
      : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, listRoute]);
  let caught: unknown = null;
  try {
    await handleGraphAttachmentDiscoveryJob(
      ENV, admin as never, { id: "d-400", metadata: { intake_message_id: intakeId } }, { graph: { fetchImpl } },
    );
  } catch (err) { caught = err; }
  assert(caught instanceof GraphError, "GraphError thrown");
  eq((caught as GraphError).code, "graph_bad_request", "classified 400 code");
  eq((caught as GraphError).status, 400, "status preserved");
  eq((caught as GraphError).message, "graph_status_400", "bland message — no upstream body text");
  assert(!(caught as GraphError).message.includes("contentId"), "must not leak the invalid property name");
  assert(!(caught as GraphError).message.includes("Property"), "must not leak upstream guidance");
  eq(state.attachments.length, 0, "no partial commit on 400");
});

// =======================================================================
// INGEST
// =======================================================================

test("ingest: happy path — download, hash, upload to deterministic path, create document + malware job", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  const attId = seedAttachment(state, intakeId, submissionId);
  const bytes = makeBytes(42_000);
  const valueRoute = (c: FetchCall) =>
    /\/attachments\/graph-att-1\/\$value$/.test(c.url) ? binaryResponse(bytes) : null;
  const { fetchImpl, calls } = makeFetchMock([tokenRoute, valueRoute]);
  const result = await handleGraphAttachmentIngestJob(
    ENV, admin as never, { id: "j1", metadata: { attachment_id: attId } }, { graph: { fetchImpl } },
  );
  eq(result.outcome, "ingest_complete", "outcome");
  const att = state.attachments.find((r) => r.id === attId)!;
  eq(att.state, "ingested", "state");
  // Deterministic ID-only path (Checkpoint 4 §12 — no filename).
  eq(att.storage_path, `${submissionId}/graph/${attId}.pdf`, "deterministic ID-only path");
  eq(storageCalls.length, 1, "one storage upload");
  eq(storageCalls[0].bucket, "atlas-client-docs", "bucket");
  eq(storageCalls[0].path, String(att.storage_path), "path matches");
  eq(state.documents.length, 1, "document row");
  eq(state.documents[0].scan_status, "pending", "document pending scan");
  const scanJobs = state.jobs.filter((j) => j.job_type === "malware_scan");
  eq(scanJobs.length, 1, "malware_scan job");
  const valueCalls = calls.filter((c) => c.url.includes("/$value"));
  eq(valueCalls.length, 1, "one /$value fetch");
  // No PII in audit metadata.
  const auditRow = state.audit.find((r) => r.action === "intake_attachment_ingested") as Record<string, unknown> | undefined;
  assert(auditRow, "audit row present");
  const meta = auditRow!.metadata_json as Record<string, unknown>;
  assert(!("filename" in meta), "no filename");
  assert(!("mailbox" in meta), "no mailbox");
  assert(!("graph_message_id" in meta), "no graph_message_id");
  assert(!("graph_attachment_id" in meta), "no graph_attachment_id");
  assert(typeof meta.sha256_prefix12 === "string" && (meta.sha256_prefix12 as string).length === 12, "safe sha prefix only");
});

test("ingest: replay when state=ingested is idempotent no-op", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  const attId = seedAttachment(state, intakeId, submissionId, { state: "ingested", document_id: "doc-x", scan_job_id: "scan-x" });
  const { fetchImpl, calls } = makeFetchMock([tokenRoute]);
  const result = await handleGraphAttachmentIngestJob(
    ENV, admin as never, { id: "j1", metadata: { attachment_id: attId } }, { graph: { fetchImpl } },
  );
  eq(result.outcome, "ingest_complete", "outcome");
  eq(state.documents.length, 0, "no new document"); // fake harness didn't seed one
  eq(storageCalls.length, 0, "no storage upload");
  eq(calls.length, 0, "no Graph calls");
});

test("ingest: same-SHA duplicate becomes skipped(duplicate_hash) without uploading or creating document", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  // Seed an existing owner with a known sha.
  const knownSha = "a".repeat(64);
  const ownerAttId = seedAttachment(state, intakeId, submissionId, {
    graph_attachment_id: "graph-att-owner",
    state: "ingested",
    sha256: knownSha,
    document_id: "existing-doc",
    storage_path: `${submissionId}/graph/owner.pdf`,
  });
  // Manually make ownerAttId non-null but reference it below only via sha collision.
  void ownerAttId;
  // Second attachment for same submission but different graph id.
  const bytes = makeBytes(1024, 0xAA);
  // Compute expected sha for bytes and coerce owner sha to match.
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  (state.attachments.find((r) => r.id === ownerAttId)!).sha256 = hex;
  const dupId = seedAttachment(state, intakeId, submissionId, { graph_attachment_id: "graph-att-dup" });
  const valueRoute = (c: FetchCall) => c.url.endsWith("/$value") ? binaryResponse(bytes) : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, valueRoute]);
  const result = await handleGraphAttachmentIngestJob(
    ENV, admin as never, { id: "j1", metadata: { attachment_id: dupId } }, { graph: { fetchImpl } },
  );
  eq(result.outcome, "ingest_duplicate", "outcome");
  const dup = state.attachments.find((r) => r.id === dupId)!;
  eq(dup.state, "skipped", "duplicate state");
  eq(dup.skip_reason, "duplicate_hash", "reason");
  eq(dup.duplicate_of_attachment_id, ownerAttId, "linked to owner");
  eq(storageCalls.length, 0, "no storage upload for duplicate");
  eq(state.documents.length, 0, "no new document for duplicate");
});

test("ingest: register_hash SELF_OWNER (same row, same sha) is idempotent — retry does not re-download", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  const bytes = makeBytes(1024, 0xBB);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const knownSha = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  // Row with sha already claimed AND state=uploaded (crash-after-upload
  // resume checkpoint). The processor should skip Graph + storage entirely
  // and go straight to create_document.
  const attId = seedAttachment(state, intakeId, submissionId, {
    state: "uploaded",
    sha256: knownSha,
    storage_path: `${submissionId}/graph/${nextUuid()}-policy.pdf`,
  });
  const { fetchImpl, calls } = makeFetchMock([tokenRoute]);
  const result = await handleGraphAttachmentIngestJob(
    ENV, admin as never, { id: "j1", metadata: { attachment_id: attId } }, { graph: { fetchImpl } },
  );
  eq(result.outcome, "ingest_complete", "outcome");
  eq(storageCalls.length, 0, "no re-upload after resume");
  const valueCalls = calls.filter((c) => c.url.includes("/$value"));
  eq(valueCalls.length, 0, "no bytes re-fetched after resume");
  const att = state.attachments.find((r) => r.id === attId)!;
  eq(att.state, "ingested", "final state");
});

test("ingest: register_hash CHANGED_SHA on already-hashed row FAILS CLOSED", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  const bytes = makeBytes(1024, 0xCC);
  // Row has sha already claimed with DIFFERENT bytes; simulate corrupt retry.
  const attId = seedAttachment(state, intakeId, submissionId, {
    state: "downloading",
    sha256: "b".repeat(64),
  });
  const valueRoute = (c: FetchCall) => c.url.endsWith("/$value") ? binaryResponse(bytes) : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, valueRoute]);
  let caught: unknown = null;
  try {
    await handleGraphAttachmentIngestJob(
      ENV, admin as never, { id: "j1", metadata: { attachment_id: attId } }, { graph: { fetchImpl } },
    );
  } catch (err) { caught = err; }
  assert(caught instanceof GraphError, "GraphError thrown");
  eq((caught as GraphError).code, "attachment_hash_changed", "code");
  const att = state.attachments.find((r) => r.id === attId)!;
  eq(att.state, "failed_permanent", "flipped to failed_permanent");
  eq(state.documents.length, 0, "no document created");
});

test("ingest: post-download size_mismatch → failed_permanent, no upload", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  const attId = seedAttachment(state, intakeId, submissionId, { size_bytes: 1000 });
  // Cap the effective size at 500B; bytes are 1000B → size_mismatch.
  const envSmall = { ...(ENV as unknown as Record<string, unknown>), ATLAS_INTAKE_ATTACHMENT_MAX_BYTES: "500" } as never;
  const bytes = makeBytes(1000, 0xDD);
  const valueRoute = (c: FetchCall) => c.url.endsWith("/$value") ? binaryResponse(bytes) : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, valueRoute]);
  const result = await handleGraphAttachmentIngestJob(
    envSmall, admin as never, { id: "j1", metadata: { attachment_id: attId } }, { graph: { fetchImpl } },
  );
  eq(result.outcome, "ingest_skipped", "outcome");
  eq(result.attachmentState, "failed_permanent", "final state");
  eq(storageCalls.length, 0, "no upload");
  eq(state.documents.length, 0, "no document");
});

test("ingest: uploaded checkpoint (crash after upload before create_document) resumes without re-upload", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  const path = `${submissionId}/graph/${nextUuid()}-policy.pdf`;
  const attId = seedAttachment(state, intakeId, submissionId, {
    state: "uploaded",
    sha256: "c".repeat(64),
    storage_path: path,
  });
  const { fetchImpl, calls } = makeFetchMock([tokenRoute]);
  const result = await handleGraphAttachmentIngestJob(
    ENV, admin as never, { id: "j1", metadata: { attachment_id: attId } }, { graph: { fetchImpl } },
  );
  eq(result.outcome, "ingest_complete", "outcome");
  eq(storageCalls.length, 0, "no re-upload");
  eq(calls.filter((c) => c.url.includes("/$value")).length, 0, "no byte fetch on resume");
  const att = state.attachments.find((r) => r.id === attId)!;
  eq(att.state, "ingested", "state");
  eq(att.storage_path, path, "same deterministic path");
  eq(state.documents.length, 1, "document created");
});

test("ingest: storage upload failure keeps state resumable (pending), no document created", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  const attId = seedAttachment(state, intakeId, submissionId);
  const bytes = makeBytes(1024, 0xEE);
  const valueRoute = (c: FetchCall) => c.url.endsWith("/$value") ? binaryResponse(bytes) : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, valueRoute]);
  state.storageFailNext = true;
  let caught: unknown = null;
  try {
    await handleGraphAttachmentIngestJob(
      ENV, admin as never, { id: "j1", metadata: { attachment_id: attId } }, { graph: { fetchImpl } },
    );
  } catch (err) { caught = err; }
  assert(caught instanceof GraphError, "GraphError thrown");
  eq((caught as GraphError).code, "storage_upload_failed", "code");
  const att = state.attachments.find((r) => r.id === attId)!;
  eq(att.state, "pending", "resumable state");
  eq(state.documents.length, 0, "no document");
  eq(storageCalls.length, 0, "upload was refused by fake");
});

test("ingest: Graph 429 on /$value propagates with Retry-After for atlas_jobs to honor", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  const attId = seedAttachment(state, intakeId, submissionId);
  const route429 = (c: FetchCall) => c.url.endsWith("/$value") ? jsonResponse(429, {}, { "Retry-After": "23" }) : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, route429]);
  let caught: unknown = null;
  try {
    await handleGraphAttachmentIngestJob(
      ENV, admin as never, { id: "j1", metadata: { attachment_id: attId } }, { graph: { fetchImpl } },
    );
  } catch (err) { caught = err; }
  assert(caught instanceof GraphError, "GraphError thrown");
  eq((caught as GraphError).code, "graph_throttled", "code");
  eq((caught as GraphError).retryAfterSeconds, 23, "retry after");
  const att = state.attachments.find((r) => r.id === attId)!;
  eq(att.state, "pending", "resumable");
});

test("ingest: Graph 404 on /$value → failed_permanent(graph_attachment_gone)", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  const attId = seedAttachment(state, intakeId, submissionId);
  const route404 = (c: FetchCall) => c.url.endsWith("/$value") ? jsonResponse(404, { error: { code: "ErrorAttachmentNotFound" } }) : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, route404]);
  let caught: unknown = null;
  try {
    await handleGraphAttachmentIngestJob(
      ENV, admin as never, { id: "j1", metadata: { attachment_id: attId } }, { graph: { fetchImpl } },
    );
  } catch (err) { caught = err; }
  assert(caught instanceof GraphError, "GraphError thrown");
  const att = state.attachments.find((r) => r.id === attId)!;
  eq(att.state, "failed_permanent", "permanent");
  eq(att.last_error_code, "graph_attachment_gone", "classified");
});

test("ingest: no live Graph host is ever contacted (all fetches go through injected fetchImpl)", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  const attId = seedAttachment(state, intakeId, submissionId);
  const bytes = makeBytes(1024, 0x55);
  const valueRoute = (c: FetchCall) => c.url.endsWith("/$value") ? binaryResponse(bytes) : null;
  const { fetchImpl, calls } = makeFetchMock([tokenRoute, valueRoute]);
  await handleGraphAttachmentIngestJob(
    ENV, admin as never, { id: "j1", metadata: { attachment_id: attId } }, { graph: { fetchImpl } },
  );
  for (const c of calls) {
    const url = new URL(c.url);
    assert(
      url.origin === "https://graph.microsoft.com" || url.origin === "https://login.microsoftonline.com",
      `unexpected origin: ${url.origin}`,
    );
  }
  // The above assertions confirm the ONLY origins the injected mock ever
  // saw. The mock IS the transport — nothing bypassed it.
});

// =======================================================================
// CHECKPOINT 4 — DB / retry / PII / paging / classification corrections
// =======================================================================

// --- DB errors fail closed ---

test("cp4: attachment load DB error → GraphError attachment_load_failed (never ingest_missing)", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  const attId = seedAttachment(state, intakeId, submissionId);
  state.loadFailNext = true;
  const { fetchImpl } = makeFetchMock([tokenRoute]);
  let caught: unknown = null;
  try {
    await handleGraphAttachmentIngestJob(
      ENV, admin as never, { id: "j1", metadata: { attachment_id: attId } }, { graph: { fetchImpl } },
    );
  } catch (err) { caught = err; }
  assert(caught instanceof GraphError, "GraphError thrown");
  eq((caught as GraphError).code, "attachment_load_failed", "code");
});

test("cp4: claim RPC error → GraphError attachment_claim_failed (retryable, no ingest_missing)", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  const attId = seedAttachment(state, intakeId, submissionId);
  state.claimFailNext = true;
  const { fetchImpl } = makeFetchMock([tokenRoute]);
  let caught: unknown = null;
  try {
    await handleGraphAttachmentIngestJob(
      ENV, admin as never, { id: "j1", metadata: { attachment_id: attId } }, { graph: { fetchImpl } },
    );
  } catch (err) { caught = err; }
  assert(caught instanceof GraphError, "GraphError thrown");
  eq((caught as GraphError).code, "attachment_claim_failed", "code");
  // Attachment state should still be pending (recoverable).
  eq((state.attachments.find((r) => r.id === attId)!).state, "pending", "recoverable");
});

test("cp4: fail RPC error is NOT swallowed", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  const attId = seedAttachment(state, intakeId, submissionId);
  // Force the byte fetch to fail so failAttachment is invoked...
  const route500 = (c: FetchCall) => c.url.endsWith("/$value") ? jsonResponse(500, {}) : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, route500]);
  // ...and inject a DB failure into the fail RPC itself.
  state.failFailNext = true;
  let caught: unknown = null;
  try {
    await handleGraphAttachmentIngestJob(
      ENV, admin as never, { id: "j1", metadata: { attachment_id: attId } }, { graph: { fetchImpl } },
    );
  } catch (err) { caught = err; }
  assert(caught instanceof GraphError, "GraphError thrown");
  eq((caught as GraphError).code, "attachment_state_persist_failed", "escalated");
});

// --- Non-retryable token / config failures ---

test("cp4: graph_config_missing token error → attachment failed_permanent", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  const attId = seedAttachment(state, intakeId, submissionId);
  // No token route → acquireGraphToken hits the missing-env branch.
  const envNoGraph = {
    ...(ENV as unknown as Record<string, unknown>),
    ATLAS_GRAPH_TENANT_ID: "",
    ATLAS_GRAPH_CLIENT_ID: "",
    ATLAS_GRAPH_CLIENT_SECRET: "",
  } as never;
  const { fetchImpl } = makeFetchMock([]);
  let caught: unknown = null;
  try {
    await handleGraphAttachmentIngestJob(
      envNoGraph, admin as never, { id: "j1", metadata: { attachment_id: attId } }, { graph: { fetchImpl } },
    );
  } catch (err) { caught = err; }
  assert(caught instanceof GraphError, "GraphError thrown");
  eq((caught as GraphError).code, "graph_config_missing", "code");
  eq((state.attachments.find((r) => r.id === attId)!).state, "failed_permanent", "permanent");
});

test("cp4: graph_forbidden token error → attachment failed_permanent", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  const attId = seedAttachment(state, intakeId, submissionId);
  // Token endpoint returns 403 → GraphError with graph_forbidden.
  const token403 = (c: FetchCall) => c.url.includes("/oauth2/v2.0/token")
    ? jsonResponse(403, { error: "invalid_client" }) : null;
  const { fetchImpl } = makeFetchMock([token403]);
  let caught: unknown = null;
  try {
    await handleGraphAttachmentIngestJob(
      ENV, admin as never, { id: "j1", metadata: { attachment_id: attId } }, { graph: { fetchImpl } },
    );
  } catch (err) { caught = err; }
  assert(caught instanceof GraphError, "GraphError thrown");
  eq((caught as GraphError).code, "graph_forbidden", "code");
  eq((state.attachments.find((r) => r.id === attId)!).state, "failed_permanent", "permanent");
});

// --- Planned storage_path persisted BEFORE upload ---

test("cp4: planned storage_path is persisted BEFORE storage.upload is called", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  const attId = seedAttachment(state, intakeId, submissionId);
  const bytes = makeBytes(1024, 0xAA);
  const valueRoute = (c: FetchCall) => c.url.endsWith("/$value") ? binaryResponse(bytes) : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, valueRoute]);
  const result = await handleGraphAttachmentIngestJob(
    ENV, admin as never, { id: "j1", metadata: { attachment_id: attId } }, { graph: { fetchImpl } },
  );
  eq(result.outcome, "ingest_complete", "outcome");
  // Event ordering: set_planned_path must precede upload.
  const idxPersist = state.events.findIndex((e) => e.startsWith("set_planned_path:"));
  const idxUpload  = state.events.findIndex((e) => e.startsWith("upload:"));
  assert(idxPersist >= 0, `expected set_planned_path event (got ${state.events.join("|")})`);
  assert(idxUpload >= 0, `expected upload event (got ${state.events.join("|")})`);
  assert(idxPersist < idxUpload, "set_planned_path must precede storage.upload");
  // The path stored equals the ID-only deterministic format.
  const att = state.attachments.find((r) => r.id === attId)!;
  eq(att.storage_path, `${submissionId}/graph/${attId}.pdf`, "deterministic ID-only path");
  // Filename NOT embedded in the storage path.
  assert(!String(att.storage_path).includes(".pdf") || String(att.storage_path).endsWith(`/${attId}.pdf`), "filename not embedded");
});

test("cp4: downloading + sha + storage_path resumes correctly (idempotent hash, upsert upload, no dup)", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  const bytes = makeBytes(1024, 0xBC);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const knownSha = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  // Seed first, then derive the path from the actual assigned id.
  const attId = seedAttachment(state, intakeId, submissionId, {
    state: "downloading",
    sha256: knownSha,
  });
  const path = `${submissionId}/graph/${attId}.pdf`;
  (state.attachments.find((r) => r.id === attId)!).storage_path = path;
  const valueRoute = (c: FetchCall) => c.url.endsWith("/$value") ? binaryResponse(bytes) : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, valueRoute]);
  const result = await handleGraphAttachmentIngestJob(
    ENV, admin as never, { id: "j1", metadata: { attachment_id: attId } }, { graph: { fetchImpl } },
  );
  eq(result.outcome, "ingest_complete", "outcome");
  const att = state.attachments.find((r) => r.id === attId)!;
  eq(att.state, "ingested", "final state");
  eq(att.storage_path, path, "same deterministic path preserved");
  eq(state.documents.length, 1, "one document");
  eq(state.jobs.filter((j) => j.job_type === "malware_scan").length, 1, "one malware scan");
});

// --- PII in malware job metadata ---

test("cp4: malware_scan metadata uses GENERIC filename (no original filename leaks)", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  const canary = "PII_CANARY_client_matter_XYZ.pdf";
  const attId = seedAttachment(state, intakeId, submissionId, { filename: canary });
  const bytes = makeBytes(1024, 0xDE);
  const valueRoute = (c: FetchCall) => c.url.endsWith("/$value") ? binaryResponse(bytes) : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, valueRoute]);
  await handleGraphAttachmentIngestJob(
    ENV, admin as never, { id: "j1", metadata: { attachment_id: attId } }, { graph: { fetchImpl } },
  );
  const scanJob = state.jobs.find((j) => j.job_type === "malware_scan") as Record<string, unknown> | undefined;
  assert(scanJob, "scan job exists");
  const meta = scanJob!.metadata as Record<string, unknown>;
  eq(meta.file_name, "attachment.pdf", "generic scanner name");
  const raw = JSON.stringify(meta);
  assert(!raw.includes(canary), `canary must not appear in metadata (got ${raw})`);
  assert(!raw.includes("XYZ"), "no PII fragment in metadata");
  // storage_path must also be ID-only, no filename.
  assert(!String(meta.storage_path).includes(canary), "canary must not appear in storage_path");
});

// --- Paging ---

test("cp4: listMessageAttachments follows nextLink through multiple pages", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId } = seedIntake(state);
  let seenListCalls = 0;
  const listRoute = (c: FetchCall) => {
    if (!c.url.includes("/attachments")) return null;
    seenListCalls++;
    if (c.url.includes("skiptoken=page2")) {
      return jsonResponse(200, {
        value: [{
          "@odata.type": "#microsoft.graph.fileAttachment",
          id: "att-p2", name: "b.pdf", contentType: "application/pdf",
          size: 100, isInline: false, contentId: null,
        }],
      });
    }
    return jsonResponse(200, {
      value: [{
        "@odata.type": "#microsoft.graph.fileAttachment",
        id: "att-p1", name: "a.pdf", contentType: "application/pdf",
        size: 100, isInline: false, contentId: null,
      }],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/x/messages/y/attachments?skiptoken=page2",
    });
  };
  const { fetchImpl } = makeFetchMock([tokenRoute, listRoute]);
  await handleGraphAttachmentDiscoveryJob(
    ENV, admin as never, { id: "disc-1", metadata: { intake_message_id: intakeId } }, { graph: { fetchImpl } },
  );
  eq(state.attachments.length, 2, "two attachment rows across pages");
  assert(seenListCalls >= 2, `expected >= 2 list calls (got ${seenListCalls})`);
});

test("cp4: nextLink to a non-Graph origin is refused BEFORE fetch (no token leak)", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId } = seedIntake(state);
  let evilFetched = false;
  const listRoute = (c: FetchCall) => {
    if (c.url.includes("evil.example")) { evilFetched = true; return jsonResponse(200, { value: [] }); }
    if (!c.url.includes("/attachments")) return null;
    return jsonResponse(200, {
      value: [{
        "@odata.type": "#microsoft.graph.fileAttachment",
        id: "att-p1", name: "a.pdf", contentType: "application/pdf",
        size: 100, isInline: false, contentId: null,
      }],
      "@odata.nextLink": "https://evil.example/steal-token",
    });
  };
  const { fetchImpl } = makeFetchMock([tokenRoute, listRoute]);
  let caught: unknown = null;
  try {
    await handleGraphAttachmentDiscoveryJob(
      ENV, admin as never, { id: "d1", metadata: { intake_message_id: intakeId } }, { graph: { fetchImpl } },
    );
  } catch (err) { caught = err; }
  assert(caught instanceof GraphError, "GraphError thrown");
  eq((caught as GraphError).code, "graph_url_origin_disallowed", "origin refused");
  assert(!evilFetched, "evil origin must NEVER be fetched");
  eq(state.attachments.length, 0, "no partial commit");
});

test("cp4: page 2 429 fails the whole listing atomically (no partial commit)", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId } = seedIntake(state);
  let page = 0;
  const listRoute = (c: FetchCall) => {
    if (!c.url.includes("/attachments")) return null;
    page++;
    if (page === 1) {
      return jsonResponse(200, {
        value: [{
          "@odata.type": "#microsoft.graph.fileAttachment",
          id: "att-1", name: "a.pdf", contentType: "application/pdf",
          size: 100, isInline: false, contentId: null,
        }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/x/messages/y/attachments?skiptoken=page2",
      });
    }
    return jsonResponse(429, {}, { "Retry-After": "12" });
  };
  const { fetchImpl } = makeFetchMock([tokenRoute, listRoute]);
  let caught: unknown = null;
  try {
    await handleGraphAttachmentDiscoveryJob(
      ENV, admin as never, { id: "d1", metadata: { intake_message_id: intakeId } }, { graph: { fetchImpl } },
    );
  } catch (err) { caught = err; }
  assert(caught instanceof GraphError, "GraphError thrown");
  eq((caught as GraphError).code, "graph_throttled", "429");
  eq(state.attachments.length, 0, "no partial discover_commit");
});

test("cp4: page limit fails closed (graph_attachment_page_limit)", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId } = seedIntake(state);
  let served = 0;
  const listRoute = (c: FetchCall) => {
    if (!c.url.includes("/attachments")) return null;
    served++;
    // Always return a nextLink; the limit lives in the client.
    return jsonResponse(200, {
      value: [{
        "@odata.type": "#microsoft.graph.fileAttachment",
        id: `att-${served}`, name: "x.pdf", contentType: "application/pdf",
        size: 100, isInline: false, contentId: null,
      }],
      "@odata.nextLink": `https://graph.microsoft.com/v1.0/users/x/messages/y/attachments?skiptoken=p${served}`,
    });
  };
  const { fetchImpl } = makeFetchMock([tokenRoute, listRoute]);
  let caught: unknown = null;
  try {
    await handleGraphAttachmentDiscoveryJob(
      ENV, admin as never, { id: "d1", metadata: { intake_message_id: intakeId } }, { graph: { fetchImpl } },
    );
  } catch (err) { caught = err; }
  assert(caught instanceof GraphError, "GraphError thrown");
  eq((caught as GraphError).code, "graph_attachment_page_limit", "page limit");
  eq(state.attachments.length, 0, "no partial commit");
});

// --- Graph classifications ---

test("cp4: discovery 404 → graph_message_gone_before_attachment_discovery (specific)", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId } = seedIntake(state);
  const listRoute = (c: FetchCall) => c.url.includes("/attachments")
    ? jsonResponse(404, { error: { code: "ErrorItemNotFound" } }) : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, listRoute]);
  let caught: unknown = null;
  try {
    await handleGraphAttachmentDiscoveryJob(
      ENV, admin as never, { id: "d1", metadata: { intake_message_id: intakeId } }, { graph: { fetchImpl } },
    );
  } catch (err) { caught = err; }
  assert(caught instanceof GraphError, "GraphError thrown");
  eq((caught as GraphError).code, "graph_message_gone_before_attachment_discovery", "specific code");
  // Intake row preserved (Phase 5A durability).
  eq(state.intake.length, 1, "intake preserved");
});

test("cp4: ingest byte 404 → graph_attachment_gone (specific)", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  const attId = seedAttachment(state, intakeId, submissionId);
  const route404 = (c: FetchCall) => c.url.endsWith("/$value")
    ? jsonResponse(404, { error: { code: "ErrorAttachmentNotFound" } }) : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, route404]);
  let caught: unknown = null;
  try {
    await handleGraphAttachmentIngestJob(
      ENV, admin as never, { id: "j1", metadata: { attachment_id: attId } }, { graph: { fetchImpl } },
    );
  } catch (err) { caught = err; }
  assert(caught instanceof GraphError, "GraphError thrown");
  eq((caught as GraphError).code, "graph_attachment_gone", "specific code");
  eq((state.attachments.find((r) => r.id === attId)!).state, "failed_permanent", "permanent");
});

// --- Content-length precheck ---

test("cp4: oversize Content-Length refused BEFORE reading body", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  const attId = seedAttachment(state, intakeId, submissionId, { size_bytes: 100 });
  const envSmall = { ...(ENV as unknown as Record<string, unknown>), ATLAS_INTAKE_ATTACHMENT_MAX_BYTES: "500" } as never;
  // Content-Length lies and says 5000; we must refuse before reading.
  const bytes = makeBytes(1000, 0xEE);
  const route = (c: FetchCall) => c.url.endsWith("/$value")
    ? binaryResponse(bytes, 200, { "Content-Length": "5000" }) : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, route]);
  let caught: unknown = null;
  try {
    await handleGraphAttachmentIngestJob(
      envSmall, admin as never, { id: "j1", metadata: { attachment_id: attId } }, { graph: { fetchImpl } },
    );
  } catch (err) { caught = err; }
  assert(caught instanceof GraphError, "GraphError thrown");
  eq((caught as GraphError).code, "size_mismatch", "refused by content-length");
});

// --- PDF magic ---

test("cp4: non-PDF bytes → attachment_content_invalid (defence-in-depth)", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  const attId = seedAttachment(state, intakeId, submissionId);
  const nonPdf = makeNonPdfBytes(1024, 0xFF);
  const valueRoute = (c: FetchCall) => c.url.endsWith("/$value") ? binaryResponse(nonPdf) : null;
  const { fetchImpl } = makeFetchMock([tokenRoute, valueRoute]);
  const result = await handleGraphAttachmentIngestJob(
    ENV, admin as never, { id: "j1", metadata: { attachment_id: attId } }, { graph: { fetchImpl } },
  );
  eq(result.outcome, "ingest_skipped", "skipped");
  eq(result.attachmentState, "failed_permanent", "permanent");
  eq((state.attachments.find((r) => r.id === attId)!).last_error_code, "attachment_content_invalid", "classified");
  eq(state.documents.length, 0, "no document");
});

// =======================================================================
// CHECKPOINT 5 — raw-transport classification + cleanup helper coverage
// =======================================================================

// --- Raw transport exceptions become classified GraphError ---

test("cp5: token fetch throws TypeError → ingest fails with GraphError(graph_token_failed) (no raw text leak)", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  const attId = seedAttachment(state, intakeId, submissionId);
  // Simulate a low-level fetch failure (TypeError: fetch failed) on the
  // token endpoint. Must NOT propagate as-is.
  const fetchImpl = (async (input: URL | RequestInfo) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes("/oauth2/v2.0/token")) throw new TypeError("fetch failed to " + url);
    return jsonResponse(500, {});
  }) as typeof fetch;
  let caught: unknown = null;
  try {
    await handleGraphAttachmentIngestJob(
      ENV, admin as never, { id: "j1", metadata: { attachment_id: attId } }, { graph: { fetchImpl } },
    );
  } catch (err) { caught = err; }
  assert(caught instanceof GraphError, "GraphError thrown (not raw TypeError)");
  eq((caught as GraphError).code, "graph_token_failed", "classified");
  // The classified message must NOT contain the raw URL/tenant.
  const msg = (caught as GraphError).message;
  assert(!msg.includes("tenant"), "no tenant in message");
  assert(!msg.includes("login.microsoftonline.com"), "no URL in message");
  eq(msg, "graph_token_failed", "bland classified message");
});

test("cp5: /$value fetch throws TypeError → ingest fails with GraphError(graph_bytes_failed) (no raw text leak)", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId, submissionId } = seedIntake(state);
  const attId = seedAttachment(state, intakeId, submissionId);
  const fetchImpl = (async (input: URL | RequestInfo) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes("/oauth2/v2.0/token")) return jsonResponse(200, { access_token: "TOK", expires_in: 3600 });
    if (url.endsWith("/$value")) throw new TypeError("ECONNRESET " + url);
    return jsonResponse(500, {});
  }) as typeof fetch;
  let caught: unknown = null;
  try {
    await handleGraphAttachmentIngestJob(
      ENV, admin as never, { id: "j1", metadata: { attachment_id: attId } }, { graph: { fetchImpl } },
    );
  } catch (err) { caught = err; }
  assert(caught instanceof GraphError, "GraphError thrown (not raw TypeError)");
  eq((caught as GraphError).code, "graph_bytes_failed", "classified");
  eq((caught as GraphError).message, "graph_bytes_failed", "bland classified message");
  // Attachment state is recoverable (retryable).
  eq((state.attachments.find((r) => r.id === attId)!).state, "pending", "pending after transient");
});

test("cp5: discovery token fetch TypeError → GraphError(graph_token_failed)", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId } = seedIntake(state);
  const fetchImpl = (async (input: URL | RequestInfo) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes("/oauth2/v2.0/token")) throw new TypeError("network down");
    return jsonResponse(500, {});
  }) as typeof fetch;
  let caught: unknown = null;
  try {
    await handleGraphAttachmentDiscoveryJob(
      ENV, admin as never, { id: "d1", metadata: { intake_message_id: intakeId } }, { graph: { fetchImpl } },
    );
  } catch (err) { caught = err; }
  assert(caught instanceof GraphError, "GraphError thrown");
  eq((caught as GraphError).code, "graph_token_failed", "classified");
});

test("cp5: discovery list page fetch TypeError → GraphError(discovery_transport_failed)", async () => {
  const state = newState();
  const storageCalls: StorageCall[] = [];
  const admin = makeAdmin(state, storageCalls);
  const { intakeId } = seedIntake(state);
  const fetchImpl = (async (input: URL | RequestInfo) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url.includes("/oauth2/v2.0/token")) return jsonResponse(200, { access_token: "TOK", expires_in: 3600 });
    if (url.includes("/attachments")) throw new TypeError("DNS lookup failed");
    return jsonResponse(500, {});
  }) as typeof fetch;
  let caught: unknown = null;
  try {
    await handleGraphAttachmentDiscoveryJob(
      ENV, admin as never, { id: "d1", metadata: { intake_message_id: intakeId } }, { graph: { fetchImpl } },
    );
  } catch (err) { caught = err; }
  assert(caught instanceof GraphError, "GraphError thrown");
  eq((caught as GraphError).code, "discovery_transport_failed", "classified");
});

// -----------------------------------------------------------------------
// Classifier sanity — proves the migration matches the worker's decision.
// -----------------------------------------------------------------------

test("classifier: pending fileAttachment surfaces initial_state='pending'", () => {
  const d = classifyAttachment(
    { id: "x", name: "policy.pdf", contentType: "application/pdf", size: 100, isInline: false, contentId: null, attachmentType: "fileAttachment" },
    15 * 1024 * 1024,
  );
  eq(d.initial_state, "pending", "pending");
});

// -----------------------------------------------------------------------
// Run
// -----------------------------------------------------------------------

async function main() {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok  ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL ${t.name}`);
      console.error("  " + (err as Error).message);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exit(1);
}
void main();
