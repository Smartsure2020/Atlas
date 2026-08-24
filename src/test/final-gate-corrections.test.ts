/**
 * Atlas — final product-gate corrections (unit-level coverage)
 * ----------------------------------------------------------------------------
 * Pure-function coverage for the "safety and workflow" corrections that do
 * not require rendering. Component/DOM behaviour lives alongside the
 * existing workbench test files (processing-jobs, communications, missing-
 * information, manager-oversight, insurer-index, work-queue, new-submission,
 * submission-documents, smoke).
 *
 * Contents:
 *   - redactJobMetadata: allow-list + secret-shape scrubbing + length cap
 *   - confidenceBand: reviewed does NOT promote a field the pipeline
 *     itself marked as low-confidence-extracted / conflicting / unclear
 *   - groupDocuments: scan_failed is its own bucket, above active
 *   - exceptionMetrics: "Recent reviews shown below" carries the
 *     period_capped scope (the tile value is a cap, not a real total)
 *   - safety-copy constant: the single canonical Atlas safety phrase
 */

import { describe, expect, it } from "vitest";
import {
  groupDocuments,
  redactJobMetadata,
  type DocumentRow,
} from "../lib/operations-evidence";
import { confidenceBand, ATLAS_NEVER_SENDS_MESSAGE } from "../lib/status";
import { exceptionMetrics } from "../lib/oversight";
import type { ManagerStats } from "../lib/phase4";

/* -------------------------------------------------------------------------- */
/* redactJobMetadata                                                           */
/* -------------------------------------------------------------------------- */

describe("redactJobMetadata", () => {
  it("returns null when metadata is empty", () => {
    expect(redactJobMetadata(null)).toBeNull();
    expect(redactJobMetadata(undefined)).toBeNull();
    expect(redactJobMetadata({})).toBeNull();
  });

  it("keeps only allow-listed keys and drops everything else silently", () => {
    const rendered = redactJobMetadata({
      step: "extract",
      document_id: "doc_1",
      retry_count: 2,
      raw_prompt: "You are an underwriting assistant. Read…",
      request_body: { hello: "world" },
    });
    expect(rendered).not.toBeNull();
    const parsed = JSON.parse(rendered!);
    expect(parsed).toEqual({ step: "extract", document_id: "doc_1", retry_count: 2 });
    expect(rendered).not.toContain("raw_prompt");
    expect(rendered).not.toContain("underwriting assistant");
    expect(rendered).not.toContain("request_body");
  });

  it("returns null if nothing on the allow-list survives", () => {
    expect(
      redactJobMetadata({
        raw_prompt: "…",
        upstream_response: { tokens: 1234 },
      })
    ).toBeNull();
  });

  it("scrubs JWT-shaped values even inside allow-listed keys", () => {
    // step is on the allow-list, but if a Worker ever writes a JWT into
    // it we still redact — the shape wins over the key.
    const rendered = redactJobMetadata({
      step: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop",
      reason: "step_finished",
    });
    expect(rendered).toContain("[redacted]");
    expect(rendered).toContain("step_finished");
    expect(rendered).not.toContain("eyJhbGciOi");
  });

  it("scrubs Bearer / Basic auth headers embedded in allow-listed values", () => {
    const rendered = redactJobMetadata({
      reason: "Bearer 1234567890abcdefghijklmnopqrstuvwx tried but failed",
    });
    expect(rendered).toContain("[redacted]");
    expect(rendered).not.toContain("1234567890abcdefghij");
  });

  it("drops keys whose name identifies them as sensitive, even nested", () => {
    const rendered = redactJobMetadata({
      status: {
        api_key: "abc123-key-should-not-appear",
        token: "xyz.jwt.token",
        step: "ok",
      },
    });
    expect(rendered).toContain("[redacted]");
    expect(rendered).not.toContain("abc123-key-should-not-appear");
    expect(rendered).not.toContain("xyz.jwt.token");
  });

  it("truncates a runaway payload rather than filling the drawer", () => {
    const noisy = "x".repeat(50_000);
    const rendered = redactJobMetadata({
      // Allow-listed key + oversized string; scrubValue trims strings at
      // 200 chars, but a huge object of allow-listed strings still gets
      // capped by the outer render limit.
      step: noisy,
      reason: noisy,
      current_step: noisy,
      stage: noisy,
      phase: noisy,
      status: noisy,
    });
    expect(rendered).not.toBeNull();
    expect(rendered!.length).toBeLessThan(10_000);
  });

  it("scrubs URLs that carry authentication material", () => {
    const rendered = redactJobMetadata({
      reason: "downloaded https://cdn.example/storage?signature=abc123def456ghi789jkl012 successfully",
    });
    expect(rendered).toContain("[redacted]");
    expect(rendered).not.toContain("signature=abc123def456");
  });
});

/* -------------------------------------------------------------------------- */
/* confidenceBand ordering — reviewed must not promote a flagged field         */
/* -------------------------------------------------------------------------- */

