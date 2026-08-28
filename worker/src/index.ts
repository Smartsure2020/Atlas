/**
 * Atlas Blueprint — Worker entry / router
 * ----------------------------------------------------------------------------
 * The single privileged API surface. Routes:
 *   GET  /auth/login                     -> redirect to Microsoft (shared Azure app)
 *   GET  /auth/callback                  -> exchange code, allow-list role, mint session
 *   GET  /api/health                     -> liveness
 *   GET  /api/submissions                -> list (dashboard)
 *   POST /api/submissions                -> create a submission
 *   GET  /api/submissions/:id            -> detail (submission + docs + extraction)
 *   POST /api/submissions/:id/extract    -> run extraction (MANAGER/admin only)
 *   POST /api/submissions/:id/review     -> save corrected summary -> reviewed_json
 *   POST /api/uploads/sign               -> signed upload URL into PRIVATE bucket
 *
 * Matching, recommendations, decisions and email drafts are later phases; their
 * routes slot in here behind the same authorise() gate.
 */

import { authorise, audit, adminClient, json, jsonError, type AtlasUser } from "./auth";
import { handleLogin, handleCallback, handleSignOut } from "./oauth";
import { handleExtract } from "./extract-endpoint";
import { handleGetSubmission, handleReview } from "./submission-endpoints";
import {
  handleRunRecommendation,
  handleGetRecommendation,
} from "./recommendation-endpoints";
import { handleRecordDecision, handleGetDecision } from "./decision-endpoints";
import { handleRunQuoteReview, handleGetQuoteReview } from "./quote-review-endpoints";
import {
  handleAddMissingInfo,
  handleGenerateMissingInfo,
  handleGeneratePhase4Draft,
  handleGetManagerStats,
  handleGetQuoteReviewHistory,
  handleListCommunications,
  handleListMissingInfo,
  handleSaveCommunication,
  handleUpdateCommunication,
  handleUpdateMissingInfo,
} from "./phase4-endpoints";
import { handleGenerateEmail, emailTypeFromPath } from "./email-endpoints";
import { handleGetAuditTimeline } from "./audit-endpoints";
import { retentionDays, type Env } from "./config";
import {
  MAX_CLIENT_UPLOAD_BYTES,
  logOperationError,
  roleCanCreateSubmission,
  roleCanUploadClientDocument,
  roleCanViewManagerDashboard,
  roleCanViewUnderwritingIntelligence,
  roleCanWrite,
  validateEnv,
  validateUploadInput,
} from "./phase6-hardening";
import { handleDevSignIn } from "./dev-sign-in";
import {
  handleListInsurers,
  handleCreateInsurer,
  handleGetInsurer,
  handleSignInsurerDoc,
  handleConfirmInsurerDoc,
  handleProcessInsurerDoc,
  handleEditAppetite,
  handleConfirmAppetite,
  handleDeactivateAppetite,
} from "./insurer-endpoints";
import { handleAddAppetiteRule } from "./manual-appetite";
import { handleEditInsurer } from "./insurer-edit";
import {
  handleCleanupPreview,
  handleListJobs,
  handleSystemStatus,
  handleUpdateAssignment,
} from "./phase7-endpoints";
import {
  handleAutoAssignSubmission,
  handleGetAssignmentHistory,
} from "./assignment-endpoints";
import {
  handleCanary,
  handleCancelJob,
  handleConfirmCleanupCandidate,
  handleListAlerts,
  handleListCleanupCandidates,
  handleRetryJob,
  handleUpdateAlert,
} from "./phase8-endpoints";
import {
  handleCreatePilotIssue,
  handleListPilotIssues,
  handleUpdatePilotFlag,
  handleUpdatePilotIssue,
} from "./pilot-endpoints";
import { buildHealthBody } from "./phase7-core";
import { emailsForUserIds } from "./user-directory";
import { runBackgroundMaintenance } from "./phase4-background";
import { beginJob } from "./phase7-jobs";
import { canAccessSubmission, canViewAllSubmissions, scopedSubmissionOr } from "./access-scope";
import { handleShadowQueueBatch, type ShadowQueueMessage } from "./shadow-queue";
import { runHybridExtraction } from "./hybrid-orchestrator";

// ---------------------------------------------------------------------------
// CORS — the Vite dev server (:5173) and the worker (:8787) are different
// origins in local dev. In production both sit on the same CF subdomain so
// these headers are harmless extras. Preflight (OPTIONS) must be answered
// before the browser will send the real request.
// ---------------------------------------------------------------------------

const LOCAL_DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

