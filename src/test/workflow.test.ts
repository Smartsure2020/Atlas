/**
 * Workflow presentation helpers (Phase 4)
 * ----------------------------------------------------------------------------
 * Pure derivation logic behind the missing-information action summary,
 * lifecycle grouping, the deterministic overdue rule and the referral-pack
 * readiness check set. Kept separate from the panel tests so lifecycle
 * changes can be caught even before the panel renders anything.
 */

import { describe, expect, it } from "vitest";
import {
  countLinkedMissing,
  groupCommunications,
  groupMissingInfo,
  isOverdue,
  referralNeededFor,
  referralReadinessChecks,
  summariseMissingInfo,
} from "../lib/workflow";
import type {
  CommunicationRecord,
  MissingInfoItem,
  MissingInfoStatus,
} from "../lib/phase4";

function item(status: MissingInfoStatus, over: Partial<MissingInfoItem> = {}): MissingInfoItem {
  return {
    id: over.id ?? Math.random().toString(36),
    submission_id: "sub_1",
    quote_review_id: null,
    section_key: null,
    item_type: "underwriting_info",
    title: "t",
    description: null,
    status,
    required_by_rule_id: null,
    source: "extraction",
    owner: over.owner ?? "broker",
    due_date: over.due_date ?? null,
    notes: null,
    created_at: "2026-08-01T09:00:00Z",
    updated_at: "2026-08-01T09:00:00Z",
    resolved_at: null,
  };
}

function comm(status: CommunicationRecord["status"], over: Partial<CommunicationRecord> = {}): CommunicationRecord {
  return {
    id: over.id ?? Math.random().toString(36),
    submission_id: "sub_1",
    quote_review_id: null,
    communication_type: "other",
    audience: "broker",
    subject: null,
    body: "b",
    status,
    related_missing_info_item_ids: over.related_missing_info_item_ids ?? null,
    related_section_keys: over.related_section_keys ?? null,
    created_at: "2026-08-01T09:00:00Z",
    updated_at: "2026-08-01T09:00:00Z",
    sent_at: over.sent_at ?? null,
    notes: null,
  };
}

describe("summariseMissingInfo", () => {
  it("counts each lifecycle bucket separately", () => {
    const s = summariseMissingInfo([
      item("open"),
      item("open"),
      item("requested"),
      item("received"),
      item("received"),
      item("waived"),
      item("not_required"),
    ]);
    expect(s.outstanding).toBe(2);
    expect(s.awaiting_reply).toBe(1);
    expect(s.awaiting_review).toBe(2);
    expect(s.closed).toBe(2);
  });

  it("deduplicates active owners and ignores closed items", () => {
    const s = summariseMissingInfo([
      item("open", { owner: "broker" }),
      item("open", { owner: "broker" }),
      item("requested", { owner: "client" }),
      item("waived", { owner: "insurer" }),
    ]);
    expect(s.active_owners.sort()).toEqual(["broker", "client"]);
  });
});

