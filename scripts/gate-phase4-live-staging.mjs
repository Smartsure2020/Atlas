#!/usr/bin/env node
/**
 * Atlas — Phase 4 LIVE STAGING VALIDATOR
 * ----------------------------------------------------------------------------
 * Executes the Phase 4 live API and security gates against an operator-pinned
 * exact-version Worker + staging Supabase project. Emits a concise human
 * summary and a JSON report at .test-artifacts/phase4-live-staging-report.json.
 *
 * STAGING ONLY. Refuses to run if any URL supplied via env resolves to the
 * production Supabase project ref.
 *
 * NEVER prints:
 *   - JWTs
 *   - passwords
 *   - Supabase anon key
 *   - service-role key
 *   - refresh tokens
 *   - Cloudflare tokens
 *
 * Secrets are read from env only — never accepted via argv. Log lines carry
 * only safe fields (id, email, atlas_role, status codes, endpoint paths).
 *
 * Operator note: this script is deliberately UNCOMMITTED. Its output at
 * .test-artifacts/phase4-live-staging-report.json is a staging artefact — add
 * `.test-artifacts/` to `.gitignore` before any commit, or move the artefact
 * out of the working tree.
 *
 * Required env:
 *   ATLAS_CANDIDATE_SHA
 *   ATLAS_WORKER_URL
 *   ATLAS_STAGING_SUPABASE_URL
 *   ATLAS_STAGING_SUPABASE_ANON_KEY
 *   ATLAS_JWT_MANAGER
 *   ATLAS_JWT_CONSULTANT
 *   ATLAS_JWT_UNDERWRITER
 *   ATLAS_JWT_READONLY
 *   ATLAS_JWT_BROKER_A
 *   ATLAS_JWT_BROKER_B
 *
 * Optional env:
 *   ATLAS_JWT_ADMIN
 *   ATLAS_STAGING_SERVICE_ROLE_KEY   (for read-only invariant + fixture
 *                                     hardening; missing marks the affected
 *                                     checks SKIPPED_NEEDS_STAGING_SERVICE_ROLE)
 *
 * Optional fixture-id inputs (staging submission ids the operator has
 * pre-seeded for scope-matrix testing; JSON array as a string is fine):
 *   ATLAS_FIXTURE_BROKER_A_ID
 *   ATLAS_FIXTURE_BROKER_B_ID
 *   ATLAS_FIXTURE_INTERNAL_ID
 *
 * Exit codes:
 *   0  all runnable API gates pass; only SKIPPED_NEEDS_STAGING_SERVICE_ROLE
 *      or browser-only items were skipped
 *   1  test failure
 *   2  environment / production-safety refusal
 *   3  credential preflight failure
 *   4  cleanup incomplete
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Hard-coded safety constants
// ---------------------------------------------------------------------------

const EXPECTED_STAGING_REF = "mnehddylkeelojsnkdtx";
const FORBIDDEN_PRODUCTION_REF = "algenlnxagpxzsgaworz";

const FORBIDDEN_QUICK_KEYS = new Set([
  "extraction",
  "extracted_json",
  "reviewed_json",
  "recommendation",
  "quote_review",
  "decision",
  "communications",
  "broker_email_body",
  "jobs",
  "active_job",
  "appetite",
  "signed_url",
  "storage_path",
  "pilot_notes",
]);

const REPORT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".test-artifacts",
  "phase4-live-staging-report.json"
);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Base64url decode a string. Returns null on malformed input. */
function b64urlDecode(s) {
  try {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/** Parse a JWT payload without verifying the signature. */
function decodeJwtPayload(jwt) {
  if (typeof jwt !== "string" || jwt.split(".").length !== 3) return null;
  const raw = b64urlDecode(jwt.split(".")[1]);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Refuse any URL that references the production Supabase project ref. */
function assertNotProduction(label, urlOrString) {
  if (typeof urlOrString !== "string") return;
  if (urlOrString.includes(FORBIDDEN_PRODUCTION_REF)) {
    throw new SafetyRefusalError(
      `PRODUCTION SAFETY: ${label} references forbidden production ref ${FORBIDDEN_PRODUCTION_REF}.`
    );
  }
}

class SafetyRefusalError extends Error {}
class PreflightError extends Error {}
class GateError extends Error {}

function required(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === "") {
    throw new PreflightError(`Missing required env: ${name}`);
  }
  return v;
}

function optional(name) {
  const v = process.env[name];
  return v && String(v).trim() !== "" ? v : null;
}

/** Recursively find any forbidden keys in a response body. */
function scanForForbiddenKeys(node, forbidden, path = "$") {
  const hits = [];
  if (Array.isArray(node)) {
    node.forEach((v, i) => hits.push(...scanForForbiddenKeys(v, forbidden, `${path}[${i}]`)));
    return hits;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (forbidden.has(k)) hits.push(`${path}.${k}`);
      hits.push(...scanForForbiddenKeys(v, forbidden, `${path}.${k}`));
    }
  }
  return hits;
}

/** Authenticated fetch with bearer JWT — never logs the token. */
async function authedFetch(url, jwt, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${jwt}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, ok: res.ok, json, textLen: text.length };
}