describe("confidenceBand", () => {
  it("does not promote a low_confidence_extracted field when the submission was reviewed", () => {
    // A field the pipeline itself flagged as low-confidence stays uncertain
    // even after a reviewer clicks Save Review on the submission.
    // The reviewer flag is submission-level; per-field provenance is not
    // yet tracked, so a submission-level review cannot silently confirm
    // per-field uncertainty.
    expect(confidenceBand("low_confidence_extracted", 0.15, true).band).toBe("uncertain");
  });

  it("keeps conflicting / unclear / not_found decisive even when reviewed", () => {
    expect(confidenceBand("conflicting", 0.9, true).band).toBe("conflicting");
    expect(confidenceBand("unclear", 0.9, true).band).toBe("uncertain");
    expect(confidenceBand("not_found", 0.9, true).band).toBe("missing");
  });

  it("promotes an otherwise-ambiguous field to confirmed when reviewed", () => {
    // A field with no decisive status and modest confidence is a plausible
    // promotion target — the reviewer's Save Review still confirms it.
    expect(confidenceBand(null, 0.4, true).band).toBe("confirmed");
    expect(confidenceBand("ok", 0.4, true).band).toBe("confirmed");
  });

  it("high confidence still maps to confirmed without a review", () => {
    expect(confidenceBand(null, 0.95, false).band).toBe("confirmed");
  });
});

/* -------------------------------------------------------------------------- */
/* groupDocuments — scan_failed bucket                                         */
/* -------------------------------------------------------------------------- */

describe("groupDocuments — scan_failed bucket", () => {
  function doc(over: Partial<DocumentRow>): DocumentRow {
    return {
      id: `doc_${Math.random().toString(36).slice(2, 8)}`,
      file_name: over.file_name ?? "file.pdf",
      status: over.status ?? "active",
      scan_status: over.scan_status ?? "clean",
      created_at: "2026-08-01T09:00:00Z",
      expires_at: null,
      ...over,
    };
  }

  it("puts scan_status=failed into its own bucket, not into active", () => {
    const groups = groupDocuments([
      doc({ id: "a", scan_status: "clean" }),
      doc({ id: "b", scan_status: "failed" }),
      doc({ id: "c", scan_status: "clean" }),
    ]);
    const active = groups.find((g) => g.key === "active")!;
    const scanFailed = groups.find((g) => g.key === "scan_failed")!;
    expect(scanFailed.documents.map((d) => d.id)).toEqual(["b"]);
    expect(active.documents.map((d) => d.id)).toEqual(["a", "c"]);
  });

  it("renders scan_failed before active in the returned group order", () => {
    const groups = groupDocuments([]);
    const keys = groups.map((g) => g.key);
    expect(keys.indexOf("scan_failed")).toBeLessThan(keys.indexOf("active"));
  });

  it("quarantine wins over scan_failed", () => {
    const groups = groupDocuments([
      doc({ id: "q", scan_status: "infected" }),
      doc({ id: "f", scan_status: "failed" }),
    ]);
    const quarantined = groups.find((g) => g.key === "quarantined")!;
    const scanFailed = groups.find((g) => g.key === "scan_failed")!;
    expect(quarantined.documents.map((d) => d.id)).toEqual(["q"]);
    expect(scanFailed.documents.map((d) => d.id)).toEqual(["f"]);
  });

  it("expired scan_failed doc lands in expired, not scan_failed", () => {
    const groups = groupDocuments([
      doc({ id: "x", scan_status: "failed", status: "expired" }),
    ]);
    expect(groups.find((g) => g.key === "expired")!.documents.map((d) => d.id)).toEqual(["x"]);
    expect(groups.find((g) => g.key === "scan_failed")!.documents).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* exceptionMetrics — Recent reviews shown below carries period_capped scope    */
/* -------------------------------------------------------------------------- */

describe("exceptionMetrics — Recent reviews shown below (period_capped)", () => {
  function stats(over: Partial<ManagerStats> = {}): ManagerStats {
    return {
      total_submissions: 0,
      quote_reviews_completed: 0,
      reviews_by_status: {},
      missing_info_open_count: 0,
      referrals_count: 0,
      declined_count: 0,
      overrides_count: 0,
      communications_generated_count: 0,
      communications_sent_manually_count: 0,
      common_missing_information: [],
      common_referral_triggers: [],
      common_declined_reasons: [],
      recent_reviews_needing_attention: [],
      ...over,
    };
  }

  it("renames the tile to 'Recent reviews shown below' and tags it period_capped", () => {
    const metrics = exceptionMetrics(stats());
    const attention = metrics.find((m) => m.key === "attention")!;
    expect(attention).toBeDefined();
    expect(attention.label).toBe("Recent reviews shown below");
    expect(attention.scope).toBe("period_capped");
    // The hint still names the cap so a reader always knows why the
    // number stops at 10.
    expect(attention.hint).toMatch(/Capped at the ten most recent/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Canonical safety-copy constant                                              */
/* -------------------------------------------------------------------------- */

describe("ATLAS_NEVER_SENDS_MESSAGE", () => {
  it("exposes a single canonical Atlas safety statement", () => {
    // A governance-critical claim needs one canonical wording. Both
    // Communications and Manager overview read from this constant now.
    expect(ATLAS_NEVER_SENDS_MESSAGE).toBe("Atlas never sends anything itself");
  });
});
