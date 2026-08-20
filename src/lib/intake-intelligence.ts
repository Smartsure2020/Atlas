/**
 * Atlas — intake & insurer intelligence presentation helpers
 * ----------------------------------------------------------------------------
 * Pure, deterministic helpers used by the Phase 7 intake and insurer surfaces:
 *   - New submission intake (safe create-once + retry-remaining state model)
 *   - Insurer index (coverage filter)
 *   - Insurer detail (setup summary, guideline result presentation, rule
 *     ordering)
 *
 * Nothing here fetches or mutates. Every function is a pure transformation
 * so the pages that consume them stay easy to test and the same
 * transformations can be exercised directly, without React, in the pure test
 * suite that ships alongside this module.
 *
 * Design principles carried over from Phase 6 (see src/lib/operations-evidence.ts):
 *   1. Never fabricate — a queued response is a queued response, not a
 *      "guideline read". A skipped response says so. A missing message is
 *      not backfilled with a made-up one.
 *   2. Input immutability — helpers never mutate their inputs. Ordering
 *      helpers copy the array before sorting so a caller passing a frozen
 *      list is safe.
 *   3. Sanitise strings that came from the wire — server messages are
 *      trimmed, capped, and rejected if they contain control characters,
 *      because they flow into a toast a person will read.
 */

/* ===========================================================================
   Types (structural; no api-module imports)
   =========================================================================== */

export type IntakePhase =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "uploading"; index: number; total: number; name: string }
  | { kind: "partial"; submissionId: string; failedCount: number; remainingCount: number }
  | { kind: "complete"; submissionId: string };

export type PendingUploadStatus =
  | { status: "pending" }
  | { status: "uploading" }
  | { status: "uploaded" }
  | { status: "failed"; error: string };

export interface PendingFile {
  clientId: string;
  file: File;
  type: string;
  problem?: string;
  upload: PendingUploadStatus;
}

/**
 * Minimal structural shape of the processInsurerDocument response. Redeclared
 * locally so this module has no dependency on the api layer (which pulls in
 * env-bound imports that would break the pure test suite).
 */
export interface GuidelineProcessResult {
  ok?: true;
  queued?: boolean;
  job_id?: string;
  status?: string;
  skipped?: boolean;
  message?: string | null;
  insurer_summary?: string;
  proposed_count?: number;
  document_notes?: { note: string }[];
}

export interface InsurerCoverageItem {
  active_appetite_count: number;
}

export type CoverageMode = "all" | "active" | "needs_setup";

export interface InsurerDocumentLike {
  processing_status:
    | "awaiting_processing"
    | "processing"
    | "processed"
    | "failed";
  scan_status?: "pending" | "clean" | "infected" | "failed" | "not_scanned";
  proposed_count?: number;
}

export interface AppetiteRowLike {
  is_active: boolean;
  product_line: string;
  risk_type: string;
  confirmed_at: string | null;
}

/* ===========================================================================
   File intake helpers
   =========================================================================== */

/** A sensible default classification from the file name, still user-editable. */
export function guessDocumentType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("schedule") && lower.includes("vehicle")) return "vehicle_schedule";
  if (lower.includes("schedule") && lower.includes("build")) return "building_schedule";
  if (lower.includes("schedule") || lower.includes("policy")) return "policy_schedule";
  if (lower.includes("proposal")) return "proposal_form";
  if (lower.includes("claim") || lower.includes("loss")) return "claims_history";
  if (lower.includes("quote") || lower.includes("quotation")) return "quote";
  if (lower.includes("email") || lower.includes(".msg") || lower.includes(".eml")) return "broker_email";
  return "supporting";
}

/**
 * Attach a stable clientId to every file. React keys never use array index —
 * removing a row must not steal focus from the row above it. The clientId
 * also lets the sequential upload loop update per-file status by identity
 * rather than position.
 */