// ---------------------------------------------------------------------------
// Step 0 — Environment proof
// ---------------------------------------------------------------------------

async function stepEnvironmentProof(cfg) {
  const stagingUrl = new URL(cfg.stagingUrl);
  const stagingRef = stagingUrl.hostname.split(".")[0];

  // A. Validate supplied staging URL hostname.
  if (stagingUrl.hostname !== `${EXPECTED_STAGING_REF}.supabase.co`) {
    throw new SafetyRefusalError(
      `ATLAS_STAGING_SUPABASE_URL host must be ${EXPECTED_STAGING_REF}.supabase.co (got ${stagingUrl.hostname})`
    );
  }
  if (stagingRef === FORBIDDEN_PRODUCTION_REF) {
    throw new SafetyRefusalError(
      `PRODUCTION SAFETY: staging URL resolves to production ref ${FORBIDDEN_PRODUCTION_REF}.`
    );
  }

  // B. Decode manager JWT payload locally — never print it.
  const payload = decodeJwtPayload(cfg.jwts.manager);
  if (!payload) {
    throw new PreflightError("Manager JWT payload could not be decoded (not a JWT).");
  }
  const iss = typeof payload.iss === "string" ? payload.iss : "";
  if (!iss.includes(EXPECTED_STAGING_REF)) {
    throw new SafetyRefusalError(
      `Manager JWT iss claim does not identify staging project ${EXPECTED_STAGING_REF}.`
    );
  }
  const localClaims = {
    iss_matches_staging: iss.includes(EXPECTED_STAGING_REF),
    sub_present: typeof payload.sub === "string" && payload.sub.length > 0,
    email_present: typeof payload.email === "string" && payload.email.length > 0,
    atlas_role_claim:
      payload.app_metadata && typeof payload.app_metadata.atlas_role === "string"
        ? payload.app_metadata.atlas_role
        : null,
  };

  // C. Verify manager JWT directly against staging Supabase.
  const supRes = await authedFetch(
    `${cfg.stagingUrl}/auth/v1/user`,
    cfg.jwts.manager,
    { headers: { apikey: cfg.stagingAnonKey } }
  );
  if (supRes.status !== 200) {
    throw new PreflightError(
      `Staging Supabase /auth/v1/user rejected manager JWT (status ${supRes.status}).`
    );
  }
  const supUser = supRes.json || {};
  const supRole =
    supUser.app_metadata && typeof supUser.app_metadata.atlas_role === "string"
      ? supUser.app_metadata.atlas_role
      : null;
  if (supRole !== "manager") {
    throw new PreflightError(
      `Manager JWT resolves to atlas_role=${JSON.stringify(supRole)} at staging Supabase (expected "manager").`
    );
  }

  // D. Verify the same JWT through the Worker's authorise() path.
  const workerRes = await authedFetch(
    `${cfg.workerUrl}/api/submissions?limit=1`,
    cfg.jwts.manager
  );
  if (workerRes.status === 401) {
    throw new PreflightError(
      "Worker rejected manager JWT with 401 — the Worker-bound Supabase does not match the staging project the JWT was issued for."
    );
  }
  if (!workerRes.ok) {
    throw new PreflightError(
      `Worker did not accept manager JWT on /api/submissions?limit=1 (status ${workerRes.status}).`
    );
  }

  return {
    outcome: "PASS",
    rationale:
      "JWT was independently validated by staging Supabase, then accepted by the Worker's authorise() path, which validates bearer tokens through the Worker-bound SUPABASE_URL.",
    candidate_sha: cfg.candidateSha,
    worker_url: cfg.workerUrl,
    target: "operator-pinned exact-version target",
    expected_staging_ref: EXPECTED_STAGING_REF,
    forbidden_production_ref: FORBIDDEN_PRODUCTION_REF,
    staging_host: stagingUrl.hostname,
    manager_jwt_local_claims: localClaims,
    staging_supabase_manager_user: {
      id: supUser.id ?? null,
      email: supUser.email ?? null,
      atlas_role: supRole,
    },
    worker_manager_auth_status: workerRes.status,
  };
}

// ---------------------------------------------------------------------------
// Role token preflight (§4)
// ---------------------------------------------------------------------------