function corsHeaders(env: Env, requestOrigin?: string | null): Record<string, string> {
  const configuredOrigin = env.CORS_ORIGIN;
  const allowedOrigins = configuredOrigin && !LOCAL_DEV_ORIGINS.includes(configuredOrigin)
    ? [configuredOrigin]
    : LOCAL_DEV_ORIGINS;
  return {
    "Access-Control-Allow-Origin": requestOrigin && allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0],
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, apikey, x-client-info",
    "Access-Control-Max-Age": "86400",
  };
}

function withCors(res: Response, env: Env, requestOrigin?: string | null): Response {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(env, requestOrigin))) h.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

// Private bucket for transient client documents. Never public; access only via
// short-lived signed URLs minted server-side for authorised staff.
const CLIENT_DOCS_BUCKET = "atlas-client-docs";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env, request.headers.get("Origin")) });
    }
    return withCors(await route(request, env, ctx), env, request.headers.get("Origin"));
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runBackgroundMaintenance(env).catch((error) => {
      console.error("atlas_background_maintenance_failed", { error_name: (error as Error)?.name });
    }));
  },
  /**
   * Cloudflare Queue consumer entry for the shadow pipeline. Each message
   * carries only identifiers (see ShadowQueueMessage). The consumer holds
   * document processing responsibility — HTTP `waitUntil` no longer does.
   *
   * Never throws: handleShadowQueueBatch classifies each message's failure and
   * calls ack() or retry() on the individual message. A throw here would
   * retry the entire batch, so we swallow at the top level as a safety net.
   */
  async queue(batch: MessageBatch<ShadowQueueMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await handleShadowQueueBatch(batch, env, {
        buildAdmin: adminClient,
        runHybrid: runHybridExtraction,
      });
    } catch (err) {
      console.warn("atlas_shadow_queue_batch_failed", (err as Error)?.message?.slice(0, 120) ?? "unknown");
    }
  },
};

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  try {
      if (pathname === "/api/health") {
        return json(buildHealthBody());
      }

      const envProblems = validateEnv(env);
      if (envProblems.length > 0) {
        logOperationError({
          endpoint: pathname,
          operation: "environment_validation",
          code: "validation_failed",
          status: 503,
        });
        return jsonError("validation_failed", 503, "Atlas is not fully configured for this environment.", {
          detail: envProblems,
        });
      }
      // ---- Auth routes (no bearer token yet) ----
      if (pathname === "/auth/login" && request.method === "GET") {
        return handleLogin(request, env);
      }
      if (pathname === "/auth/callback" && request.method === "GET") {
        return handleCallback(request, env);
      }
      if (pathname === "/auth/sign-out" && request.method === "POST") {
        return handleSignOut(request, env);
      }
      if (pathname === "/dev/sign-in" && request.method === "GET") {
        return handleDevSignIn(request, env);
      }

      // ---- Everything below is staff-only. Authorise server-side. ----
      const user = await authorise(request, env);
      if (!user) return jsonError("permission_denied", 401, "Please sign in with an authorised Atlas account.");

      // Collection routes
      if (pathname === "/api/submissions" && request.method === "GET") {
        return listSubmissions(request, env, user);
      }
      if (pathname === "/api/submissions" && request.method === "POST") {
        if (!roleCanCreateSubmission(user.role)) return jsonError("permission_denied", 403, "Your role cannot create submissions.");
        return createSubmission(request, env, user);
      }
      if (pathname === "/api/uploads/sign" && request.method === "POST") {
        if (!roleCanUploadClientDocument(user.role)) return jsonError("permission_denied", 403, "Your role cannot upload documents.");
        return signUpload(request, env, user);
      }
      if (pathname === "/api/uploads/confirm" && request.method === "POST") {
        if (!roleCanUploadClientDocument(user.role)) return jsonError("permission_denied", 403, "Your role cannot confirm uploads.");
        return confirmUpload(request, env, user);
      }
      if (pathname === "/api/manager/stats" && request.method === "GET") {
        if (!roleCanViewManagerDashboard(user.role)) {
          return jsonError("permission_denied", 403, "Manager reporting is restricted to managers and admins.");
        }
        return handleGetManagerStats(request, env, user);
      }
      if (pathname === "/api/admin/system-status" && request.method === "GET") {
        return handleSystemStatus(env, user);
      }
      if (pathname === "/api/admin/jobs" && request.method === "GET") {
        return handleListJobs(env, user);
      }
      if (pathname === "/api/admin/alerts" && request.method === "GET") {
        return handleListAlerts(env, user);
      }
      if (pathname === "/api/admin/canary" && request.method === "GET") {
        return handleCanary(env, user);
      }
      if (pathname === "/api/admin/cleanup/preview" && request.method === "GET") {
        return handleCleanupPreview(env, user);
      }
      if (pathname === "/api/admin/cleanup/candidates" && request.method === "GET") {
        return handleListCleanupCandidates(env, user);
      }

      {
        const jm = pathname.match(/^\/api\/admin\/jobs\/([0-9a-fA-F-]{36})\/(retry|cancel)$/);
        if (jm && request.method === "POST") {
          return jm[2] === "retry"
            ? handleRetryJob(jm[1], env, user)
            : handleCancelJob(jm[1], env, user);
        }
      }

      {
        const am = pathname.match(/^\/api\/admin\/alerts\/([0-9a-fA-F-]{36})$/);
        if (am && request.method === "PATCH") {
          return handleUpdateAlert(am[1], request, env, user);
        }
      }

      {
        const cm = pathname.match(/^\/api\/admin\/cleanup\/candidates\/([0-9a-fA-F-]{36})$/);
        if (cm && request.method === "POST") {
          return handleConfirmCleanupCandidate(cm[1], request, env, user);
        }
      }

      // Item routes: /api/submissions/:id[/extract|/review|/emails/:type]
      const m = pathname.match(
        /^\/api\/submissions\/([0-9a-fA-F-]{36})(\/[a-z-]+(?:\/[a-z-]+)?)?$/
      );
      if (m) {
        const id = m[1];
        const sub = m[2];
        if (!(await canAccessSubmission(env, user, id))) {
          return jsonError("not_found", 404, "Submission not found.");
        }
        if (!sub && request.method === "GET") {
          return handleGetSubmission(id, env, user);
        }
        if (sub === "/extract" && request.method === "POST") {
          if (!roleCanWrite(user.role)) return jsonError("permission_denied", 403, "Readonly users cannot run extraction.");
          return handleExtract(id, request, env, user, ctx);
        }
        if (sub === "/review" && request.method === "POST") {
          if (!roleCanWrite(user.role)) return jsonError("permission_denied", 403, "Readonly users cannot save reviews.");
          return handleReview(id, request, env, user);
        }
        if (sub === "/assignment" && request.method === "PATCH") {
          // Broker is explicitly forbidden from assignment mutations even
          // for their own submission. roleCanWrite already excludes broker
          // but we surface an explicit broker check to survive future
          // refactors of the writer set.
          if (user.role === "broker") return jsonError("permission_denied", 403, "Brokers cannot change case assignment.");
          if (!roleCanWrite(user.role)) return jsonError("permission_denied", 403, "Readonly users cannot update assignments.");
          return handleUpdateAssignment(id, request, env, user);
        }
        if (sub === "/assignment/auto" && request.method === "POST") {
          if (user.role === "broker") return jsonError("permission_denied", 403, "Brokers cannot auto-assign.");
          if (!roleCanWrite(user.role)) return jsonError("permission_denied", 403, "Readonly users cannot auto-assign.");
          return handleAutoAssignSubmission(id, request, env, user);
        }
        if (sub === "/assignment-history" && request.method === "GET") {
          return handleGetAssignmentHistory(id, env, user);
        }
        if (sub === "/recommend" && request.method === "POST") {
          if (!roleCanViewUnderwritingIntelligence(user.role) || !roleCanWrite(user.role)) return jsonError("permission_denied", 403, "Your role cannot run recommendations.");
          return handleRunRecommendation(id, request, env, user);
        }
        if (sub === "/recommendation" && request.method === "GET") {
          if (!roleCanViewUnderwritingIntelligence(user.role)) return jsonError("permission_denied", 403, "Recommendation intelligence is not available for your role.");
          return handleGetRecommendation(id, env, user);
        }
        if (sub === "/quote-review" && request.method === "POST") {
          if (!roleCanViewUnderwritingIntelligence(user.role) || !roleCanWrite(user.role)) return jsonError("permission_denied", 403, "Your role cannot run quote reviews.");
          return handleRunQuoteReview(id, request, env, user);
        }
        if (sub === "/quote-review" && request.method === "GET") {
          if (!roleCanViewUnderwritingIntelligence(user.role)) return jsonError("permission_denied", 403, "Quote-review intelligence is not available for your role.");
          return handleGetQuoteReview(id, env, user);
        }
        if (sub === "/quote-review-history" && request.method === "GET") {
          if (!roleCanViewUnderwritingIntelligence(user.role)) return jsonError("permission_denied", 403, "Quote-review intelligence is not available for your role.");
          return handleGetQuoteReviewHistory(id, env, user);
        }
        if (sub === "/missing-info" && request.method === "GET") {
          return handleListMissingInfo(id, env, user);
        }
        if (sub === "/missing-info" && request.method === "POST") {
          if (!roleCanWrite(user.role)) return jsonError("permission_denied", 403, "Readonly users cannot add missing information items.");
          return handleAddMissingInfo(id, request, env, user);
        }
        if (sub === "/missing-info/generate" && request.method === "POST") {
          if (!roleCanWrite(user.role)) return jsonError("permission_denied", 403, "Readonly users cannot generate missing information items.");
          return handleGenerateMissingInfo(id, env, user);
        }
        if (sub === "/communications" && request.method === "GET") {
          if (!roleCanViewUnderwritingIntelligence(user.role)) return jsonError("permission_denied", 403, "Internal communications are not available for your role.");
          return handleListCommunications(id, env, user);
        }
        if (sub === "/communications" && request.method === "POST") {
          if (!roleCanWrite(user.role)) return jsonError("permission_denied", 403, "Readonly users cannot save communications.");
          return handleSaveCommunication(id, request, env, user);
        }
        if (sub === "/drafts/missing-info" && request.method === "POST") {
          if (!roleCanWrite(user.role)) return jsonError("permission_denied", 403, "Readonly users cannot generate drafts.");
          return handleGeneratePhase4Draft(id, "missing-info", request, env, user);
        }
        if (sub === "/drafts/referral-pack" && request.method === "POST") {
          if (!roleCanWrite(user.role)) return jsonError("permission_denied", 403, "Readonly users cannot generate drafts.");
          return handleGeneratePhase4Draft(id, "referral-pack", request, env, user);
        }
        if (sub === "/drafts/quote-summary" && request.method === "POST") {
          if (!roleCanWrite(user.role)) return jsonError("permission_denied", 403, "Readonly users cannot generate drafts.");
          return handleGeneratePhase4Draft(id, "quote-summary", request, env, user);
        }
        if (sub === "/decision" && request.method === "POST") {
          if (!roleCanWrite(user.role)) return jsonError("permission_denied", 403, "Readonly users cannot record decisions.");
          return handleRecordDecision(id, request, env, user);
        }
        if (sub === "/decision" && request.method === "GET") {
          if (!roleCanViewUnderwritingIntelligence(user.role)) return jsonError("permission_denied", 403, "Decision intelligence is not available for your role.");
          return handleGetDecision(id, env, user);
        }
        if (sub === "/audit" && request.method === "GET") {
          return handleGetAuditTimeline(id, env, user);
        }
        if (sub === "/pilot" && request.method === "PATCH") {
          if (user.role === "broker") return jsonError("permission_denied", 403, "Pilot controls are not available for your role.");
          return handleUpdatePilotFlag(id, request, env, user);
        }
        if (sub === "/pilot-issues" && request.method === "GET") {
          if (user.role === "broker") return jsonError("permission_denied", 403, "Pilot issues are not available for your role.");
          return handleListPilotIssues(id, env, user);
        }
        if (sub === "/pilot-issues" && request.method === "POST") {
          if (user.role === "broker") return jsonError("permission_denied", 403, "Pilot issues are not available for your role.");
          return handleCreatePilotIssue(id, request, env, user);
        }
        if (sub && sub.startsWith("/emails/") && request.method === "POST") {
          if (!roleCanWrite(user.role)) return jsonError("permission_denied", 403, "Readonly users cannot generate email drafts.");
          const emailType = emailTypeFromPath(sub.slice("/emails".length));
          if (!emailType) return json({ error: "unknown_email_type" }, 400);
          return handleGenerateEmail(id, emailType, env, user);
        }
      }

      // --- Insurers (Phase 2A) ---

      {
        const mm = pathname.match(/^\/api\/missing-info\/([0-9a-fA-F-]{36})$/);
        if (mm && request.method === "PATCH") {
          if (!roleCanWrite(user.role)) return jsonError("permission_denied", 403, "Readonly users cannot update missing information items.");
          return handleUpdateMissingInfo(mm[1], request, env, user);
        }
      }

      {
        const cm = pathname.match(/^\/api\/communications\/([0-9a-fA-F-]{36})$/);
        if (cm && request.method === "PATCH") {
          if (!roleCanWrite(user.role)) return jsonError("permission_denied", 403, "Readonly users cannot update communications.");
          return handleUpdateCommunication(cm[1], request, env, user);
        }
      }

      {
        const pm = pathname.match(/^\/api\/pilot-issues\/([0-9a-fA-F-]{36})$/);
        if (pm && request.method === "PATCH") {
          return handleUpdatePilotIssue(pm[1], request, env, user);
        }
      }

      if (pathname === "/api/insurers" && request.method === "GET") {
        if (!roleCanViewUnderwritingIntelligence(user.role)) return jsonError("permission_denied", 403, "Insurer intelligence is not available for your role.");
        return handleListInsurers(env, user);
      }
      if (pathname === "/api/insurers" && request.method === "POST") {
        if (!roleCanViewUnderwritingIntelligence(user.role)) return jsonError("permission_denied", 403, "Insurer intelligence is not available for your role.");
        return handleCreateInsurer(request, env, user);
      }

      // /api/insurers/:id        GET (detail)
      // /api/insurers/:id/documents/sign   POST (upload signed URL)
      {
        const im = pathname.match(
          /^\/api\/insurers\/([0-9a-fA-F-]{36})(\/documents\/sign|\/documents\/confirm|\/appetite)?$/
        );
        if (im) {
          const insurerId = im[1];
          const sub = im[2];
          if (!sub && request.method === "GET") {
            return handleGetInsurer(insurerId, env, user);
          }
          if (!sub && request.method === "PATCH") {
            return handleEditInsurer(insurerId, request, env, user);
          }
          if (sub === "/documents/sign" && request.method === "POST") {
            return handleSignInsurerDoc(insurerId, request, env, user);
          }
          if (sub === "/documents/confirm" && request.method === "POST") {
            return handleConfirmInsurerDoc(insurerId, request, env, user);
          }
          if (sub === "/appetite" && request.method === "POST") {
            return handleAddAppetiteRule(insurerId, request, env, user);
          }
        }
      }

      // /api/insurer-documents/:id/process   POST (run the AI ingestion)
      {
        const dm = pathname.match(
          /^\/api\/insurer-documents\/([0-9a-fA-F-]{36})\/process$/
        );
        if (dm && request.method === "POST") {
          return handleProcessInsurerDoc(dm[1], request, env, user);
        }
      }

      // /api/appetite/:id              PUT (edit)
      // /api/appetite/:id/confirm      POST (flip is_active=true)
      // /api/appetite/:id/deactivate   POST (flip is_active=false)
      {
        const am = pathname.match(
          /^\/api\/appetite\/([0-9a-fA-F-]{36})(\/[a-z]+)?$/
        );
        if (am) {
          const appetiteId = am[1];
          const sub = am[2];
          if (!sub && request.method === "PUT") {
            return handleEditAppetite(appetiteId, request, env, user);
          }
          if (sub === "/confirm" && request.method === "POST") {
            return handleConfirmAppetite(appetiteId, env, user);
          }
          if (sub === "/deactivate" && request.method === "POST") {
            return handleDeactivateAppetite(appetiteId, env, user);
          }
        }
      }

      return json({ error: "not_found" }, 404);
    } catch (err) {
      // Never leak internals or document contents into responses or logs.
      logOperationError({
        endpoint: pathname,
        operation: request.method,
        code: "internal_error",
        status: 500,
        errorName: (err as Error)?.name,
      });
      return jsonError("internal_error", 500, "Atlas hit an unexpected server error.");
    }
}

