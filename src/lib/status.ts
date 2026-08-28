/**
 * Atlas — status taxonomy
 * ----------------------------------------------------------------------------
 * One place that turns a backend enum into something a person can read, with a
 * tone and a short definition. Screens must never render a raw enum, and must
 * never invent a colour for a state locally.
 *
 * Tones are semantic, not decorative:
 *   success  – nothing outstanding on this dimension
 *   info     – in flight, or informational context
 *   neutral  – inert / not started / archived
 *   warning  – a soft concern a human should look at
 *   referral – needs someone else's authority (insurer or senior underwriter)
 *   danger   – a hard failure, decline, or error
 *
 * Note the deliberate split: outstanding information is a *warning*, not a
 * danger. Red is reserved for appetite failures, declines, and errors.
 */

export type Tone = "success" | "info" | "neutral" | "warning" | "referral" | "danger";

export interface StatusMeta {
  /** Sentence-case label shown to users. */
  label: string;
  tone: Tone;
  /** What the state actually means — surfaced as a title/tooltip and in help. */
  description?: string;
}

const NEUTRAL: StatusMeta = { label: "Unknown", tone: "neutral" };

/**
 * The single canonical Atlas safety statement. Two surfaces used to
 * phrase it two different ways — the Communications panel said "on your
 * behalf", the Manager overview said "itself". A governance-critical
 * claim like this should read identically everywhere; both now use this
 * constant. If a change ever needs to happen, it happens in one place.
 */
export const ATLAS_NEVER_SENDS_MESSAGE = "Atlas never sends anything itself";

function pick(map: Record<string, StatusMeta>, value: string | null | undefined, fallbackLabel?: string): StatusMeta {
  if (!value) return fallbackLabel ? { ...NEUTRAL, label: fallbackLabel } : NEUTRAL;
  const hit = map[value];
  if (hit) return hit;
  // Unknown enum from a newer backend: show it readably rather than raw.
  const label = value.replace(/[_-]+/g, " ");
  return { label: label.charAt(0).toUpperCase() + label.slice(1), tone: "neutral" };
}

/* ---------------------------------------------------------------------------
   Submission workflow status (submissions.status)
   ------------------------------------------------------------------------- */

export const WORKFLOW_STATUS: Record<string, StatusMeta> = {
  new: {
    label: "New",
    tone: "info",
    description: "Received from the broker. Intake has not been reviewed yet.",
  },
  in_review: {
    label: "In review",
    tone: "info",
    description: "An underwriter is working through the risk information.",
  },
  missing_info_requested: {
    label: "Missing information",
    tone: "warning",
    description: "Information has been requested and the submission is waiting on a reply.",
  },
  ready_for_quote: {
    label: "Ready for quote",
    tone: "success",
    description: "Reviewed and cleared to proceed to quotation.",
  },
  referred_to_insurer: {
    label: "Referral required",
    tone: "referral",
    description: "Outside standard authority — the insurer or a senior underwriter must decide.",
  },
  completed: { label: "Completed", tone: "neutral", description: "Work on this submission is finished." },
  closed: { label: "Closed", tone: "neutral", description: "Closed without proceeding." },
};

export const workflowStatus = (value: string | null | undefined) => pick(WORKFLOW_STATUS, value);

/** The columns the board view groups submissions into. */
export const WORKFLOW_COLUMNS: { key: string; title: string; match: (status: string) => boolean }[] = [
  { key: "new", title: "New", match: (s) => s === "new" },
  { key: "in_review", title: "In review", match: (s) => s === "in_review" },
  {
    key: "missing_info_requested",
    title: "Missing information",
    match: (s) => s === "missing_info_requested",
  },
  { key: "ready_for_quote", title: "Ready for quote", match: (s) => s === "ready_for_quote" },
  { key: "referred_to_insurer", title: "Referral required", match: (s) => s === "referred_to_insurer" },
  {
    key: "completed",
    title: "Completed",
    match: (s) => s === "completed" || s === "closed",
  },
];

/* ---------------------------------------------------------------------------
   Queue status (submissions.queue_status) — ownership state, independent of
   the underwriting workflow status. Deliberately not merged into one badge.
   ------------------------------------------------------------------------- */

export const QUEUE_STATUS: Record<string, StatusMeta> = {
  new: { label: "New", tone: "info", description: "Not yet picked up." },
  in_review: { label: "In review", tone: "info", description: "Actively being worked." },
  waiting_info: {
    label: "Waiting for information",
    tone: "warning",
    description: "Parked until the outstanding information arrives.",
  },
  referred: {
    label: "Referred",
    tone: "referral",
    description: "With the insurer or a senior underwriter for a decision.",
  },
  completed: { label: "Completed", tone: "neutral" },
  archived: { label: "Archived", tone: "neutral" },
};