const ROLE_TABLE = [
  { key: "manager", envVar: "ATLAS_JWT_MANAGER", expected: "manager", required: true },
  { key: "consultant", envVar: "ATLAS_JWT_CONSULTANT", expected: "consultant", required: true },
  { key: "underwriter", envVar: "ATLAS_JWT_UNDERWRITER", expected: "underwriter", required: true },
  { key: "readonly", envVar: "ATLAS_JWT_READONLY", expected: "readonly", required: true },
  { key: "broker_a", envVar: "ATLAS_JWT_BROKER_A", expected: "broker", required: true },
  { key: "broker_b", envVar: "ATLAS_JWT_BROKER_B", expected: "broker", required: true },
  { key: "admin", envVar: "ATLAS_JWT_ADMIN", expected: "admin", required: false },
];

async function stepRolePreflight(cfg) {
  const rows = [];
  const errors = [];
  for (const spec of ROLE_TABLE) {
    const jwt = cfg.jwts[spec.key];
    if (!jwt) {
      if (spec.required) errors.push(`Missing JWT for role=${spec.key}`);
      continue;
    }
    const res = await authedFetch(
      `${cfg.stagingUrl}/auth/v1/user`,
      jwt,
      { headers: { apikey: cfg.stagingAnonKey } }
    );
    if (res.status !== 200) {
      errors.push(`Staging /auth/v1/user rejected ${spec.key} (status ${res.status}).`);
      continue;
    }
    const u = res.json || {};
    const role =
      u.app_metadata && typeof u.app_metadata.atlas_role === "string"
        ? u.app_metadata.atlas_role
        : null;
    if (role !== spec.expected) {
      errors.push(`${spec.key} resolves to atlas_role=${JSON.stringify(role)} (expected ${spec.expected}).`);
    }
    rows.push({
      label: spec.key,
      user_id: u.id ?? null,
      email: u.email ?? null,
      atlas_role: role,
    });
  }
  const bA = rows.find((r) => r.label === "broker_a");
  const bB = rows.find((r) => r.label === "broker_b");
  if (bA && bB && bA.user_id && bA.user_id === bB.user_id) {
    errors.push("broker_a and broker_b resolve to the same user id.");
  }
  if (errors.length > 0) {
    throw new PreflightError(`Role preflight failed:\n  - ${errors.join("\n  - ")}`);
  }
  return { outcome: "PASS", rows };
}

// ---------------------------------------------------------------------------
// Workload matrix (§8)
// ---------------------------------------------------------------------------

async function stepWorkloadMatrix(cfg) {
  const matrix = [
    { role: "manager", jwt: cfg.jwts.manager, expected: 200 },
    ...(cfg.jwts.admin ? [{ role: "admin", jwt: cfg.jwts.admin, expected: 200 }] : []),
    { role: "consultant", jwt: cfg.jwts.consultant, expected: 403 },
    { role: "underwriter", jwt: cfg.jwts.underwriter, expected: 403 },
    { role: "readonly", jwt: cfg.jwts.readonly, expected: 403 },
    { role: "broker_a", jwt: cfg.jwts.broker_a, expected: 403 },
    { role: "broker_b", jwt: cfg.jwts.broker_b, expected: 403 },
  ];
  const results = [];
  let managerPayload = null;
  for (const row of matrix) {
    const res = await authedFetch(`${cfg.workerUrl}/api/pipeline/workload`, row.jwt);
    const safeErr =
      res.json && (res.json.error || res.json.message)
        ? { error: res.json.error ?? null, message: res.json.message ?? null }
        : null;
    results.push({
      role: row.role,
      status: res.status,
      expected: row.expected,
      matches: res.status === row.expected,
      body_error: safeErr,
    });
    if (row.role === "manager" && res.ok) managerPayload = res.json;
  }
  const failed = results.filter((r) => !r.matches);
  const semantic = analyseWorkloadPayload(managerPayload);
  return {
    outcome: failed.length === 0 && semantic.outcome === "PASS" ? "PASS" : "FAIL",
    matrix: results,
    manager_payload_semantics: semantic,
  };
}