/** GET /api/submissions — list for the dashboard board. */
async function listSubmissions(
  request: Request,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  const admin = adminClient(env);
  const params = new URL(request.url).searchParams;
  const q = (params.get("q") ?? "").replace(/[,%()]/g, " ").trim().slice(0, 80);
  const status = params.get("status");
  const queueStatus = params.get("queue_status");
  const lineOfBusiness = params.get("line_of_business");
  const priority = params.get("priority");
  const pilotOnly = params.get("pilot") === "true";
  const sort = params.get("sort") === "oldest" ? "created_at" : "created_at";
  const ascending = params.get("sort") === "oldest";
  const baseColumns =
    "id, broker_name, client_name, request_type, status, assigned_underwriter, created_at, updated_at";
  const phase7Columns = `${baseColumns}, assigned_to, assigned_at, assigned_by, queue_status`;
  const phase1Columns = `${phase7Columns}, line_of_business, priority, next_action, due_at, pilot_flag`;
  // Phase 15 / migration 0023 adds the Quote Pipeline vocabulary. Present on
  // migrated databases; the fallback tiers below keep the dashboard usable
  // if a dev/local DB is behind on migrations.
  const phase15Columns =
    `${phase1Columns}, pipeline_stage, received_at, source_type, complexity, last_pipeline_stage_changed_at`;

  let query = admin
    .from("atlas_submissions")
    .select(phase15Columns);
  if (q) {
    query = query.or(
      `client_name.ilike.%${q}%,broker_name.ilike.%${q}%,request_type.ilike.%${q}%`
    );
  }
  if (status) query = query.eq("status", status);
  if (queueStatus) query = query.eq("queue_status", queueStatus);
  if (lineOfBusiness) query = query.eq("line_of_business", lineOfBusiness);
  if (priority) query = query.eq("priority", priority);
  if (pilotOnly) query = query.eq("pilot_flag", true);
  if (!canViewAllSubmissions(env, user)) query = query.or(scopedSubmissionOr(user));
  const { data, error } = await query.order(sort, { ascending }).limit(500);

  if (!error) return withAssigneeEmails(admin, data ?? [], user);

  // First fallback: migration 0023 not yet applied. Retry without the Phase 15
  // pipeline columns; synthesise them as null so the response shape stays
  // stable for the frontend.
  let phase1Query = admin
    .from("atlas_submissions")
    .select(phase1Columns);
  if (q) {
    phase1Query = phase1Query.or(
      `client_name.ilike.%${q}%,broker_name.ilike.%${q}%,request_type.ilike.%${q}%`
    );
  }
  if (status) phase1Query = phase1Query.eq("status", status);
  if (queueStatus) phase1Query = phase1Query.eq("queue_status", queueStatus);
  if (lineOfBusiness) phase1Query = phase1Query.eq("line_of_business", lineOfBusiness);
  if (priority) phase1Query = phase1Query.eq("priority", priority);
  if (pilotOnly) phase1Query = phase1Query.eq("pilot_flag", true);
  if (!canViewAllSubmissions(env, user)) phase1Query = phase1Query.or(scopedSubmissionOr(user));
  const { data: phase1Data, error: phase1Error } = await phase1Query
    .order(sort, { ascending })
    .limit(500);

  if (!phase1Error) {
    return withAssigneeEmails(
      admin,
      (phase1Data ?? []).map((row: Record<string, unknown>) => ({
        ...row,
        pipeline_stage: null,
        received_at: null,
        source_type: null,
        complexity: null,
        last_pipeline_stage_changed_at: null,
      })),
      user
    );
  }

  // Local/dev databases may not have Phase 7 assignment columns until migration
  // 0013 is applied. Keep the shared queue usable and return null assignment
  // fields rather than failing the whole dashboard.
  let fallbackQuery = admin
    .from("atlas_submissions")
    .select(phase7Columns);
  if (q) {
    fallbackQuery = fallbackQuery.or(
      `client_name.ilike.%${q}%,broker_name.ilike.%${q}%,request_type.ilike.%${q}%`
    );
  }
  if (status) fallbackQuery = fallbackQuery.eq("status", status);
  if (queueStatus) fallbackQuery = fallbackQuery.eq("queue_status", queueStatus);
  if (priority) fallbackQuery = fallbackQuery.eq("priority", priority);
  if (!canViewAllSubmissions(env, user)) fallbackQuery = fallbackQuery.or(scopedSubmissionOr(user));
  const { data: fallback, error: fallbackError } = await fallbackQuery
    .order(sort, { ascending })
    .limit(500);

  if (fallbackError) return json({ error: "list_failed" }, 500);
  return withAssigneeEmails(admin, (fallback ?? []).map((row: Record<string, unknown>) => ({
      ...row,
      assigned_to: row.assigned_underwriter ?? null,
      assigned_at: null,
      assigned_by: null,
      queue_status: row.status ?? null,
      line_of_business: null,
      priority: "normal",
      next_action: row.status === "new" ? "Review intake" : null,
      due_at: null,
      pipeline_stage: null,
      received_at: null,
      source_type: null,
      complexity: null,
      last_pipeline_stage_changed_at: null,
    })), user);
}