describe("isOverdue", () => {
  // Construct explicitly in local time so tests are independent of the host
  // timezone offset — using `new Date("2026-08-15T12:00:00Z")` would resolve
  // to a different local calendar day west of the antimeridian.
  const NOW = new Date(2026, 7, 15, 12, 0); // 2026-08-15 12:00 local

  it("returns false when there is no due date", () => {
    expect(isOverdue(item("requested"), NOW)).toBe(false);
  });

  it("returns true when a requested item's due date is strictly in the past (yesterday)", () => {
    expect(
      isOverdue(item("requested", { due_date: "2026-08-14" }), NOW)
    ).toBe(true);
  });

  it("returns false when the due date is today's local calendar date", () => {
    expect(
      isOverdue(item("requested", { due_date: "2026-08-15" }), NOW)
    ).toBe(false);
  });

  it("returns false when the due date is tomorrow", () => {
    expect(
      isOverdue(item("requested", { due_date: "2026-08-16" }), NOW)
    ).toBe(false);
  });

  it("returns false for a malformed due_date string", () => {
    expect(
      isOverdue(item("requested", { due_date: "not-a-date" }), NOW)
    ).toBe(false);
    expect(
      isOverdue(item("requested", { due_date: "2026-13-40" }), NOW)
    ).toBe(false);
  });

  it("returns false for a well-formed but impossible calendar date", () => {
    // These literals pass the range check for month/day but name days that
    // do not exist on the Gregorian calendar. They must not be treated as
    // any real day — never overdue, never on-time — so downstream counts do
    // not silently include them.
    for (const impossible of ["2026-02-30", "2026-04-31", "2025-02-29"]) {
      expect(
        isOverdue(item("requested", { due_date: impossible }), NOW)
      ).toBe(false);
    }
  });

  it("accepts real calendar dates including leap-year Feb 29 and month-end", () => {
    // A due date strictly before today ⇒ overdue; strictly after ⇒ not.
    // 2024-02-29 exists (leap year); 2026-01-31 and 2026-12-31 are real
    // month-ends. Verify the validator lets each of them through.
    expect(
      isOverdue(item("requested", { due_date: "2024-02-29" }), NOW)
    ).toBe(true);
    expect(
      isOverdue(item("requested", { due_date: "2026-01-31" }), NOW)
    ).toBe(true);
    expect(
      isOverdue(item("requested", { due_date: "2026-12-31" }), NOW)
    ).toBe(false);
  });

  it("does not flag received, waived or not_required items as overdue", () => {
    for (const s of ["received", "waived", "not_required"] as MissingInfoStatus[]) {
      expect(isOverdue(item(s, { due_date: "2020-01-01" }), NOW)).toBe(false);
    }
  });

  it("treats YYYY-MM-DD literals as calendar-day values — no UTC shift", () => {
    // A `new Date("2026-08-15")` is midnight UTC. In a negative-offset locale
    // that resolves to 2026-08-14 local — an unrelated calendar day. The
    // policy is that the literal is the calendar day, full stop. Compare a
    // due date equal to today's literal at every hour of the local day.
    const literals = ["2026-08-15"];
    for (const literal of literals) {
      for (let h = 0; h < 24; h++) {
        const localTimeToday = new Date(2026, 7, 15, h, 30);
        expect(
          isOverdue(item("requested", { due_date: literal }), localTimeToday)
        ).toBe(false);
      }
    }
  });

  it("late evening and just-after-midnight local times on the due date are not overdue", () => {
    const dueToday = item("requested", { due_date: "2026-08-15" });
    const lateEvening = new Date(2026, 7, 15, 23, 59);
    const justAfterMidnight = new Date(2026, 7, 15, 0, 1);
    expect(isOverdue(dueToday, lateEvening)).toBe(false);
    expect(isOverdue(dueToday, justAfterMidnight)).toBe(false);
    // Rolling into the next local day flips it to overdue.
    const nextDayStart = new Date(2026, 7, 16, 0, 1);
    expect(isOverdue(dueToday, nextDayStart)).toBe(true);
  });
});

