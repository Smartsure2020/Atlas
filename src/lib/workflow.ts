/**
 * Atlas — workflow presentation semantics
 * ----------------------------------------------------------------------------
 * Pure helpers that turn the missing-information and communication records
 * already in memory into scannable operational summaries and referral-pack
 * readiness. Nothing here calls the API, invents fields, or changes lifecycle
 * semantics — the same status values return the same labels they always did.
 *
 * Kept separate from the panels so both surfaces render the same summary
 * hierarchy without duplicating the logic, and so tests can assert the
 * derivation against a small pure surface rather than the whole panel.
 */

import type { MissingInfoItem, MissingInfoStatus, MissingInfoOwner } from "./phase4";
import type { CommunicationRecord } from "./phase4";
import type { QuoteReview, QuoteReviewSection } from "./quote-reviews";
import type { Recommendation } from "./recommendations";
import type { Decision } from "./decisions";
import type { ExtractionRecord } from "./atlas";

/**
 * A single count on the missing-information action summary. Each summary
 * line names an operational job and reports how many items sit in that state
 * right now, using existing statuses only.
 */
export interface MissingInfoSummary {
  /** Items identified but not yet requested from anyone. */
  outstanding: number;
  /** Items already requested and awaiting a reply. */
  awaiting_reply: number;
  /** Items received and waiting on human review. */
  awaiting_review: number;
  /** Items deliberately closed (waived or not required). */
  closed: number;
  /**
   * Requested-but-not-received items whose real due_date has already passed,
   * derived from `today`. Never inferred when there is no due date.
   */
  overdue: number;
  /** Distinct owners represented in the still-active (open + requested) items. */
  active_owners: MissingInfoOwner[];
}

/**
 * Overdue policy — single consistent local-calendar-day comparison.
 *
 * A due date is a business date, not a moment in time. The comparison is:
 *   - due_date < today's local calendar date → overdue
 *   - due_date == today's local calendar date → NOT overdue
 *   - due_date > today's local calendar date → NOT overdue
 *   - missing / malformed → NOT overdue
 *
 * `due_date` is authored as YYYY-MM-DD, which `new Date(str)` parses as
 * midnight UTC — that shifts the calendar day in any negative-offset locale.
 * We therefore never construct a Date from a bare date string; we compare
 * literal date keys instead. Full timestamps (if ever received) are converted
 * to a local calendar key via `getFullYear/getMonth/getDate`. Never mix
 * `getUTC*` and local `get*` in the same comparison.
 */

/**
 * Whether (year, month, day) is a real Gregorian calendar date. This is a pure
 * structural check — no `Date` construction, no timezone involvement — so it
 * rejects impossible literals such as 2026-02-30, 2026-04-31, 2025-02-29 while
 * accepting 2024-02-29. Kept independent of the local-business-day comparison
 * policy used for timestamps and `today`.
 */
function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const max = month === 2 && isLeap ? 29 : daysInMonth[month - 1];
  return day <= max;
}

/** YYYY-MM-DD key from a date-only literal or a full timestamp; null if unparseable. */
function calendarDayKey(value: string | Date): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return formatLocalDayKey(value);
  }
  // Date-only literal: preserve the authored calendar day exactly. Any leading
  // "YYYY-MM-DD" prefix is accepted so trailing time+zone components (rare but
  // possible if the field ever widens) do not shift the day.
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (match) {
    const [, y, m, d] = match;
    const year = Number(y);
    const month = Number(m);
    const day = Number(d);
    if (!isRealCalendarDate(year, month, day)) return null;
    return `${y}-${m}-${d}`;
  }
  // Fall back to parsing as a timestamp and reading the LOCAL calendar day.
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatLocalDayKey(parsed);
}

function formatLocalDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Compare `due_date` against `today` at local calendar-day granularity. */
export function isOverdue(
  item: Pick<MissingInfoItem, "status" | "due_date">,
  today: Date
): boolean {
  if (item.status !== "requested" && item.status !== "open") return false;
  if (!item.due_date) return false;
  const dueKey = calendarDayKey(item.due_date);
  if (!dueKey) return false;
  const todayKey = formatLocalDayKey(today);
  // Lexicographic comparison on zero-padded YYYY-MM-DD is equivalent to
  // calendar order.
  return dueKey < todayKey;
}