export function assignClientIds(files: File[]): PendingFile[] {
  return files.map((file) => ({
    clientId: newClientId(),
    file,
    type: guessDocumentType(file.name),
    upload: { status: "pending" },
  }));
}

function newClientId(): string {
  // jsdom in older Node does not expose crypto.randomUUID; fall back to a
  // short random string that only needs to be unique within a single
  // rendered file list.
  const cryptoObj =
    typeof globalThis !== "undefined"
      ? (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
      : undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    try {
      return cryptoObj.randomUUID();
    } catch {
      /* fall through */
    }
  }
  return `cid_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

/**
 * The files that still need to be uploaded — pending, or previously failed
 * and awaiting a retry. Files already uploaded are excluded so the retry
 * loop never re-uploads them.
 */
export function remainingUploads(files: PendingFile[]): PendingFile[] {
  return files.filter(
    (file) => file.upload.status === "pending" || file.upload.status === "failed"
  );
}

/* ===========================================================================
   Intake phase summary — headline + tone for the recovery notice
   =========================================================================== */

export interface IntakePhaseSummary {
  headline: string;
  tone: "info" | "success" | "warning" | "danger";
}

/**
 * A short, honest headline for the intake state. Never labels the whole
 * intake as failed when a submission id exists (the submission was created;
 * only the attachments need to catch up), and never labels the intake as
 * complete while any file is still pending or failed.
 */
export function intakePhaseSummary(
  phase: IntakePhase,
  files: PendingFile[]
): IntakePhaseSummary {
  switch (phase.kind) {
    case "idle":
      return { headline: "Ready to create the submission", tone: "info" };
    case "creating":
      return { headline: "Creating submission…", tone: "info" };
    case "uploading":
      return {
        headline: `Uploading document ${phase.index} of ${phase.total}`,
        tone: "info",
      };
    case "partial": {
      const failed = files.filter((f) => f.upload.status === "failed").length;
      const remaining = files.filter((f) => f.upload.status === "pending").length;
      const detail = [
        failed > 0 ? `${failed} failed` : null,
        remaining > 0 ? `${remaining} remaining` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        headline: detail
          ? `Submission created — some documents did not upload (${detail})`
          : "Submission created — some documents did not upload",
        tone: "warning",
      };
    }
    case "complete":
      return { headline: "Submission created and all documents uploaded", tone: "success" };
  }
}

/* ===========================================================================
   Guideline processing result presentation
   =========================================================================== */

const MAX_SERVER_MESSAGE_LENGTH = 180;
// Any C0 control byte (U+0000..U+001F) or DEL (U+007F). A guideline toast
// is a single line — nothing that would let a hostile or garbled server
// message insert newlines, invisible control bytes, or ANSI escape
// sequences into what a person reads.
const CONTROL_CHAR = /[\u0000-\u001F\u007F]/;

export interface GuidelinePresentation {
  tone: "success" | "info" | "warning" | "danger";
  message: string;
}

/**
 * Presentation for the outcome of `processInsurerDocument`.
 *
 *  - `queued`   → info + neutral "queued" copy (never "read")
 *  - `skipped`  → warning + neutral "already read / no changes" copy
 *  - `proposed_count > 0` → success + rule count
 *  - `proposed_count === 0` → info + "no new rules proposed"
 *  - anything else (missing/malformed shape) → info + neutral fallback
 *
 * A server-supplied message is trimmed, capped at 180 characters, and
 * rejected if it is not a string or contains control characters. Nothing on
 * the wire is trusted verbatim: a hostile or garbled message would otherwise
 * be shown to a person as-is.
 */
export function presentGuidelineResult(
  response: GuidelineProcessResult | null | undefined
): GuidelinePresentation {
  const safeMessage = sanitiseServerMessage(response?.message);

  if (!response) {
    return { tone: "info", message: "Atlas processed the document." };
  }

  if (response.queued) {
    return {
      tone: "info",
      message:
        safeMessage ??
        "Atlas has queued the document. It will appear here once the run completes.",
    };
  }

  if (response.skipped) {
    return {
      tone: "warning",
      message:
        safeMessage ??
        "Atlas skipped this document — it has already been read or nothing has changed since the last run.",
    };
  }

  const proposed = typeof response.proposed_count === "number" ? response.proposed_count : null;
  if (proposed !== null && proposed > 0) {
    return {
      tone: "success",
      message:
        safeMessage ??
        `Guideline read. ${proposed} ${proposed === 1 ? "rule was" : "rules were"} proposed for review.`,
    };
  }
  if (proposed === 0) {
    return {
      tone: "info",
      message:
        safeMessage ??
        "Guideline read. Atlas did not find any new appetite rules in this document.",
    };
  }

  return {
    tone: "info",
    message: safeMessage ?? "Atlas processed the document.",
  };
}

function sanitiseServerMessage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (CONTROL_CHAR.test(trimmed)) return null;
  return trimmed.length > MAX_SERVER_MESSAGE_LENGTH
    ? `${trimmed.slice(0, MAX_SERVER_MESSAGE_LENGTH - 1)}…`
    : trimmed;
}

/* ===========================================================================
   Insurer index — coverage filter and setup summary
   =========================================================================== */

export function filterInsurersByCoverage<T extends InsurerCoverageItem>(
  items: T[],
  mode: CoverageMode
): T[] {
  switch (mode) {
    case "active":
      return items.filter((item) => item.active_appetite_count > 0);
    case "needs_setup":
      return items.filter((item) => item.active_appetite_count === 0);
    case "all":
    default:
      return items.slice();
  }
}

/* ===========================================================================
   Rule ordering — portfolio-wide first, then product_line asc,
   risk_type asc, confirmed_at desc. Nullish confirmed_at sorts oldest.
   =========================================================================== */

export function orderRules<T extends AppetiteRowLike>(rows: T[]): T[] {
  const portfolioScore = (row: AppetiteRowLike): 0 | 1 =>
    row.product_line === "*" && row.risk_type === "*" ? 0 : 1;

  const confirmedScore = (row: AppetiteRowLike): number => {
    if (!row.confirmed_at) return 0;
    const parsed = Date.parse(row.confirmed_at);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  return rows.slice().sort((a, b) => {
    const portfolio = portfolioScore(a) - portfolioScore(b);
    if (portfolio !== 0) return portfolio;

    const productLine = a.product_line.localeCompare(b.product_line);
    if (productLine !== 0) return productLine;

    const riskType = a.risk_type.localeCompare(b.risk_type);
    if (riskType !== 0) return riskType;

    // confirmed_at desc — newest first.
    return confirmedScore(b) - confirmedScore(a);
  });
}

/* ===========================================================================
   Insurer setup summary — header badge inputs for the detail screen
   =========================================================================== */

export interface InsurerSetupSummary {
  hasActiveRules: boolean;
  proposedCount: number;
  failedGuidelineCount: number;
  scanPendingCount: number;
}

export function insurerSetupSummary(input: {
  insurer: { active_appetite_count?: number } | null;
  documents: InsurerDocumentLike[];
  appetite: AppetiteRowLike[];
}): InsurerSetupSummary {
  const activeFromAppetite = input.appetite.filter((row) => row.is_active).length;
  const activeFromInsurer = input.insurer?.active_appetite_count ?? 0;
  const proposedCount = input.appetite.filter((row) => !row.is_active).length;
  const failedGuidelineCount = input.documents.filter(
    (doc) => doc.processing_status === "failed"
  ).length;
  const scanPendingCount = input.documents.filter(
    (doc) => doc.scan_status === "pending"
  ).length;

  return {
    hasActiveRules: activeFromAppetite > 0 || activeFromInsurer > 0,
    proposedCount,
    failedGuidelineCount,
    scanPendingCount,
  };
}
