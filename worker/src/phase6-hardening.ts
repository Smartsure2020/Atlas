import type { Env, AtlasRole } from "./config";

export type SafeErrorCode =
  | "upload_failed"
  | "document_unavailable"
  | "extraction_failed"
  | "validation_failed"
  | "recommendation_failed"
  | "quote_review_failed"
  | "permission_denied"
  | "missing_required_input"
  | "not_found"
  | "internal_error";

export const ROLE_LABELS: Record<AtlasRole, string> = {
  admin: "admin",
  manager: "manager",
  consultant: "consultant",
  readonly: "readonly/auditor",
  underwriter: "consultant (legacy underwriter claim)",
  broker: "broker",
};

const REQUIRED_ENV: (keyof Env)[] = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "ANTHROPIC_API_KEY",
  "ATLAS_ALLOWLIST_JSON",
];

const DEV_ONLY_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export const MAX_CLIENT_UPLOAD_BYTES = 15 * 1024 * 1024;
export const MAX_GUIDELINE_UPLOAD_BYTES = 25 * 1024 * 1024;
export const PHASE6_RLS_TABLES = [
  "atlas_submissions",
  "atlas_documents",
  "atlas_extractions",
  "atlas_insurer_appetite",
  "atlas_appetite_history",
  "atlas_recommendations",
  "atlas_decisions",
  "atlas_audit_logs",
  "atlas_insurers",
  "atlas_insurer_documents",
  "atlas_quote_reviews",
  "atlas_quote_review_sections",
  "atlas_missing_info_items",
  "atlas_communications",
  "atlas_jobs",
  "atlas_cleanup_candidates",
  "atlas_operational_alerts",
  "atlas_pilot_issues",
  "atlas_underwriter_profiles",
  "atlas_assignment_events",
] as const;

export const PHASE6_AUDIT_EVENTS = [
  "quote_review_run",
  "decision_accepted",
  "decision_overridden",
  "decision_override_ruled_out",
  "missing_info_added",
  "missing_info_updated",
  "communication_saved",
  "communication_updated",
] as const;

const ALLOWED_UPLOAD_EXTENSIONS = new Set([".pdf"]);
const ALLOWED_UPLOAD_TYPES = new Set(["application/pdf"]);

export function normalizeAtlasRole(role: unknown): AtlasRole | null {
  if (
    role === "admin" ||
    role === "manager" ||
    role === "consultant" ||
    role === "readonly" ||
    role === "broker"
  ) {
    return role;
  }
  if (role === "auditor") return "readonly";
  if (role === "underwriter") return "underwriter";
  return null;
}

// Generic writer set — DO NOT add "broker". Broker uses narrow capability
// helpers below. Adding broker here would grant Data-API-scoped write access
// through every current *_scoped_update / *_scoped_insert policy that uses
// atlas_can_write(), i.e. extractions, recommendations, decisions, quote
// reviews, communications, missing-info mutations, and submission updates.
export function roleCanWrite(role: AtlasRole): boolean {
  return role === "admin" || role === "manager" || role === "consultant" || role === "underwriter";
}

export function roleCanManageAppetite(role: AtlasRole): boolean {
  return role === "admin" || role === "manager";
}

export function roleCanRunExtraction(role: AtlasRole): boolean {
  return role === "admin" || role === "manager";
}

export function roleCanViewManagerDashboard(role: AtlasRole): boolean {
  return role === "admin" || role === "manager";
}

// ---------- Phase 3 narrow capability helpers ----------
// Broker gets specific, well-scoped abilities WITHOUT inheriting the
// generic writer set above. Each helper is deliberately named for the
// capability it grants so a security review can grep for it in isolation.

export function roleCanCreateSubmission(role: AtlasRole): boolean {
  return roleCanWrite(role) || role === "broker";
}

export function roleCanUploadClientDocument(role: AtlasRole): boolean {
  return roleCanWrite(role) || role === "broker";
}