export function summariseMissingInfo(
  items: MissingInfoItem[],
  now: Date = new Date()
): MissingInfoSummary {
  const outstanding = items.filter((i) => i.status === "open").length;
  const awaiting_reply = items.filter((i) => i.status === "requested").length;
  const awaiting_review = items.filter((i) => i.status === "received").length;
  const closed = items.filter((i) => i.status === "waived" || i.status === "not_required").length;
  const overdue = items.filter((i) => isOverdue(i, now)).length;
  const active_owners = Array.from(
    new Set(
      items
        .filter((i) => i.status === "open" || i.status === "requested")
        .map((i) => i.owner)
    )
  );
  return { outstanding, awaiting_reply, awaiting_review, closed, overdue, active_owners };
}

/** Ordered lifecycle groups for the missing-information workbench. */
export interface MissingInfoGroup {
  key: "open" | "requested" | "received" | "closed";
  title: string;
  body: string;
  items: MissingInfoItem[];
}

export function groupMissingInfo(items: MissingInfoItem[]): MissingInfoGroup[] {
  const buckets: Record<MissingInfoGroup["key"], MissingInfoItem[]> = {
    open: [],
    requested: [],
    received: [],
    closed: [],
  };
  for (const item of items) {
    if (item.status === "open") buckets.open.push(item);
    else if (item.status === "requested") buckets.requested.push(item);
    else if (item.status === "received") buckets.received.push(item);
    else buckets.closed.push(item);
  }
  const all: MissingInfoGroup[] = [
    {
      key: "open",
      title: "Outstanding — not yet requested",
      body: "Identified by Atlas or by the team, but nobody has asked for them yet.",
      items: buckets.open,
    },
    {
      key: "requested",
      title: "Requested — awaiting a reply",
      body: "Already asked for. Follow up if the reply is overdue.",
      items: buckets.requested,
    },
    {
      key: "received",
      title: "Received — awaiting review",
      body: "Arrived but not yet acted on. Rerun the analysis if any of this changes the risk.",
      items: buckets.received,
    },
    {
      key: "closed",
      title: "Waived or not required",
      body: "Deliberately closed. The note explains why.",
      items: buckets.closed,
    },
  ];
  return all.filter((group) => group.items.length > 0);
}

export const NOTE_REQUIRED_STATUSES: readonly MissingInfoStatus[] = ["waived", "not_required"];

/**
 * Referral-pack readiness checks. The set and their required/recommended
 * treatment are unchanged from the previous panel; centralising it keeps the
 * distinction consistent and testable, so a visual redesign never quietly
 * demotes a required check to recommended.
 */
export interface ReadinessCheck {
  label: string;
  met: boolean;
  requirement: "required" | "recommended";
  why: string;
}

export function referralReadinessChecks(input: {
  extraction: ExtractionRecord | null;
  recommendation: Recommendation | null;
  quoteReview: QuoteReview | null;
  openMissing: number;
  activeDocumentCount: number;
}): ReadinessCheck[] {
  return [
    {
      label: "Risk information reviewed by a person",
      met: Boolean(input.extraction?.reviewed_json),
      requirement: "required",
      why: "The insurer will act on what you send. It must be confirmed, not an unreviewed extraction.",
    },
    {
      label: "Recommendation run against current information",
      met: Boolean(input.recommendation),
      requirement: "required",
      why: "The referral needs the appetite position it is asking the insurer to reconsider.",
    },
    {
      label: "Quote review complete",
      met: Boolean(input.quoteReview),
      requirement: "recommended",
      why: "The section findings tell the insurer exactly which terms are in question.",
    },
    {
      label: "No outstanding information",
      met: input.openMissing === 0,
      requirement: "recommended",
      why: "A pack sent with known gaps usually comes back with questions.",
    },
    {
      label: "Supporting documents on file",
      met: input.activeDocumentCount > 0,
      requirement: "required",
      why: "The insurer needs the schedules and claims experience behind the referral.",
    },
  ];
}

export function referralNeededFor(input: {
  recommendation: Recommendation | null;
  quoteReview: QuoteReview | null;
  decision: Decision | null;
}): boolean {
  return Boolean(
    input.recommendation?.referral_required ||
      input.quoteReview?.status === "refer" ||
      input.decision?.decision_choice === "refer"
  );
}