async function withAssigneeEmails(
  admin: ReturnType<typeof adminClient>,
  rows: unknown[],
  user: AtlasUser
): Promise<Response> {
  const typedRows = rows as Record<string, unknown>[];
  const ids = typedRows
    .map((row) => row.assigned_to ?? row.assigned_underwriter)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const submissionIds = typedRows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string");

  // Phase 3: broker MUST NOT see the internal underwriting processing state
  // (job_type, progress_percent, current_step, cancellation_requested) — that
  // leaks whether extraction / recommendation / quote-review / any internal
  // job is in flight and how far along it is. Skip the join entirely and
  // return active_job: null uniformly for every row.
  const isBroker = user.role === "broker";

  const [emails, activeJobs] = await Promise.all([
    emailsForUserIds(admin, ids),
    !isBroker && submissionIds.length > 0
      ? admin
          .from("atlas_jobs")
          .select("submission_id, job_type, status, progress_percent, current_step, cancellation_requested")
          .in("submission_id", submissionIds)
          .in("status", ["queued", "running"])
          .then((r) => r.data ?? [])
      : Promise.resolve([]),
  ]);

  type ActiveJob = { submission_id: string; job_type: string; status: string; progress_percent: number | null; current_step: string | null; cancellation_requested: boolean | null };
  const jobsBySubmission = new Map<string, ActiveJob>();
  for (const job of activeJobs as ActiveJob[]) {
    if (!jobsBySubmission.has(job.submission_id)) {
      jobsBySubmission.set(job.submission_id, job);
    }
  }

  return json({
    ok: true,
    submissions: typedRows.map((row) => {
      const activeJob = isBroker ? undefined : jobsBySubmission.get(row.id as string);
      return {
        ...row,
        assigned_to_email:
          typeof row.assigned_to === "string"
            ? emails.get(row.assigned_to) ?? null
            : typeof row.assigned_underwriter === "string"
            ? emails.get(row.assigned_underwriter) ?? null
            : null,
        active_job: activeJob
          ? { job_type: activeJob.job_type, status: activeJob.status, progress_percent: activeJob.progress_percent, current_step: activeJob.current_step, cancellation_requested: !!activeJob.cancellation_requested }
          : null,
      };
    }),
  });
}