export const queueStatus = (value: string | null | undefined) => pick(QUEUE_STATUS, value, "Unassigned state");

export const QUEUE_STATUS_OPTIONS = Object.entries(QUEUE_STATUS).map(([value, meta]) => ({
  value,
  label: meta.label,
}));

/* ---------------------------------------------------------------------------
   Pipeline stage (submissions.pipeline_stage) — commercial quote lifecycle,
   separate from queue_status (operational workflow) and legacy status. Phase 1
   introduces the vocabulary only; no screen renders it yet.
   ------------------------------------------------------------------------- */

export const PIPELINE_STAGE: Record<string, StatusMeta> = {
  new: {
    label: "New",
    tone: "info",
    description: "Received but not yet triaged.",
  },
  triaged: {
    label: "Triaged",
    tone: "info",
    description: "Classified and ready for assignment.",
  },
  assigned: {
    label: "Assigned",
    tone: "info",
    description: "Assigned to an underwriter; work not yet started.",
  },
  in_progress: {
    label: "In progress",
    tone: "info",
    description: "Underwriting work is in progress.",
  },
  quoted: {
    label: "Quoted",
    tone: "success",
    description: "An insurer quote has been received.",
  },
  bound: {
    label: "Bound",
    tone: "success",
    description: "Business placed / bound.",
  },
  declined: {
    label: "Declined",
    tone: "danger",
    description: "Opportunity declined by the insurer or the client.",
  },
  lost: {
    label: "Lost",
    tone: "neutral",
    description: "Opportunity did not proceed.",
  },
};

export const pipelineStage = (value: string | null | undefined) =>
  pick(PIPELINE_STAGE, value, "Not yet triaged");

/** Non-terminal stages a case is still commercially active in. */
export const PIPELINE_STAGE_TERMINAL: readonly string[] = [
  "bound",
  "declined",
  "lost",
];

export const isPipelineStageOpen = (value: string | null | undefined): boolean =>
  Boolean(value) && !PIPELINE_STAGE_TERMINAL.includes(value ?? "");

/* ---------------------------------------------------------------------------
   Priority
   ------------------------------------------------------------------------- */

export const PRIORITY: Record<string, StatusMeta> = {
  urgent: { label: "Urgent", tone: "danger" },
  high: { label: "High", tone: "referral" },
  normal: { label: "Normal", tone: "neutral" },
  low: { label: "Low", tone: "neutral" },
};

export const priority = (value: string | null | undefined) => pick(PRIORITY, value ?? "normal");

export const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/* ---------------------------------------------------------------------------
   Appetite bands and rule levels
   ------------------------------------------------------------------------- */

export const APPETITE_BAND: Record<string, StatusMeta> = {
  preferred: {
    label: "Preferred appetite",
    tone: "success",
    description: "The risk sits inside the insurer's preferred appetite.",
  },
  standard: {
    label: "Standard appetite",
    tone: "info",
    description: "Within normal appetite, no special treatment indicated.",
  },
  caution: {
    label: "Caution",
    tone: "warning",
    description: "Written with care — the guideline flags concerns for this risk type.",
  },
  declined: {
    label: "Outside appetite",
    tone: "danger",
    description: "The guideline declines this risk type.",
  },
  ruled_out: {
    label: "Ruled out",
    tone: "danger",
    description: "A hard appetite failure. This insurer cannot be recommended for this risk.",
  },
  insufficient_rule_match: {
    label: "No reliable rule match",
    tone: "warning",
    description:
      "Atlas could not match a product-level rule with confidence. Treat this as a data gap, not an appetite decision.",
  },
  referral: {
    label: "Referral required",
    tone: "referral",
    description: "The guideline requires the insurer or a senior underwriter to approve.",
  },
  ok: { label: "No issues found", tone: "success" },
  info_required: {
    label: "Information required",
    tone: "warning",
    description: "Atlas needs more information before it can assess this dimension.",
  },
};

export const appetiteBand = (value: string | null | undefined) => pick(APPETITE_BAND, value);

export const APPETITE_LEVEL_OPTIONS = [
  { value: "preferred", label: "Preferred" },
  { value: "standard", label: "Standard" },
  { value: "caution", label: "Caution" },
  { value: "declined", label: "Declined" },
];

/* ---------------------------------------------------------------------------
   Quote review outcomes and section statuses
   ------------------------------------------------------------------------- */

