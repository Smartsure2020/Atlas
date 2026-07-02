export type JobAttemptAction = "started" | "duplicate_running" | "unchanged_completed";

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export function inputFingerprint(value: unknown): string {
  const text = stableStringify(value);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fp_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function classifyJobAttempt(input: {
  force?: boolean;
  runningJobId?: string | null;
  completedJobId?: string | null;
  resultReferenceId?: string | null;
}): JobAttemptAction {
  if (input.force) return "started";
  if (input.runningJobId) return "duplicate_running";
  if (input.completedJobId) return "unchanged_completed";
  return "started";
}

export function buildExtractionFingerprint(input: {
  submissionId: string;
  brokerEmailPresent: boolean;
  documents: { id: string; storage_path?: string | null; created_at?: string | null; status?: string | null }[];
}) {
  return inputFingerprint({
    type: "extraction",
    submission_id: input.submissionId,
    broker_email_present: input.brokerEmailPresent,
    documents: input.documents
      .map((d) => ({ id: d.id, storage_path: d.storage_path ?? null, created_at: d.created_at ?? null, status: d.status ?? null }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}

export function buildRecommendationFingerprint(input: {
  submissionId: string;
  extractionId: string;
  reviewedAt?: string | null;
  activeRuleIds: string[];
}) {
  return inputFingerprint({
    type: "recommendation",
    submission_id: input.submissionId,
    extraction_id: input.extractionId,
    reviewed_at: input.reviewedAt ?? null,
    active_rule_ids: [...input.activeRuleIds].sort(),
  });
}

export function buildQuoteReviewFingerprint(input: {
  submissionId: string;
  extractionId: string;
  recommendationId?: string | null;
  insurerId?: string | null;
  activeRuleIds: string[];
}) {
  return inputFingerprint({
    type: "quote_review",
    submission_id: input.submissionId,
    extraction_id: input.extractionId,
    recommendation_id: input.recommendationId ?? null,
    insurer_id: input.insurerId ?? null,
    active_rule_ids: [...input.activeRuleIds].sort(),
  });
}

export function buildGuidelineFingerprint(input: {
  documentId: string;
  storagePath?: string | null;
}) {
  return inputFingerprint({
    type: "guideline_ingestion",
    document_id: input.documentId,
    storage_path: input.storagePath ?? null,
  });
}

export function summarizeJobs(jobs: Record<string, unknown>[], nowIso = new Date().toISOString()) {
  const now = Date.parse(nowIso);
  const failed = jobs.filter((j) => j.status === "failed");
  const stuck = jobs.filter((j) => {
    if (j.status !== "running" && j.status !== "queued") return false;
    const started = Date.parse(String(j.started_at ?? j.created_at ?? ""));
    return Number.isFinite(started) && now - started > 20 * 60 * 1000;
  });
  const byErrorCode: Record<string, number> = {};
  for (const job of failed) {
    const code = String(job.error_code ?? "unknown");
    byErrorCode[code] = (byErrorCode[code] ?? 0) + 1;
  }
  return {
    failed_count: failed.length,
    stuck_count: stuck.length,
    by_error_code: byErrorCode,
    recent_failed_jobs: failed.slice(0, 10),
    stuck_jobs: stuck.slice(0, 10),
  };
}

export function buildHealthBody() {
  return { ok: true, service: "atlas" };
}