/** POST /api/submissions — create a new intake. */
async function createSubmission(
  request: Request,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    broker_name?: string;
    broker_email?: string;
    client_name?: string;
    request_type?: string;
    broker_email_body?: string;
    line_of_business?: "personal" | "commercial";
    assigned_underwriter?: string | null;
    assigned_to?: string | null;
  } | null;
  if (!body) return json({ error: "bad_request" }, 400);

  const isBroker = user.role === "broker";

  // Phase 3: brokers must never inject assignment on creation. Reject a
  // non-null assignment field explicitly rather than silently dropping it,
  // so a mis-configured client fails loud in review. NULLs are fine.
  if (isBroker && (body.assigned_to != null || body.assigned_underwriter != null)) {
    return jsonError("permission_denied", 403, "Brokers cannot set assignment on new submissions.");
  }

  // Broker identity is the authenticated user. Prefer user.email over a
  // supplied broker_email so a spoofed identifier can't reach the audit
  // trail. broker_name may be supplied by the broker (their own display
  // name in this session).
  const brokerEmail = isBroker ? (user.email ?? body.broker_email ?? null) : (body.broker_email ?? null);
  const admin = adminClient(env);
  const insertRow = {
    broker_name: body.broker_name ?? null,
    broker_email: brokerEmail,
    client_name: body.client_name ?? null,
    request_type: body.request_type ?? null,
    broker_email_body: body.broker_email_body ?? null,
    line_of_business: body.line_of_business ?? null,
    priority: "normal",
    next_action: "Review intake",
    // Broker path always enters with null assignment fields, regardless of
    // future body drift. Internal-role compatibility preserved unchanged.
    assigned_underwriter: isBroker ? null : (body.assigned_underwriter ?? null),
    assigned_to: isBroker ? null : (body.assigned_to ?? body.assigned_underwriter ?? null),
    assigned_at: isBroker
      ? null
      : (body.assigned_to || body.assigned_underwriter ? new Date().toISOString() : null),
    assigned_by: isBroker
      ? null
      : (body.assigned_to || body.assigned_underwriter ? user.id : null),
    queue_status: "new",
    created_by: user.id,
    status: "new",
  };

  const { data, error } = await admin
    .from("atlas_submissions")
    .insert(insertRow)
    .select("id")
    .single();

  let created: { id: string } | null = data ? { id: data.id } : null;
  if (error || !data) {
    const {
      assigned_to: _assignedTo,
      assigned_at: _assignedAt,
      assigned_by: _assignedBy,
      queue_status: _queueStatus,
      line_of_business: _lineOfBusiness,
      priority: _priority,
      next_action: _nextAction,
      ...legacyInsertRow
    } = insertRow;
    const { data: fallback, error: fallbackError } = await admin
      .from("atlas_submissions")
      .insert(legacyInsertRow)
      .select("id")
      .single();
    if (fallbackError || !fallback) return json({ error: "create_failed" }, 500);
    created = { id: fallback.id };
  }
  if (!created) return json({ error: "create_failed" }, 500);

  await audit(env, {
    submissionId: created.id,
    action: "submission_created",
    actorId: user.id,
    // IDs/flags only — no broker email body, no client PII.
    metadata: { has_pasted_email: Boolean(body.broker_email_body) },
  });

  return json({ ok: true, id: created.id }, 201);
}