export const QUOTE_REVIEW_STATUS: Record<string, StatusMeta> = {
  draft: { label: "Draft", tone: "neutral" },
  can_proceed: {
    label: "Can proceed",
    tone: "success",
    description: "No blocking findings against this insurer's rules.",
  },
  review_required: {
    label: "Review required",
    tone: "warning",
    description: "An underwriter needs to look at the findings before proceeding.",
  },
  refer: {
    label: "Referral required",
    tone: "referral",
    description: "One or more findings trigger a referral to the insurer or a senior underwriter.",
  },
  info_required: {
    label: "Information required",
    tone: "warning",
    description: "Outstanding information prevents a complete review.",
  },
  declined: {
    label: "Declined",
    tone: "danger",
    description: "The quote conflicts with the insurer's stated appetite or terms.",
  },
  overridden: {
    label: "Overridden",
    tone: "referral",
    description: "An underwriter recorded a decision that departs from the review outcome.",
  },
};

export const quoteReviewStatus = (value: string | null | undefined) => pick(QUOTE_REVIEW_STATUS, value);

export const SECTION_STATUS: Record<string, StatusMeta> = {
  ok: { label: "No issues", tone: "success" },
  caution: { label: "Concern", tone: "warning" },
  refer: { label: "Referral", tone: "referral" },
  declined: { label: "Hard failure", tone: "danger" },
  info_required: { label: "Information required", tone: "warning" },
  insufficient_rule_match: { label: "No rule match", tone: "warning" },
};

export const sectionStatus = (value: string | null | undefined) => pick(SECTION_STATUS, value);

/* ---------------------------------------------------------------------------
   Missing information
   ------------------------------------------------------------------------- */

export const MISSING_INFO_STATUS: Record<string, StatusMeta> = {
  open: {
    label: "Outstanding",
    tone: "warning",
    description: "Identified but not yet requested from anyone.",
  },
  requested: {
    label: "Requested",
    tone: "info",
    description: "Requested and awaiting a reply.",
  },
  received: {
    label: "Received",
    tone: "success",
    description: "Received — review it and rerun the analysis if it changes the risk.",
  },
  waived: { label: "Waived", tone: "neutral", description: "Deliberately not pursued. A note is required." },
  not_required: {
    label: "Not required",
    tone: "neutral",
    description: "Determined to be unnecessary for this risk. A note is required.",
  },
};

export const missingInfoStatus = (value: string | null | undefined) => pick(MISSING_INFO_STATUS, value);

export const MISSING_INFO_STATUS_OPTIONS = Object.entries(MISSING_INFO_STATUS).map(([value, meta]) => ({
  value,
  label: meta.label,
}));

export const MISSING_INFO_OWNER_OPTIONS = [
  { value: "broker", label: "Broker" },
  { value: "client", label: "Client" },
  { value: "consultant", label: "Consultant" },
  { value: "insurer", label: "Insurer" },
  { value: "senior_underwriter", label: "Senior underwriter" },
  { value: "unknown", label: "Not assigned" },
];

/** Severity words used by extraction output for missing items and red flags. */
export const SEVERITY: Record<string, StatusMeta> = {
  high: { label: "High", tone: "danger" },
  medium: { label: "Medium", tone: "warning" },
  low: { label: "Low", tone: "neutral" },
  critical: { label: "Critical", tone: "danger" },
  warning: { label: "Warning", tone: "warning" },
  info: { label: "Information", tone: "info" },
};

export const severity = (value: string | null | undefined) => pick(SEVERITY, value);

/* ---------------------------------------------------------------------------
   Documents
   ------------------------------------------------------------------------- */

