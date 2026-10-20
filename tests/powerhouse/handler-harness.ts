/**
 * Network-free harness that runs the REAL recommendation endpoint
 * (`handleRunRecommendation` / `handleGetRecommendation`) against an in-memory
 * PostgREST stub. Powerhouse tests use it so the benchmark covers the whole
 * chain — deriveRisk → matcher → evidence → persisted row — not just a pure
 * function. Nothing here touches the network, the clock for ordering, or any
 * real credential.
 */

import type { AtlasUser } from "../../worker/src/auth.js";
import type { Env } from "../../worker/src/config.js";
import {
  handleGetRecommendation,
  handleRunRecommendation,
} from "../../worker/src/recommendation-endpoints.js";

const runtimeGlobals = globalThis as { WebSocket?: unknown };
if (typeof runtimeGlobals.WebSocket === "undefined") runtimeGlobals.WebSocket = class UnusedWebSocket {};

export type Row = Record<string, unknown>;
export interface Recorded { method: string; table: string; body: unknown; url: URL }

export const SUB = "11111111-1111-1111-1111-111111111111";
export const EXT = "22222222-2222-2222-2222-222222222222";
export const JOB = "33333333-3333-4333-8333-333333333333";
export const MANAGER = { id: "user-1", email: "manager@example.test", role: "manager" } as AtlasUser;

export function env(): Env {
  return {
    SUPABASE_URL: "http://stub.supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
    ANTHROPIC_API_KEY: "anthropic-test-key",
  } as unknown as Env;
}