/**
 * POST /api/uploads/sign — mint a short-lived signed upload URL into the
 * PRIVATE client-docs bucket and pre-create the (transient) document row with
 * its retention window set. The file itself uploads directly to storage via the
 * signed URL; the Worker never proxies document bytes it doesn't need to.
 */
async function signUpload(
  request: Request,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    submission_id?: string;
    file_name?: string;
    content_type?: string;
    size_bytes?: number;
    file_hash?: string | null;
  } | null;
  if (!body?.submission_id || !body?.file_name) {
    return jsonError("missing_required_input", 400, "Submission id and filename are required.");
  }

  const admin = adminClient(env);

  const validation = validateUploadInput({
    fileName: body.file_name,
    contentType: body.content_type,
    sizeBytes: body.size_bytes,
    maxBytes: MAX_CLIENT_UPLOAD_BYTES,
  });
  if (!validation.ok) {
    return jsonError("validation_failed", 400, "Only PDF uploads within the configured size limit are supported.", {
      detail: validation.reason,
      max_bytes: MAX_CLIENT_UPLOAD_BYTES,
    });
  }

  const { data: submission } = await admin
    .from("atlas_submissions")
    .select("id")
    .eq("id", body.submission_id)
    .single();
  if (!submission) return jsonError("not_found", 404, "Submission not found.");
  if (!(await canAccessSubmission(env, user, body.submission_id))) {
    return jsonError("not_found", 404, "Submission not found.");
  }

  // Key files under the submission id so cleanup and access are scoped.
  const path = `${body.submission_id}/${crypto.randomUUID()}-${validation.fileName}`;

  const { data: signed, error: signErr } = await admin.storage
    .from(CLIENT_DOCS_BUCKET)
    .createSignedUploadUrl(path);
  if (signErr || !signed) {
    logOperationError({
      endpoint: "/api/uploads/sign",
      operation: "create_signed_upload_url",
      code: "upload_failed",
      submissionId: body.submission_id,
      status: 500,
    });
    return jsonError("upload_failed", 500, "Could not prepare the upload. Please try again.");
  }

  return json({
    ok: true,
    upload: { url: signed.signedUrl, path, token: signed.token },
  });
}

