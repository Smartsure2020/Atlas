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
  const NOW = new Date("2026-08-15T12:00:00Z");

  it("returns false when there is no due date", () => {
    expect(isOverdue(item("requested"), NOW)).toBe(false);
  });

  it("returns true when a requested item's due date is strictly in the past", () => {
    expect(
      isOverdue(item("requested", { due_date: "2026-08-10" }), NOW)
    ).toBe(true);
  });

  it("returns false when the due date is today", () => {
    expect(
      isOverdue(item("requested", { due_date: "2026-08-15" }), NOW)
    ).toBe(false);
  });

  it("does not flag received, waived or not_required items as overdue", () => {
    for (const s of ["received", "waived", "not_required"] as MissingInfoStatus[]) {
      expect(isOverdue(item(s, { due_date: "2020-01-01" }), NOW)).toBe(false);
    }
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