/* ---------------------------------------------------------------------------
   Communication draft catalogue
   ---------------------------------------------------------------------------
   The two draft sources — workflow drafts persisted through
   /submissions/:id/drafts/:type and email drafts persisted through the
   email-draft endpoint — remain distinct records. This catalogue makes the
   audience and purpose explicit next to each draft type without changing what
   the panel actually calls.
   ------------------------------------------------------------------------- */

export type WorkflowDraftType = "missing-info" | "referral-pack" | "quote-summary";
export type EmailDraftType =
  | "broker-missing-info"
  | "broker-acknowledgement"
  | "insurer-submission"
  | "internal-summary";

export interface DraftDescriptor {
  label: string;
  description: string;
  audience: string;
  purpose: string;
}

export const WORKFLOW_DRAFT_CATALOGUE: Record<WorkflowDraftType, DraftDescriptor> = {
  "missing-info": {
    label: "Outstanding information request",
    description: "Built from the tracked missing-information items.",
    audience: "Broker",
    purpose: "Ask for the outstanding items in one message.",
  },
  "referral-pack": {
    label: "Referral pack",
    description: "Assembles the risk summary, findings and mitigating factors for the insurer.",
    audience: "Senior underwriter or insurer",
    purpose: "Support a referral decision outside standard authority.",
  },
  "quote-summary": {
    label: "Quote review summary",
    description: "Summarises the review outcome and the conditions attached to it.",
    audience: "Broker",
    purpose: "Share the review outcome and any conditions.",
  },
};

export const EMAIL_DRAFT_CATALOGUE: Record<EmailDraftType, DraftDescriptor> = {
  "broker-missing-info": {
    label: "Request information from the broker",
    description: "Lists the outstanding items and why each one is needed.",
    audience: "Broker",
    purpose: "Chase the outstanding items with the person who owes them.",
  },
  "broker-acknowledgement": {
    label: "Acknowledge the submission",
    description: "Confirms receipt and sets expectations on timing.",
    audience: "Broker",
    purpose: "Confirm receipt and next steps.",
  },
  "insurer-submission": {
    label: "Submit to the insurer",
    description: "Presents the risk to the selected insurer.",
    audience: "Insurer",
    purpose: "Present the risk for quotation.",
  },
  "internal-summary": {
    label: "Internal handover summary",
    description: "Brings a colleague up to speed on the submission.",
    audience: "Colleague",
    purpose: "Hand over context to another person on the team.",
  },
};

/** Communication records grouped by lifecycle for the record list. */
export interface CommunicationGroup {
  key: "sent_manually" | "copied" | "draft" | "archived";
  title: string;
  items: CommunicationRecord[];
}

export function groupCommunications(records: CommunicationRecord[]): CommunicationGroup[] {
  const buckets: Record<CommunicationGroup["key"], CommunicationRecord[]> = {
    sent_manually: [],
    copied: [],
    draft: [],
    archived: [],
  };
  for (const record of records) {
    const key = (record.status as CommunicationGroup["key"]) in buckets
      ? (record.status as CommunicationGroup["key"])
      : "draft";
    buckets[key].push(record);
  }
  const all: CommunicationGroup[] = [
    { key: "sent_manually", title: "Recorded as sent", items: buckets.sent_manually },
    { key: "copied", title: "Copied — not yet recorded as sent", items: buckets.copied },
    { key: "draft", title: "Draft saved", items: buckets.draft },
    { key: "archived", title: "Archived", items: buckets.archived },
  ];
  return all.filter((group) => group.items.length > 0);
}

/** Number of active (non-closed) missing items linked to a record. */
export function countLinkedMissing(
  record: CommunicationRecord,
  activeIds: Set<string>
): number {
  const ids = record.related_missing_info_item_ids ?? [];
  let count = 0;
  for (const id of ids) if (activeIds.has(id)) count += 1;
  return count;
}

/** Distinct related section keys as a display string, or null. */
export function relatedSectionsLabel(record: CommunicationRecord): string | null {
  const keys = record.related_section_keys ?? [];
  if (keys.length === 0) return null;
  return keys.join(", ");
}

/** Convenience — `sections_by_review` and other helpers already export their own
 * types elsewhere; only re-export the types this file's public surface uses. */
export type { QuoteReviewSection };