export function installRestStub(
  seed: Record<string, Row[]>,
  options: { projectSelect?: boolean; failTables?: string[] } = {}
) {
  const original = globalThis.fetch;
  const requests: Recorded[] = [];
  const parse = (body: BodyInit | null | undefined): unknown => {
    if (typeof body !== "string") return undefined;
    try { return JSON.parse(body); } catch { return body; }
  };
  const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const match = url.pathname.match(/^\/rest\/v1\/([a-z_0-9]+)$/);
    if (!match) return response({ message: "unexpected request" }, 500);
    const table = match[1];
    const method = (init?.method ?? "GET").toUpperCase();
    const body = parse(init?.body);
    requests.push({ method, table, body, url });
    const headers = new Headers(init?.headers);
    const wantsObject = (headers.get("accept") ?? "").includes("vnd.pgrst.object+json");
    const wantsRepresentation = (headers.get("prefer") ?? "").includes("return=representation");

    if (method === "GET") {
      if ((options.failTables ?? []).includes(table)) {
        return response({ code: "57P03", message: "stub database error", details: null, hint: null }, 500);
      }
      let rows = [...(seed[table] ?? [])];
      url.searchParams.forEach((raw, key) => {
        if (["select", "order", "limit", "offset"].includes(key)) return;
        if (raw.startsWith("eq.")) {
          const expected = raw.slice(3);
          rows = rows.filter((row) => String(row[key]) === expected);
        } else if (raw.startsWith("in.(") && raw.endsWith(")")) {
          const expected = raw.slice(4, -1).split(",").map((item) => item.replace(/^"|"$/g, ""));
          rows = rows.filter((row) => expected.includes(String(row[key])));
        }
      });
      const select = url.searchParams.get("select");
      if (options.projectSelect && select) {
        const fields = select.split(",").map((item) => item.trim()).filter(Boolean);
        rows = rows.map((row) => Object.fromEntries(fields.map((fieldSpec) => {
          const separator = fieldSpec.indexOf(":");
          const output = separator >= 0 ? fieldSpec.slice(0, separator) : fieldSpec;
          const source = separator >= 0 ? fieldSpec.slice(separator + 1) : fieldSpec;
          return [output, row[source]];
        })));
      }
      if (wantsObject) {
        return rows.length === 1 ? response(rows[0]) : response({ code: "PGRST116", message: "0 rows" }, 406);
      }
      return response(rows);
    }

    if (wantsRepresentation) {
      const inserted = Array.isArray(body) ? body[0] : body;
      const row = { id: `stub-${table}`, ...(inserted as Row) };
      return wantsObject ? response(row, 201) : response([row], 201);
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return {
    requests,
    restore: () => { globalThis.fetch = original; },
    writes: (table: string) => requests.filter((item) => item.table === table && item.method !== "GET"),
  };
}

export interface HarnessInput {
  reviewed: Row;
  rules: Row[];
  documents?: { document_type: string; status: string; scan_status: string | null }[];
  insurers?: { id: string; name: string; active: boolean }[];
  extractionConfidence?: number | null;
  reviewedAt?: string;
  /** Extra seeded rows, e.g. a previously completed job for cache tests. */
  extraTables?: Record<string, Row[]>;
}

export function buildTables(input: HarnessInput): Record<string, Row[]> {
  return {
    atlas_extractions: [{
      id: EXT, submission_id: SUB, extracted_json: {}, reviewed_json: input.reviewed,
      reviewed_at: input.reviewedAt ?? "2026-10-16T08:00:00.000Z",
      extraction_confidence: input.extractionConfidence === undefined ? 0.9 : input.extractionConfidence,
      // The endpoint selects `overall_confidence:extraction_confidence`; PostgREST
      // returns the alias, so the stub must too or the matcher silently falls back
      // to the 0.7 legacy default.
      overall_confidence: input.extractionConfidence === undefined ? 0.9 : input.extractionConfidence,
    }],
    atlas_documents: (input.documents ?? []).map((doc) => ({ submission_id: SUB, ...doc })),
    atlas_insurer_appetite: input.rules,
    atlas_insurers: input.insurers ?? [],
    atlas_jobs: [{
      id: JOB, status: "running", cancellation_requested: false, retry_count: 0,
      max_retries: 2, job_type: "recommendation", submission_id: SUB,
    }],
    ...(input.extraTables ?? {}),
  };
}

export function forcedRequest(): Request {
  return new Request("https://atlas.test/api/recommend", {
    method: "POST",
    body: JSON.stringify({ force: true, background_job_id: JOB }),
  });
}

export function unforcedRequest(): Request {
  return new Request("https://atlas.test/api/recommend", { method: "POST", body: JSON.stringify({}) });
}

export interface HarnessRun {
  status: number;
  body: Row;
  /** The single atlas_recommendations row the endpoint inserted, if any. */
  row: Row | null;
  requests: Recorded[];
  writes: (table: string) => Recorded[];
}

export async function runThroughHandler(
  input: HarnessInput,
  options: { request?: Request } = {}
): Promise<HarnessRun> {
  const stub = installRestStub(buildTables(input));
  try {
    const res = await handleRunRecommendation(SUB, options.request ?? forcedRequest(), env(), MANAGER);
    const body = (await res.json()) as Row;
    const inserts = stub.writes("atlas_recommendations");
    return {
      status: res.status,
      body,
      row: inserts.length === 1 ? (inserts[0].body as Row) : null,
      requests: stub.requests,
      writes: stub.writes,
    };
  } finally {
    stub.restore();
  }
}

/** GET the way the API does, from a persisted row. */
export async function getThroughHandler(row: Row): Promise<Row> {
  const stub = installRestStub({ atlas_recommendations: [row] }, { projectSelect: true });
  try {
    const res = await handleGetRecommendation(SUB, env(), MANAGER);
    const body = (await res.json()) as { recommendation: Row };
    return body.recommendation;
  } finally {
    stub.restore();
  }
}

// ---------------------------------------------------------------------------
// Reviewed-extraction builder for synthetic fixtures
// ---------------------------------------------------------------------------

export function reviewedField(value: unknown, confidence: number | null = 0.9): Row {
  return {
    value,
    status: value === null ? "not_found" : "extracted",
    confidence,
    confidence_source: confidence === null ? "unavailable" : "provider",
  };
}