export const DOCUMENT_PROCESSING: Record<string, StatusMeta> = {
  awaiting_processing: { label: "Queued", tone: "neutral", description: "Uploaded and waiting to be read." },
  processing: { label: "Reading document", tone: "info" },
  processed: { label: "Processed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

export const documentProcessing = (value: string | null | undefined) => pick(DOCUMENT_PROCESSING, value);

export const SCAN_STATUS: Record<string, StatusMeta> = {
  pending: { label: "Malware scan pending", tone: "warning" },
  clean: { label: "Scanned", tone: "success" },
  infected: { label: "Quarantined", tone: "danger" },
  failed: { label: "Scan failed", tone: "danger" },
  not_scanned: { label: "Not scanned", tone: "neutral" },
};

export const scanStatus = (value: string | null | undefined) => pick(SCAN_STATUS, value);

export const DOCUMENT_TYPE_OPTIONS = [
  { value: "broker_email", label: "Broker email" },
  { value: "policy_schedule", label: "Policy schedule" },
  { value: "proposal_form", label: "Proposal form" },
  { value: "claims_history", label: "Claims history" },
  { value: "vehicle_schedule", label: "Vehicle schedule" },
  { value: "building_schedule", label: "Building schedule" },
  { value: "quote", label: "Insurer quote" },
  { value: "supporting", label: "Supporting document" },
];

export const documentTypeLabel = (value: string | null | undefined): string =>
  DOCUMENT_TYPE_OPTIONS.find((option) => option.value === value)?.label ??
  (value ? value.replace(/_/g, " ") : "Unclassified");

/* ---------------------------------------------------------------------------
   Processing jobs
   ------------------------------------------------------------------------- */

export const JOB_STATUS: Record<string, StatusMeta> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "info" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  skipped: {
    label: "Skipped",
    tone: "neutral",
    description: "Inputs were unchanged since the previous run, so Atlas reused the earlier result.",
  },
};

export const jobStatus = (value: string | null | undefined) => pick(JOB_STATUS, value, "Not run");

export const JOB_TYPE_LABELS: Record<string, string> = {
  extraction: "Extract risk details",
  guideline_ingestion: "Read insurer guideline",
  malware_scan: "Malware scan",
  recommendation: "Insurer recommendation",
  quote_review: "Quote review",
  communication_generation: "Draft communication",
  cleanup: "Storage cleanup",
  other: "Other",
};

export const jobTypeLabel = (value: string | null | undefined): string =>
  (value && JOB_TYPE_LABELS[value]) || (value ? value.replace(/_/g, " ") : "Job");

/**
 * The human-facing processing state for a submission. Users see what Atlas is
 * doing, not the queue mechanics.
 */
export function processingStage(status: string | null | undefined, jobType: string): StatusMeta {
  if (status === "running" || status === "queued") {
    const inFlight: Record<string, string> = {
      extraction: "Extracting risk details",
      recommendation: "Checking insurer appetite",
      quote_review: "Reviewing quote terms",
    };
    return { label: inFlight[jobType] ?? "Processing", tone: "info" };
  }
  if (status === "failed") return { label: "Processing failed", tone: "danger" };
  if (status === "cancelled") return { label: "Cancelled", tone: "neutral" };
  if (status === "skipped") return JOB_STATUS.skipped;
  if (status === "completed") return { label: "Completed", tone: "success" };
  return { label: "Not run", tone: "neutral" };
}

/* ---------------------------------------------------------------------------
   Extraction field confidence
   ---------------------------------------------------------------------------
   Atlas stores a numeric confidence, but showing "93.47%" implies a precision
   the pipeline does not have. Bands communicate the same signal honestly.
   ------------------------------------------------------------------------- */

export type ConfidenceBand = "confirmed" | "likely" | "uncertain" | "conflicting" | "missing";

export const CONFIDENCE_BAND: Record<ConfidenceBand, StatusMeta> = {
  confirmed: {
    label: "Confirmed",
    tone: "success",
    description: "Read directly from a source document, or confirmed by an underwriter.",
  },
  likely: {
    label: "Likely",
    tone: "neutral",
    description: "Extracted with reasonable confidence. Worth a glance before you rely on it.",
  },
  uncertain: {
    label: "Uncertain",
    tone: "warning",
    description: "Atlas is not confident in this value. Verify it against the source document.",
  },
  conflicting: {
    label: "Conflicting",
    tone: "referral",
    description: "The source documents disagree on this value. A human needs to resolve it.",
  },
  missing: {
    label: "Not provided",
    tone: "danger",
    description: "No value was found in any source document.",
  },
};

/**
 * Derive a band from the extraction field's own status plus its confidence.
 * The stored `status` wins where it is decisive; confidence resolves the rest.
 *
 * `reviewed` is a submission-level flag — a reviewer clicked Save Review
 * on the extraction as a whole. The pipeline does not yet emit per-field
 * "was this field corrected" provenance, so we deliberately do NOT let
 * submission-level review promote a field that Atlas itself marked as
 * low-confidence, unclear, or conflicting. The safe reading is: the
 * reviewer confirmed the shape of the record; individual fields Atlas
 * flagged as uncertain remain uncertain until the field's own status
 * changes. This keeps the "Uncertain risk fields" count honest — clicking
 * Save Review never zeroes it out on its own.
 */
export function confidenceBand(
  status: string | null | undefined,
  confidence: number | null | undefined,
  reviewed: boolean
): StatusMeta & { band: ConfidenceBand } {
  const band = ((): ConfidenceBand => {
    if (status === "not_found") return "missing";
    if (status === "conflicting") return "conflicting";
    if (status === "unclear") return "uncertain";
    if (status === "low_confidence_extracted") return "uncertain";
    if (reviewed) return "confirmed";
    const value = typeof confidence === "number" ? confidence : 0;
    if (value >= 0.85) return "confirmed";
    if (value > 0.5) return "likely";
    return "uncertain";
  })();
  return { band, ...CONFIDENCE_BAND[band] };
}

/* ---------------------------------------------------------------------------
   Decisions
   ------------------------------------------------------------------------- */

export const DECISION_CHOICE_OPTIONS = [
  { value: "proceed", label: "Proceed", description: "Cleared to take this insurer forward." },
  {
    value: "refer",
    label: "Refer to insurer or senior underwriter",
    description: "Outside your authority — record why, and prepare a referral pack.",
  },
  {
    value: "request_info",
    label: "Request missing information",
    description: "Park the submission until the outstanding information arrives.",
  },
  {
    value: "decline",
    label: "Do not proceed",
    description: "No suitable terms. Record the reason for the audit history.",
  },
  {
    value: "override",
    label: "Override the Atlas recommendation",
    description: "Take a different route to the one Atlas ranked first.",
  },
];

export const DECISION_STATUS: Record<string, StatusMeta> = {
  ready_for_quote: { label: "Ready for quote", tone: "success" },
  referred: { label: "Referred", tone: "referral" },
  closed: { label: "Closed", tone: "neutral" },
};

export const decisionStatus = (value: string | null | undefined) => pick(DECISION_STATUS, value);

export const OVERRIDE_REASON_OPTIONS = [
  { value: "client_preference", label: "Client preference" },
  { value: "broker_relationship", label: "Broker relationship" },
  { value: "claims_history_factor", label: "Claims history factor" },
  { value: "pricing_factor", label: "Pricing factor" },
  { value: "capacity_constraint", label: "Capacity constraint" },
  { value: "client_request", label: "Client request" },
  { value: "other", label: "Other (describe below)" },
];

export const overrideReasonLabel = (value: string | null | undefined): string =>
  OVERRIDE_REASON_OPTIONS.find((option) => option.value === value)?.label ?? "Not recorded";

/* ---------------------------------------------------------------------------
   Communications
   ------------------------------------------------------------------------- */

export const COMMUNICATION_STATUS: Record<string, StatusMeta> = {
  draft: { label: "Draft", tone: "neutral" },
  copied: { label: "Copied", tone: "info" },
  sent_manually: { label: "Sent", tone: "success" },
  archived: { label: "Archived", tone: "neutral" },
};

export const communicationStatus = (value: string | null | undefined) => pick(COMMUNICATION_STATUS, value);

export const COMMUNICATION_TYPE_LABELS: Record<string, string> = {
  missing_info_request: "Missing information request",
  referral_pack: "Referral pack",
  review_summary: "Quote review summary",
  broker_note: "Broker note",
  internal_note: "Internal note",
  other: "Communication",
};

/* ---------------------------------------------------------------------------
   Operational alerts
   ------------------------------------------------------------------------- */

export const ALERT_SEVERITY: Record<string, StatusMeta> = {
  critical: { label: "Critical", tone: "danger" },
  warning: { label: "Warning", tone: "warning" },
  info: { label: "Information", tone: "info" },
};

export const alertSeverity = (value: string | null | undefined) => pick(ALERT_SEVERITY, value);

export const ALERT_STATUS: Record<string, StatusMeta> = {
  open: { label: "Open", tone: "danger" },
  acknowledged: { label: "Acknowledged", tone: "warning" },
  resolved: { label: "Resolved", tone: "success" },
};

export const alertStatus = (value: string | null | undefined) => pick(ALERT_STATUS, value);

/* ---------------------------------------------------------------------------
   Roles and lines of business
   ------------------------------------------------------------------------- */

export const ROLE_LABELS: Record<string, string> = {
  admin: "Administrator",
  manager: "Underwriting manager",
  underwriter: "Underwriter",
  consultant: "Consultant",
  readonly: "Read only",
  broker: "Broker",
};

export const LINE_OF_BUSINESS_OPTIONS = [
  { value: "personal", label: "Personal lines" },
  { value: "commercial", label: "Commercial lines" },
];

export const lineOfBusinessLabel = (value: string | null | undefined): string =>
  LINE_OF_BUSINESS_OPTIONS.find((option) => option.value === value)?.label ?? "Line not captured";