describe("summariseMissingInfo — overdue counts through the corrected helper", () => {
  const NOW = new Date(2026, 7, 15, 12, 0); // 2026-08-15 12:00 local

  it("only counts strictly-past requested/open items with a due date", () => {
    const items = [
      item("open", { due_date: "2026-08-14" }),       // overdue (yesterday, open)
      item("requested", { due_date: "2026-08-10" }), // overdue (past, requested)
      item("requested", { due_date: "2026-08-15" }), // today — NOT overdue
      item("requested", { due_date: "2026-08-16" }), // tomorrow — NOT overdue
      item("requested"),                              // no due date — NOT overdue
      item("received", { due_date: "2020-01-01" }),  // received — never overdue
      item("waived", { due_date: "2020-01-01" }),    // closed — never overdue
    ];
    const s = summariseMissingInfo(items, NOW);
    expect(s.overdue).toBe(2);
    // Lifecycle and owner counts are untouched by the overdue-policy fix.
    expect(s.outstanding).toBe(1);
    expect(s.awaiting_reply).toBe(4);
    expect(s.awaiting_review).toBe(1);
    expect(s.closed).toBe(1);
    expect(s.active_owners.sort()).toEqual(["broker"]);
  });

  it("day-boundary: a due date equal to today's local business date never counts", () => {
    const dueToday = item("requested", { due_date: "2026-08-15" });
    const lateEvening = new Date(2026, 7, 15, 23, 59);
    const justAfterMidnight = new Date(2026, 7, 15, 0, 1);
    expect(summariseMissingInfo([dueToday], lateEvening).overdue).toBe(0);
    expect(summariseMissingInfo([dueToday], justAfterMidnight).overdue).toBe(0);
  });

  it("ignores impossible calendar-date literals in the overdue count", () => {
    // 2026-02-30 does not exist. Even though it is strictly less than today's
    // key as a string, it must not contribute to the overdue count — the
    // validator drops it upstream of the comparison. A real strictly-past
    // date on the same item list is still counted, so we know the impossible
    // date was the only one excluded.
    const items = [
      item("requested", { due_date: "2026-02-30" }), // impossible — excluded
      item("requested", { due_date: "2026-08-10" }), // real, past — counted
    ];
    expect(summariseMissingInfo(items, NOW).overdue).toBe(1);
  });
});

describe("groupMissingInfo", () => {
  it("preserves lifecycle order and drops empty buckets", () => {
    const groups = groupMissingInfo([
      item("waived"),
      item("open"),
    ]);
    // Only open and closed are present, in that order.
    expect(groups.map((g) => g.key)).toEqual(["open", "closed"]);
  });
});

describe("referralReadinessChecks", () => {
  it("marks required and recommended checks per the fixed contract", () => {
    const checks = referralReadinessChecks({
      extraction: { id: "e", extracted_json: null, reviewed_json: {}, extraction_confidence: 0.9 } as never,
      recommendation: null,
      quoteReview: null,
      openMissing: 1,
      activeDocumentCount: 0,
    });
    const required = checks.filter((c) => c.requirement === "required").map((c) => c.label);
    const recommended = checks.filter((c) => c.requirement === "recommended").map((c) => c.label);
    expect(required).toContain("Risk information reviewed by a person");
    expect(required).toContain("Recommendation run against current information");
    expect(required).toContain("Supporting documents on file");
    expect(recommended).toContain("Quote review complete");
    expect(recommended).toContain("No outstanding information");
  });
});

describe("referralNeededFor", () => {
  it("triggers on any of the three signals", () => {
    expect(
      referralNeededFor({
        recommendation: { referral_required: true } as never,
        quoteReview: null,
        decision: null,
      })
    ).toBe(true);
    expect(
      referralNeededFor({
        recommendation: null,
        quoteReview: { status: "refer" } as never,
        decision: null,
      })
    ).toBe(true);
    expect(
      referralNeededFor({
        recommendation: null,
        quoteReview: null,
        decision: { decision_choice: "refer" } as never,
      })
    ).toBe(true);
  });

  it("returns false when nothing signals referral", () => {
    expect(
      referralNeededFor({
        recommendation: null,
        quoteReview: null,
        decision: null,
      })
    ).toBe(false);
  });
});

describe("groupCommunications", () => {
  it("groups records by status in the documented order", () => {
    const groups = groupCommunications([
      comm("draft"),
      comm("sent_manually"),
      comm("copied"),
      comm("archived"),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["sent_manually", "copied", "draft", "archived"]);
  });

  it("omits empty groups", () => {
    const groups = groupCommunications([comm("draft")]);
    expect(groups.map((g) => g.key)).toEqual(["draft"]);
  });
});

describe("countLinkedMissing", () => {
  it("only counts items still in the active set", () => {
    const activeIds = new Set(["a", "b"]);
    const record = comm("draft", { related_missing_info_item_ids: ["a", "c", "b"] });
    expect(countLinkedMissing(record, activeIds)).toBe(2);
  });

  it("handles null related-items lists", () => {
    expect(countLinkedMissing(comm("draft"), new Set())).toBe(0);
  });
});
