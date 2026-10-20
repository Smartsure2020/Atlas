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

/**
 * Canonical form of the trusted (active + exact-clean) document evidence a
 * recommendation or quote review consumed: exact strings, de-duplicated and
 * sorted. Both consumers only test membership (`hasRequiredDoc` in the matcher,
 * `availableDocs.some` in buildQuoteReview), so order and duplicates carry no
 * meaning. Case is deliberately NOT folded — the consumers normalise
 * internally and the fingerprint must not depend on how they do it; a spurious
 * miss only recomputes, a spurious hit would serve a stale result.
 */
function canonicalDocumentEvidence(documents: readonly string[]): string[] {
  return [...new Set(documents)].sort();
}

export function buildRecommendationFingerprint(input: {
  submissionId: string;
  extractionId: string;
  reviewedAt?: string | null;
  activeRuleIds: string[];
  /** The exact `availableDocs` handed to deriveRisk(): trusted documents only. */
  availableDocuments: string[];
  /**
   * Behaviour versions are REQUIRED inputs. A cached "unchanged" answer is only
   * valid if the code that would recompute it is the code that produced it, so
   * a change to matching semantics, taxonomy data or the persisted evidence
   * contract must invalidate every previously completed recommendation job.
   * (Required rather than optional so a future call site cannot forget them.)
   */
  matcherVersion: string;
  taxonomyVersion: string;
  evidenceSchemaVersion: string;
  /** Version of the quality classification table that shapes the persisted quality block. */
  qualityModelVersion: string;
  /**
   * The ACTIVE insurer inventory (id + name). It determines `no_data_for` — the
   * insurers with zero active rules — so activating, deactivating or renaming an
   * insurer changes the persisted recommendation even when no appetite rule did.
   */
  activeInsurers: { id: string; name: string }[];
}) {
  return inputFingerprint({
    type: "recommendation",
    submission_id: input.submissionId,
    extraction_id: input.extractionId,
    reviewed_at: input.reviewedAt ?? null,
    active_rule_ids: [...input.activeRuleIds].sort(),
    available_documents: canonicalDocumentEvidence(input.availableDocuments),
    matcher_version: input.matcherVersion,
    taxonomy_version: input.taxonomyVersion,
    evidence_schema_version: input.evidenceSchemaVersion,
    quality_model_version: input.qualityModelVersion,
    active_insurers: canonicalInsurerInventory(input.activeInsurers),
  });
}

/**
 * Canonical, order-independent form of the active insurer inventory: unique
 * `[id, name]` pairs sorted by UTF-16 code units (never locale-dependent), so the
 * database's row order can never change a fingerprint.
 */
export function canonicalInsurerInventory(insurers: readonly { id: string; name: string }[]): [string, string][] {
  const pairs = new Map<string, [string, string]>();
  for (const insurer of insurers) pairs.set(`${insurer.id}\u0000${insurer.name}`, [String(insurer.id), String(insurer.name)]);
  return [...pairs.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
}

export function buildQuoteReviewFingerprint(input: {
  submissionId: string;
  extractionId: string;
  recommendationId?: string | null;
  insurerId?: string | null;
  activeRuleIds: string[];
  /** The exact `availableDocuments` handed to buildQuoteReview(): trusted documents only. */
  availableDocuments: string[];
}) {
  return inputFingerprint({
    type: "quote_review",
    submission_id: input.submissionId,
    extraction_id: input.extractionId,
    recommendation_id: input.recommendationId ?? null,
    insurer_id: input.insurerId ?? null,
    active_rule_ids: [...input.activeRuleIds].sort(),
    available_documents: canonicalDocumentEvidence(input.availableDocuments),
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