async function confirmUpload(
  request: Request,
  env: Env,
  user: AtlasUser
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    submission_id?: string;
    file_name?: string;
    storage_path?: string;
    document_type?: string;
    content_type?: string;
    size_bytes?: number;
    file_hash?: string | null;
  } | null;
  if (!body?.submission_id || !body?.file_name || !body?.storage_path) {
    return jsonError("missing_required_input", 400, "Submission id, filename, and storage path are required.");
  }
  if (!body.storage_path.startsWith(`${body.submission_id}/`)) {
    return jsonError("validation_failed", 400, "Upload path does not match the submission.", {
      detail: "path_submission_mismatch",
    });
  }
  const validation = validateUploadInput({
    fileName: body.file_name,
    contentType: body.content_type,
    sizeBytes: body.size_bytes,
    maxBytes: MAX_CLIENT_UPLOAD_BYTES,
  });
  if (!validation.ok) {
    return jsonError("validation_failed", 400, "Only PDF uploads within the configured size limit are supported.", {
      detail: validation.reason,
      max_bytes: MAX_CLIENT_UPLOAD_BYTES,
    });
  }

  const admin = adminClient(env);
  if (!(await canAccessSubmission(env, user, body.submission_id))) {
    return jsonError("not_found", 404, "Submission not found.");
  }

  // Configurable retention window — file becomes eligible for deletion then.
  const expiresAt = new Date(
    Date.now() + retentionDays(env) * 24 * 60 * 60 * 1000
  ).toISOString();

  const { data: doc, error: docErr } = await admin
    .from("atlas_documents")
    .insert({
      submission_id: body.submission_id,
      file_name: validation.fileName,
      storage_path: body.storage_path,
      document_type: body.document_type ?? null,
      status: "active",
      scan_status: "pending",
      uploaded_by: user.id,
      expires_at: expiresAt,
      file_hash: body.file_hash ?? null,
      file_size_bytes: validation.sizeBytes,
      content_type: validation.contentType,
    })
    .select("id")
    .single();

  if (docErr || !doc) return jsonError("upload_failed", 500, "Upload completed but Atlas could not record the document.");

  const scanJob = await beginJob(admin, {
    submissionId: body.submission_id,
    documentId: doc.id,
    jobType: "malware_scan",
    createdBy: user.id,
    metadata: {
      bucket: CLIENT_DOCS_BUCKET,
      storage_path: body.storage_path,
      file_name: validation.fileName,
      content_type: validation.contentType,
    },
  });
  if (scanJob.action !== "queued") {
    await admin.storage.from(CLIENT_DOCS_BUCKET).remove([body.storage_path]);
    await admin.from("atlas_documents").delete().eq("id", doc.id);
    return jsonError("upload_failed", 500, "Upload could not be queued for malware scanning.");
  }

  await audit(env, {
    submissionId: body.submission_id,
    action: "document_uploaded",
    actorId: user.id,
    // File NAME and type only — never contents.
    metadata: {
      document_id: doc.id,
      document_type: body.document_type ?? null,
      file_name: validation.fileName,
      expires_at: expiresAt,
      file_hash_present: Boolean(body.file_hash),
      scan_status: "pending",
    },
  });

  return json({
    ok: true,
    document_id: doc.id,
    scan_job_id: scanJob.jobId,
    scan_status: "pending",
    expires_at: expiresAt,
  });
}