// Underwriting intelligence = extraction / recommendation / quote review /
// decision / internal communications / insurer intelligence. Broker MUST
// be excluded from every route (read or write) protected by this helper.
// Readonly and auditor keep their existing read-only access.
export function roleCanViewUnderwritingIntelligence(role: AtlasRole): boolean {
  return (
    role === "admin" ||
    role === "manager" ||
    role === "consultant" ||
    role === "underwriter" ||
    role === "readonly"
  );
}

export function validateEnv(env: Env): string[] {
  const missing = REQUIRED_ENV.filter((key) => !String(env[key] ?? "").trim());
  const problems = [...missing.map((key) => `missing:${key}`)];
  if (env.ATLAS_ENV === "production") {
    if (!env.AZURE_REDIRECT_URI || isLocalUrl(env.AZURE_REDIRECT_URI)) {
      problems.push("production_redirect_uri_is_local");
    }
    if (!env.CORS_ORIGIN || isLocalUrl(env.CORS_ORIGIN)) {
      problems.push("production_cors_origin_is_local_or_missing");
    }
    if (!env.ATLAS_MALWARE_SCANNER_URL || !env.ATLAS_MALWARE_SCANNER_TOKEN) {
      problems.push("production_malware_scanner_missing");
    }
    if (!env.ATLAS_OAUTH_STATE_SECRET) {
      problems.push("production_oauth_state_secret_missing");
    }
  }
  return problems;
}

export function isDevSignInAllowed(env: Env): boolean {
  // Fail CLOSED on missing configuration: dev sign-in requires an explicit
  // development environment, not merely the absence of a production flag.
  return env.ATLAS_ENV === "development" && isLocalUrl(env.AZURE_REDIRECT_URI);
}

export function isLocalUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return DEV_ONLY_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

export function safeErrorBody(
  code: SafeErrorCode,
  message: string,
  fields: Record<string, unknown> = {}
): { ok: false; error: SafeErrorCode; message: string; request_id: string } & Record<string, unknown> {
  return {
    ok: false,
    error: code,
    message,
    request_id: crypto.randomUUID(),
    ...fields,
  };
}

export function safeFilename(fileName: string): string {
  return fileName
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    ?.replace(/[^a-zA-Z0-9._ -]/g, "_")
    .trim()
    .slice(0, 120) || "upload.pdf";
}

export function validateUploadInput(input: {
  fileName?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
  maxBytes?: number;
}): { ok: true; fileName: string; contentType: string; sizeBytes: number | null } | { ok: false; reason: string } {
  const fileName = safeFilename(input.fileName ?? "");
  const lower = fileName.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
  const contentType = (input.contentType ?? "").split(";")[0].trim().toLowerCase();

  if (!ALLOWED_UPLOAD_EXTENSIONS.has(ext)) return { ok: false, reason: "unsupported_file_type" };
  if (contentType && !ALLOWED_UPLOAD_TYPES.has(contentType)) return { ok: false, reason: "unsupported_file_type" };

  const sizeBytes = typeof input.sizeBytes === "number" && Number.isFinite(input.sizeBytes)
    ? Math.trunc(input.sizeBytes)
    : null;
  if (sizeBytes !== null && sizeBytes <= 0) return { ok: false, reason: "empty_file" };
  if (sizeBytes !== null && sizeBytes > (input.maxBytes ?? MAX_CLIENT_UPLOAD_BYTES)) {
    return { ok: false, reason: "file_too_large" };
  }

  return { ok: true, fileName, contentType: contentType || "application/pdf", sizeBytes };
}

export function logOperationError(params: {
  endpoint: string;
  operation: string;
  code: SafeErrorCode | string;
  submissionId?: string | null;
  quoteReviewId?: string | null;
  documentId?: string | null;
  status?: number;
  errorName?: string;
}) {
  console.error("atlas_operation_error", {
    endpoint: params.endpoint,
    operation: params.operation,
    code: params.code,
    submission_id: params.submissionId ?? null,
    quote_review_id: params.quoteReviewId ?? null,
    document_id: params.documentId ?? null,
    status: params.status ?? null,
    error_name: params.errorName ?? null,
    timestamp: new Date().toISOString(),
  });
}