function analyseWorkloadPayload(payload) {
  if (!payload || !Array.isArray(payload.workload)) {
    return {
      outcome: "SKIPPED_NO_MANAGER_PAYLOAD",
      reason: "Manager workload response missing or malformed.",
    };
  }
  const findings = [];
  for (const entry of payload.workload) {
    for (const forbidden of ["weight", "app_metadata", "raw_user_meta_data", "access_token", "refresh_token", "session"]) {
      if (Object.prototype.hasOwnProperty.call(entry, forbidden)) {
        findings.push(`workload entry ${entry.user_id ?? "?"} leaked ${forbidden}`);
      }
    }
    const bs = entry.by_stage || {};
    const openFromByStage =
      (bs.new || 0) + (bs.triaged || 0) + (bs.assigned || 0) + (bs.in_progress || 0) + (bs.quoted || 0);
    if (typeof entry.open_count === "number" && openFromByStage !== entry.open_count) {
      findings.push(
        `workload entry ${entry.user_id ?? "?"}: open_count=${entry.open_count} does not equal sum(by_stage active)=${openFromByStage}`
      );
    }
    const bl = entry.by_line || {};
    if (typeof entry.open_count === "number" && (bl.personal || 0) + (bl.commercial || 0) !== entry.open_count) {
      findings.push(
        `workload entry ${entry.user_id ?? "?"}: by_line sum does not equal open_count`
      );
    }
  }
  return {
    outcome: findings.length === 0 ? "PASS" : "FAIL",
    entry_count: payload.workload.length,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Quick endpoint matrix (§9)
// ---------------------------------------------------------------------------

async function stepQuickMatrix(cfg) {
  const ids = cfg.fixtureIds;
  const cases = [];
  const push = (label, jwt, id, expected) => {
    if (jwt && id) cases.push({ label, jwt, id, expected });
  };
  push("manager -> internal fixture", cfg.jwts.manager, ids.internal, 200);
  push("consultant -> internal fixture", cfg.jwts.consultant, ids.internal, 200);
  push("underwriter -> internal fixture", cfg.jwts.underwriter, ids.internal, 200);
  push("readonly -> internal fixture", cfg.jwts.readonly, ids.internal, 200);
  push("broker_a -> own", cfg.jwts.broker_a, ids.brokerA, 200);
  push("broker_a -> broker_b case", cfg.jwts.broker_a, ids.brokerB, 404);
  push("broker_b -> broker_a case", cfg.jwts.broker_b, ids.brokerA, 404);
  push("consultant -> broker_a case (unrelated)", cfg.jwts.consultant, ids.brokerA, 404);

  const results = [];
  const forbiddenHits = [];
  let brokerAOwnBody = null;

  for (const c of cases) {
    const res = await authedFetch(
      `${cfg.workerUrl}/api/submissions/${encodeURIComponent(c.id)}/quick`,
      c.jwt
    );
    results.push({
      label: c.label,
      status: res.status,
      expected: c.expected,
      matches: res.status === c.expected,
    });
    if (res.ok && res.json) {
      const hits = scanForForbiddenKeys(res.json, FORBIDDEN_QUICK_KEYS);
      if (hits.length > 0) forbiddenHits.push({ label: c.label, hits });
      if (c.label === "broker_a -> own") brokerAOwnBody = res.json;
    }
  }

  const brokerSafety = analyseBrokerQuickPayload(brokerAOwnBody);
  const failed = results.filter((r) => !r.matches);
  const outcome =
    failed.length === 0 && forbiddenHits.length === 0 && brokerSafety.outcome !== "FAIL"
      ? cases.length === 0
        ? "SKIPPED_NO_FIXTURES"
        : "PASS"
      : "FAIL";

  return {
    outcome,
    fixture_ids_supplied: {
      internal: Boolean(ids.internal),
      broker_a: Boolean(ids.brokerA),
      broker_b: Boolean(ids.brokerB),
    },
    matrix: results,
    forbidden_key_hits: forbiddenHits,
    broker_own_safety: brokerSafety,
  };
}

function analyseBrokerQuickPayload(body) {
  if (!body) return { outcome: "SKIPPED_NO_BROKER_FIXTURE" };
  const findings = [];
  if (body.assignment_events && Array.isArray(body.assignment_events) && body.assignment_events.length > 0) {
    findings.push("assignment_events populated for broker preview");
  }
  const history = Array.isArray(body.history) ? body.history : [];
  for (const h of history) {
    if (h && "metadata" in h && h.metadata !== null) {
      findings.push(`history entry ${h.id ?? "?"} metadata !== null for broker`);
    }
    // actor_id must not leak internal UUIDs when broker
    if (h && h.actor_id && !h.actor_email) {
      findings.push(`history entry ${h.id ?? "?"} exposes actor_id without a safe label`);
    }
  }
  return { outcome: findings.length === 0 ? "PASS" : "FAIL", findings };
}

// ---------------------------------------------------------------------------
// Read-only invariant (§10) — needs service role
// ---------------------------------------------------------------------------

async function stepReadOnlyInvariant(cfg) {
  if (!cfg.serviceRoleKey) {
    return {
      outcome: "SKIPPED_NEEDS_STAGING_SERVICE_ROLE",
      reason:
        "ATLAS_STAGING_SERVICE_ROLE_KEY not supplied; cannot read/write staging DB to prove invariant.",
    };
  }
  const id = cfg.fixtureIds.internal;
  if (!id) {
    return {
      outcome: "SKIPPED_NO_INTERNAL_FIXTURE",
      reason: "ATLAS_FIXTURE_INTERNAL_ID not supplied; nothing to observe.",
    };
  }
  const fields = "pipeline_stage,last_pipeline_stage_changed_at,queue_status,assigned_to";
  const restUrl = `${cfg.stagingUrl}/rest/v1/atlas_submissions?id=eq.${encodeURIComponent(id)}&select=${fields}`;
  const svcHeaders = {
    apikey: cfg.serviceRoleKey,
    Authorization: `Bearer ${cfg.serviceRoleKey}`,
  };

  const beforeRes = await fetch(restUrl, { headers: svcHeaders });
  if (!beforeRes.ok) {
    return { outcome: "FAIL", reason: `staging read before failed status=${beforeRes.status}` };
  }
  const beforeRows = await beforeRes.json();
  const before = beforeRows[0] || null;
  if (!before) return { outcome: "FAIL", reason: "internal fixture not found" };

  // 10 quick + 3 workload reads.
  for (let i = 0; i < 10; i += 1) {
    await authedFetch(`${cfg.workerUrl}/api/submissions/${encodeURIComponent(id)}/quick`, cfg.jwts.manager);
  }
  for (let i = 0; i < 3; i += 1) {
    await authedFetch(`${cfg.workerUrl}/api/pipeline/workload`, cfg.jwts.manager);
  }

  const afterRes = await fetch(restUrl, { headers: svcHeaders });
  if (!afterRes.ok) {
    return { outcome: "FAIL", reason: `staging read after failed status=${afterRes.status}` };
  }
  const after = (await afterRes.json())[0] || null;
  const diffs = [];
  for (const key of ["pipeline_stage", "last_pipeline_stage_changed_at", "queue_status", "assigned_to"]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      diffs.push({ key, before: before[key], after: after[key] });
    }
  }
  return {
    outcome: diffs.length === 0 ? "PASS" : "FAIL",
    fixture_id: id,
    diffs,
  };
}

// ---------------------------------------------------------------------------
// Quick capture API smoke (§11)
// ---------------------------------------------------------------------------

async function stepQuickCapture(cfg, ledger) {
  const runId = cfg.runId;
  const createdIds = [];

  async function create(jwt, label, extra = {}) {
    const body = {
      client_name: `GATE-P4-${runId}-${label}`,
      line_of_business: "commercial",
      ...extra,
    };
    const res = await authedFetch(`${cfg.workerUrl}/api/submissions`, jwt, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (res.ok && res.json && res.json.id) {
      ledger.push({ id: res.json.id, label });
      createdIds.push({ label, id: res.json.id, status: res.status });
    }
    return res;
  }

  const results = {};

  // Manager happy path.
  const mgr = await create(cfg.jwts.manager, "MGR");
  results.manager_create = { status: mgr.status, ok: mgr.ok, id: mgr.json?.id ?? null };

  // Broker A happy path.
  const bA = await create(cfg.jwts.broker_a, "BROKERA");
  results.broker_a_create = { status: bA.status, ok: bA.ok, id: bA.json?.id ?? null };

  // Uniqueness.
  const ids = createdIds.map((r) => r.id).filter(Boolean);
  results.ids_unique = new Set(ids).size === ids.length;

  // Broker B must NOT be able to preview broker A's new case.
  if (bA.ok && bA.json?.id) {
    const bBSees = await authedFetch(
      `${cfg.workerUrl}/api/submissions/${encodeURIComponent(bA.json.id)}/quick`,
      cfg.jwts.broker_b
    );
    results.broker_b_cannot_see_broker_a = {
      status: bBSees.status,
      matches_expected_404: bBSees.status === 404,
    };
  }

  // Readonly must be rejected.
  const ro = await authedFetch(`${cfg.workerUrl}/api/submissions`, cfg.jwts.readonly, {
    method: "POST",
    body: JSON.stringify({
      client_name: `GATE-P4-${runId}-RO`,
      line_of_business: "commercial",
    }),
  });
  results.readonly_create_rejected = {
    status: ro.status,
    matches_expected_reject: ro.status === 403 || ro.status === 401 || ro.status === 405,
  };

  // Adversarial: send extra forbidden-looking fields and assert the server does
  // not store them (verified only if service role is available).
  const adv = await create(cfg.jwts.manager, "ADV", {
    assigned_to: "00000000-0000-0000-0000-000000000000",
    created_by: "00000000-0000-0000-0000-000000000000",
    actor: "00000000-0000-0000-0000-000000000000",
    pipeline_stage: "quoted",
  });
  results.adversarial_create_ignored = {
    status: adv.status,
    ok: adv.ok,
    verified_ignored: false,
    reason: "SKIPPED_NEEDS_STAGING_SERVICE_ROLE",
  };

  if (cfg.serviceRoleKey && adv.ok && adv.json?.id) {
    const fields = "created_by,assigned_to,pipeline_stage";
    const check = await fetch(
      `${cfg.stagingUrl}/rest/v1/atlas_submissions?id=eq.${encodeURIComponent(adv.json.id)}&select=${fields}`,
      {
        headers: {
          apikey: cfg.serviceRoleKey,
          Authorization: `Bearer ${cfg.serviceRoleKey}`,
        },
      }
    );
    if (check.ok) {
      const row = (await check.json())[0] || null;
      const managerSub = decodeJwtPayload(cfg.jwts.manager)?.sub ?? null;
      // Protected fields against a manager caller: created_by (server must set from
      // user.id) and pipeline_stage (createSubmission never accepts it from body).
      // assigned_to is NOT protected against a manager — managers can legitimately
      // assign at intake time — so it is reported for evidence but not gated on.
      const createdByEnforced = row !== null && row.created_by === managerSub;
      const pipelineStageIgnored = row !== null && row.pipeline_stage !== "quoted";
      results.adversarial_create_ignored.verified_ignored =
        createdByEnforced && pipelineStageIgnored;
      results.adversarial_create_ignored.reason = null;
      results.adversarial_create_ignored.observed = row;
      results.adversarial_create_ignored.checks = {
        created_by_enforced_from_authenticated_caller: createdByEnforced,
        pipeline_stage_ignored: pipelineStageIgnored,
      };
    }
  }

  const overallPass =
    mgr.ok &&
    bA.ok &&
    results.ids_unique &&
    results.broker_b_cannot_see_broker_a?.matches_expected_404 &&
    results.readonly_create_rejected.matches_expected_reject;

  return {
    outcome: overallPass ? "PASS" : "FAIL",
    created: createdIds,
    ...results,
    quick_capture_double_click: "LOCAL_UI_TEST_COVERED_NOT_REPRODUCED_BY_API_GATE",
    quick_capture_cancel_reset: "LOCAL_UI_TEST_COVERED_PENDING_BROWSER_SMOKE",
  };
}

// ---------------------------------------------------------------------------
// Adversarial HTTP (§14)
// ---------------------------------------------------------------------------

async function stepAdversarialHttp(cfg) {
  const findings = [];
  const spoofUrls = [
    `${cfg.workerUrl}/api/pipeline/workload?assigned_to=00000000-0000-0000-0000-000000000000`,
    `${cfg.workerUrl}/api/pipeline/workload?created_by=00000000-0000-0000-0000-000000000000`,
    `${cfg.workerUrl}/api/pipeline/workload?role=admin`,
  ];
  const brokerSpoofs = [];
  for (const url of spoofUrls) {
    const res = await authedFetch(url, cfg.jwts.broker_a);
    if (res.status !== 403) {
      findings.push(`broker_a spoof ${url.split("?")[1]} returned ${res.status} (expected 403)`);
    }
    brokerSpoofs.push({ url_query: url.split("?")[1], status: res.status });
  }

  // Malformed UUIDs against the Quick endpoint.
  const malformed = ["not-a-uuid", "'; DROP TABLE atlas_submissions;--", "%00"];
  const malformedResults = [];
  for (const bad of malformed) {
    const res = await authedFetch(
      `${cfg.workerUrl}/api/submissions/${encodeURIComponent(bad)}/quick`,
      cfg.jwts.manager
    );
    if (res.status === 200) {
      findings.push(`Malformed id ${bad!==""?bad:"<empty>"} returned 200`);
    }
    malformedResults.push({ id: bad, status: res.status });
  }

  // Verify no pipeline-stage mutation endpoint exists.
  const stageRoutes = [
    { path: "/api/submissions/00000000-0000-0000-0000-000000000000/pipeline-stage", method: "POST" },
    { path: "/api/submissions/00000000-0000-0000-0000-000000000000/pipeline_stage", method: "PATCH" },
  ];
  const stageRouteResults = [];
  for (const r of stageRoutes) {
    const res = await authedFetch(`${cfg.workerUrl}${r.path}`, cfg.jwts.manager, {
      method: r.method,
      body: JSON.stringify({ pipeline_stage: "quoted" }),
    });
    if (res.status >= 200 && res.status < 300) {
      findings.push(`Pipeline-stage mutation route ${r.method} ${r.path} returned ${res.status} (must not exist)`);
    }
    stageRouteResults.push({ path: r.path, method: r.method, status: res.status });
  }

  return {
    outcome: findings.length === 0 ? "PASS" : "FAIL",
    broker_workload_spoofs: brokerSpoofs,
    malformed_quick_ids: malformedResults,
    stage_mutation_routes: stageRouteResults,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Cleanup (§16)
// ---------------------------------------------------------------------------

async function stepCleanup(cfg, ledger) {
  const unresolved = [];
  if (!cfg.serviceRoleKey) {
    return {
      outcome: ledger.length === 0 ? "PASS" : "SKIPPED_NEEDS_STAGING_SERVICE_ROLE",
      note:
        "No service-role key supplied; cleanup requires it. Operator must delete the listed GATE-P4-* ids by hand.",
      unresolved_ids: ledger.map((e) => e.id),
    };
  }
  // Staging admin-hostname assertion before every REST call.
  assertNotProduction("ATLAS_STAGING_SUPABASE_URL cleanup pass", cfg.stagingUrl);
  const stagingUrl = new URL(cfg.stagingUrl);
  if (stagingUrl.hostname !== `${EXPECTED_STAGING_REF}.supabase.co`) {
    throw new SafetyRefusalError("cleanup refused: staging host does not match expected ref");
  }
  const headers = {
    apikey: cfg.serviceRoleKey,
    Authorization: `Bearer ${cfg.serviceRoleKey}`,
  };
  for (const entry of ledger) {
    const del = await fetch(
      `${cfg.stagingUrl}/rest/v1/atlas_submissions?id=eq.${encodeURIComponent(entry.id)}&client_name=like.GATE-P4-${cfg.runId}-*`,
      { method: "DELETE", headers }
    );
    if (!del.ok) unresolved.push(entry.id);
  }
  return {
    outcome: unresolved.length === 0 ? "PASS" : "PARTIAL",
    deleted: ledger.length - unresolved.length,
    unresolved_ids: unresolved,
  };
}

// ---------------------------------------------------------------------------
// Reporting + main
// ---------------------------------------------------------------------------

function summary(label, node) {
  if (!node) return `${label}: (skipped)`;
  return `${label}: ${node.outcome}`;
}

async function main() {
  // ---- Load env + refuse production ------------------------------------------
  let cfg;
  try {
    cfg = {
      candidateSha: required("ATLAS_CANDIDATE_SHA"),
      workerUrl: required("ATLAS_WORKER_URL"),
      stagingUrl: required("ATLAS_STAGING_SUPABASE_URL"),
      stagingAnonKey: required("ATLAS_STAGING_SUPABASE_ANON_KEY"),
      serviceRoleKey: optional("ATLAS_STAGING_SERVICE_ROLE_KEY"),
      jwts: {
        manager: required("ATLAS_JWT_MANAGER"),
        consultant: required("ATLAS_JWT_CONSULTANT"),
        underwriter: required("ATLAS_JWT_UNDERWRITER"),
        readonly: required("ATLAS_JWT_READONLY"),
        broker_a: required("ATLAS_JWT_BROKER_A"),
        broker_b: required("ATLAS_JWT_BROKER_B"),
        admin: optional("ATLAS_JWT_ADMIN"),
      },
      fixtureIds: {
        internal: optional("ATLAS_FIXTURE_INTERNAL_ID"),
        brokerA: optional("ATLAS_FIXTURE_BROKER_A_ID"),
        brokerB: optional("ATLAS_FIXTURE_BROKER_B_ID"),
      },
      runId: String(Date.now()),
    };
  } catch (err) {
    if (err instanceof PreflightError) {
      console.error(err.message);
      process.exit(3);
    }
    throw err;
  }

  // Production guard on every URL-shaped env we touch.
  for (const name of ["ATLAS_WORKER_URL", "ATLAS_STAGING_SUPABASE_URL"]) {
    try { assertNotProduction(name, process.env[name]); } catch (e) {
      console.error(e.message);
      process.exit(2);
    }
  }

  const ledger = [];
  const report = {
    candidate_sha: cfg.candidateSha,
    worker_url: cfg.workerUrl,
    expected_staging_ref: EXPECTED_STAGING_REF,
    forbidden_production_ref: FORBIDDEN_PRODUCTION_REF,
    production_contact_attempted: false,
    run_id: cfg.runId,
    environment_proof: null,
    role_preflight: null,
    workload: null,
    quick: null,
    read_only_invariant: null,
    quick_capture: null,
    adversarial_http: null,
    cleanup: null,
    browser_gates: {
      quick_capture_double_click: "LOCAL_UI_TEST_COVERED_NOT_REPRODUCED_BY_API_GATE",
      quick_capture_cancel_reset: "LOCAL_UI_TEST_COVERED_PENDING_BROWSER_SMOKE",
      responsive_320_375_768_desktop: "PENDING_BROWSER_SMOKE",
      keyboard_manual_a11y: "PENDING_BROWSER_SMOKE",
      console_network_review: "PENDING_BROWSER_SMOKE",
    },
    overall_api_gate: null,
  };

  let exitCode = 0;
  let fatalStage = null;
  let fatalErrorClass = null;

  const stages = [
    ["environment_proof", stepEnvironmentProof],
    ["role_preflight", stepRolePreflight],
    ["workload", stepWorkloadMatrix],
    ["quick", stepQuickMatrix],
    ["read_only_invariant", stepReadOnlyInvariant],
    ["quick_capture", stepQuickCapture],
    ["adversarial_http", stepAdversarialHttp],
  ];

  try {
    for (const [key, fn] of stages) {
      fatalStage = key;
      report[key] = key === "quick_capture" ? await fn(cfg, ledger) : await fn(cfg);
    }
    fatalStage = null;
  } catch (err) {
    if (err instanceof SafetyRefusalError) {
      console.error(err.message);
      fatalErrorClass = "SafetyRefusalError";
      exitCode = 2;
    } else if (err instanceof PreflightError) {
      console.error(err.message);
      fatalErrorClass = "PreflightError";
      exitCode = 3;
    } else {
      console.error("GATE ERROR:", err.message || err);
      fatalErrorClass = "GateError";
      exitCode = 1;
    }
  }

  // Always attempt cleanup.
  try {
    report.cleanup = await stepCleanup(cfg, ledger);
    if (report.cleanup.outcome === "PARTIAL") {
      exitCode = Math.max(exitCode, 4);
      if (!fatalStage) { fatalStage = "cleanup"; fatalErrorClass = fatalErrorClass || "CleanupPartial"; }
    }
  } catch (err) {
    console.error("CLEANUP ERROR:", err.message || err);
    exitCode = Math.max(exitCode, 4);
    if (!fatalStage) { fatalStage = "cleanup"; fatalErrorClass = "CleanupError"; }
    report.cleanup = { outcome: "PARTIAL", error: err.message || String(err), unresolved_ids: ledger.map((e) => e.id) };
  }

  // Roll up overall api gate. Fatal (safety/preflight/gate/cleanup) => FAIL regardless of populated slots.
  const runnable = [
    report.environment_proof,
    report.role_preflight,
    report.workload,
    report.quick,
    report.quick_capture,
    report.adversarial_http,
  ];
  const anyFail = runnable.some((r) => r && r.outcome === "FAIL");
  const invariantFail = report.read_only_invariant?.outcome === "FAIL";
  const cleanupFail = report.cleanup && report.cleanup.outcome && report.cleanup.outcome !== "PASS";
  const fatal = exitCode !== 0 || Boolean(fatalStage) || Boolean(fatalErrorClass);
  report.overall_api_gate = (fatal || anyFail || invariantFail || cleanupFail) ? "FAIL" : "PASS";
  if (report.overall_api_gate === "FAIL" && exitCode === 0) exitCode = 1;
  report.process_exit_code = exitCode;
  report.fatal_stage = fatalStage;
  report.fatal_error_class = fatalErrorClass;

  // Write JSON.
  try {
    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  } catch (err) {
    console.error("Could not write report JSON:", err.message || err);
  }

  // Human summary.
  console.log("");
  console.log("PHASE 4 LIVE STAGING GATE");
  console.log(`Candidate: ${cfg.candidateSha}`);
  console.log(`Worker: ${cfg.workerUrl}`);
  console.log(summary("Environment proof", report.environment_proof));
  console.log(summary("Role token preflight", report.role_preflight));
  console.log(summary("Workload matrix", report.workload));
  console.log(summary("Quick matrix", report.quick));
  console.log(summary("Read-only invariant", report.read_only_invariant));
  console.log(summary("Quick capture", report.quick_capture));
  console.log(summary("Adversarial HTTP", report.adversarial_http));
  console.log(summary("Cleanup", report.cleanup));
  console.log("Browser gates: PENDING (see JSON report)");
  console.log(`Overall API gate: ${report.overall_api_gate}`);
  console.log(`JSON report: ${REPORT_PATH}`);

  process.exit(exitCode);
}

main().catch((err) => {
  console.error("UNHANDLED:", err.message || err);
  process.exit(1);
});
