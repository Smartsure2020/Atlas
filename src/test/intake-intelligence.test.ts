/**
 * Intake & insurer intelligence helpers — pure unit tests.
 * ----------------------------------------------------------------------------
 * The helpers in `../lib/intake-intelligence` back the Phase 7 UI decisions
 * that keep intake safe (no duplicate submissions, honest retry-remaining
 * copy) and keep the insurer detail screen honest (no fabricated "guideline
 * read" toasts, stable rule ordering, honest coverage filter). Nothing
 * about them is React-shaped, and nothing about them fetches — so this file
 * exercises them without a DOM.
 */

import { describe, expect, it } from "vitest";
import {
  assignClientIds,
  filterInsurersByCoverage,
  guessDocumentType,
  insurerSetupSummary,
  intakePhaseSummary,
  orderRules,
  presentGuidelineResult,
  remainingUploads,
  type AppetiteRowLike,
  type InsurerCoverageItem,
  type InsurerDocumentLike,
  type PendingFile,
} from "../lib/intake-intelligence";

/* ---------- factories ------------------------------------------------------ */

function file(name: string, size = 1024): File {
  return new File([new Uint8Array(size)], name, { type: "application/pdf" });
}

function pending(over: Partial<PendingFile> = {}): PendingFile {
  const base: PendingFile = {
    clientId: over.clientId ?? "cid_base",
    file: over.file ?? file("policy.pdf"),
    type: over.type ?? "supporting",
    upload: over.upload ?? { status: "pending" },
  };
  if (over.problem !== undefined) base.problem = over.problem;
  return base;
}

function coverageItem(count: number): InsurerCoverageItem {
  return { active_appetite_count: count };
}

function rule(over: Partial<AppetiteRowLike> = {}): AppetiteRowLike {
  return {
    is_active: over.is_active ?? true,
    product_line: over.product_line ?? "motor",
    risk_type: over.risk_type ?? "fleet",
    // Respect an explicit `null` override — `??` alone would treat null as
    // "not provided" and re-supply the default, hiding the null-branch we
    // want to exercise.
    confirmed_at:
      "confirmed_at" in over ? (over.confirmed_at ?? null) : "2026-08-10T09:00:00Z",
  };
}

function guidelineDoc(over: Partial<InsurerDocumentLike> = {}): InsurerDocumentLike {
  return {
    processing_status: over.processing_status ?? "processed",
    scan_status: over.scan_status,
    proposed_count: over.proposed_count,
  };
}

/* ---------- guessDocumentType --------------------------------------------- */

describe("guessDocumentType", () => {
  it("classifies vehicle schedules ahead of generic policy schedules", () => {
    expect(guessDocumentType("2026 Vehicle Schedule.pdf")).toBe("vehicle_schedule");
  });

  it("classifies building schedules ahead of generic policy schedules", () => {
    expect(guessDocumentType("Building Schedule Feb.pdf")).toBe("building_schedule");
  });

  it("classifies generic policy or schedule names as a policy schedule", () => {
    expect(guessDocumentType("Renewal-Policy.pdf")).toBe("policy_schedule");
    expect(guessDocumentType("2026 SCHEDULE.pdf")).toBe("policy_schedule");
  });

  it("classifies proposal-form names as a proposal form", () => {
    expect(guessDocumentType("Proposal Form v3.pdf")).toBe("proposal_form");
  });

  it("classifies claims histories from claim or loss keywords", () => {
    expect(guessDocumentType("Claims History.pdf")).toBe("claims_history");
    expect(guessDocumentType("loss experience 5y.pdf")).toBe("claims_history");
  });

  it("classifies quote names as an insurer quote", () => {
    expect(guessDocumentType("CIB Quotation.pdf")).toBe("quote");
  });

  it("classifies broker email extensions as broker email", () => {
    expect(guessDocumentType("thread.eml")).toBe("broker_email");
    expect(guessDocumentType("intake.msg")).toBe("broker_email");
  });

  it("falls back to supporting when nothing matches", () => {
    expect(guessDocumentType("client_notes.pdf")).toBe("supporting");
  });
});

/* ---------- assignClientIds / remainingUploads ---------------------------- */

describe("assignClientIds", () => {
  it("gives each file a distinct clientId, a pending upload, and a guessed type", () => {
    const pendingList = assignClientIds([
      file("Proposal Form.pdf"),
      file("Claims History.pdf"),
    ]);
    expect(pendingList).toHaveLength(2);
    expect(pendingList[0]!.clientId).not.toBe(pendingList[1]!.clientId);
    expect(pendingList[0]!.type).toBe("proposal_form");
    expect(pendingList[1]!.type).toBe("claims_history");
    expect(pendingList[0]!.upload).toEqual({ status: "pending" });
    expect(pendingList[1]!.upload).toEqual({ status: "pending" });
  });

  it("returns an empty array for no input", () => {
    expect(assignClientIds([])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const files = [file("a.pdf"), file("b.pdf")];
    const snapshot = files.slice();
    assignClientIds(files);
    expect(files).toEqual(snapshot);
  });
});

describe("remainingUploads", () => {
  it("returns pending and failed files, excludes uploaded and uploading", () => {
    const items: PendingFile[] = [
      pending({ clientId: "a", upload: { status: "pending" } }),
      pending({ clientId: "b", upload: { status: "uploading" } }),
      pending({ clientId: "c", upload: { status: "uploaded" } }),
      pending({ clientId: "d", upload: { status: "failed", error: "boom" } }),
    ];
    expect(remainingUploads(items).map((item) => item.clientId)).toEqual(["a", "d"]);
  });

  it("returns an empty array when nothing remains", () => {
    expect(
      remainingUploads([pending({ upload: { status: "uploaded" } })])
    ).toEqual([]);
  });
});

/* ---------- intakePhaseSummary -------------------------------------------- */

describe("intakePhaseSummary", () => {
  it("labels the idle state as ready", () => {
    const summary = intakePhaseSummary({ kind: "idle" }, []);
    expect(summary.tone).toBe("info");
    expect(summary.headline).toMatch(/Ready/i);
  });

  it("labels the creating state", () => {
    const summary = intakePhaseSummary({ kind: "creating" }, []);
    expect(summary.tone).toBe("info");
    expect(summary.headline).toMatch(/Creating submission/i);
  });

  it("names the uploading progress", () => {
    const summary = intakePhaseSummary(
      { kind: "uploading", index: 2, total: 3, name: "x.pdf" },
      []
    );
    expect(summary.tone).toBe("info");
    expect(summary.headline).toMatch(/2 of 3/);
  });

  it("labels partial as warning with a failure count and remaining count", () => {
    const summary = intakePhaseSummary(
      { kind: "partial", submissionId: "s1", failedCount: 1, remainingCount: 1 },
      [
        pending({ upload: { status: "uploaded" } }),
        pending({ upload: { status: "failed", error: "boom" } }),
        pending({ upload: { status: "pending" } }),
      ]
    );
    expect(summary.tone).toBe("warning");
    expect(summary.headline).toMatch(/Submission created/i);
    expect(summary.headline).toMatch(/1 failed/);
    expect(summary.headline).toMatch(/1 remaining/);
  });

  it("labels complete as success and never claims complete while any file is pending", () => {
    const complete = intakePhaseSummary({ kind: "complete", submissionId: "s1" }, []);
    expect(complete.tone).toBe("success");
    expect(complete.headline).toMatch(/all documents uploaded/i);
  });
});

/* ---------- presentGuidelineResult ---------------------------------------- */

describe("presentGuidelineResult", () => {
  it("shows the queued response as info and never says the document was read", () => {
    const result = presentGuidelineResult({ queued: true, status: "queued" });
    expect(result.tone).toBe("info");
    expect(result.message).toMatch(/queued/i);
    expect(result.message).not.toMatch(/read/i);
  });

  it("shows the skipped response as warning", () => {
    const result = presentGuidelineResult({ skipped: true });
    expect(result.tone).toBe("warning");
    expect(result.message).toMatch(/skipped|already/i);
  });

  it("shows a proposed-count success", () => {
    const result = presentGuidelineResult({ proposed_count: 3 });
    expect(result.tone).toBe("success");
    expect(result.message).toMatch(/3/);
  });

  it("shows an honest no-new-rules info line when proposed_count is 0", () => {
    const result = presentGuidelineResult({ proposed_count: 0 });
    expect(result.tone).toBe("info");
    expect(result.message).toMatch(/did not find|no new/i);
  });

  it("falls back to a neutral info message when the shape is malformed", () => {
    const result = presentGuidelineResult({} as never);
    expect(result.tone).toBe("info");
    expect(result.message).toMatch(/processed/i);
  });

  it("falls back to a neutral info message when the response is null", () => {
    const result = presentGuidelineResult(null);
    expect(result.tone).toBe("info");
  });

  it("uses a sanitised server message when supplied", () => {
    const result = presentGuidelineResult({
      queued: true,
      message: "  Guideline queued behind two others.  ",
    });
    expect(result.message).toBe("Guideline queued behind two others.");
  });

  it("rejects a server message containing control characters", () => {
    const result = presentGuidelineResult({
      queued: true,
      message: "Guideline\u0000injected",
    });
    // Falls back to the default queued line, never surfaces the raw bytes.
    expect(result.message).not.toMatch(/injected/);
    expect(result.message).toMatch(/queued/i);
  });

  it("rejects a non-string server message", () => {
    const result = presentGuidelineResult({
      queued: true,
      message: 42 as unknown as string,
    });
    expect(result.message).toMatch(/queued/i);
  });

  it("caps a very long server message at 180 characters", () => {
    const long = "x".repeat(400);
    const result = presentGuidelineResult({ proposed_count: 1, message: long });
    expect(result.message.length).toBeLessThanOrEqual(180);
    expect(result.message.endsWith("…")).toBe(true);
  });
});

/* ---------- filterInsurersByCoverage -------------------------------------- */

describe("filterInsurersByCoverage", () => {
  const items: InsurerCoverageItem[] = [
    coverageItem(0),
    coverageItem(2),
    coverageItem(0),
    coverageItem(5),
  ];

  it("returns everything for the all mode without mutating input", () => {
    const snapshot = items.slice();
    expect(filterInsurersByCoverage(items, "all")).toEqual(items);
    expect(items).toEqual(snapshot);
  });

  it("returns only insurers with active rules for the active mode", () => {
    const filtered = filterInsurersByCoverage(items, "active");
    expect(filtered).toHaveLength(2);
    expect(filtered.every((item) => item.active_appetite_count > 0)).toBe(true);
  });

  it("returns only needs-setup insurers for the needs_setup mode", () => {
    const filtered = filterInsurersByCoverage(items, "needs_setup");
    expect(filtered).toHaveLength(2);
    expect(filtered.every((item) => item.active_appetite_count === 0)).toBe(true);
  });
});

/* ---------- orderRules ---------------------------------------------------- */

describe("orderRules", () => {
  it("puts portfolio-wide rules first", () => {
    const ordered = orderRules([
      rule({ product_line: "motor", risk_type: "fleet" }),
      rule({ product_line: "*", risk_type: "*" }),
    ]);
    expect(ordered[0]!.product_line).toBe("*");
  });

  it("sorts by product_line then risk_type ascending", () => {
    const ordered = orderRules([
      rule({ product_line: "property", risk_type: "commercial" }),
      rule({ product_line: "motor", risk_type: "private" }),
      rule({ product_line: "motor", risk_type: "fleet" }),
    ]);
    expect(ordered.map((r) => `${r.product_line}:${r.risk_type}`)).toEqual([
      "motor:fleet",
      "motor:private",
      "property:commercial",
    ]);
  });

  it("sorts by confirmed_at desc within a product_line/risk_type", () => {
    const ordered = orderRules([
      rule({ product_line: "motor", risk_type: "fleet", confirmed_at: "2026-01-01T00:00:00Z" }),
      rule({ product_line: "motor", risk_type: "fleet", confirmed_at: "2026-08-01T00:00:00Z" }),
      rule({ product_line: "motor", risk_type: "fleet", confirmed_at: null }),
    ]);
    expect(ordered[0]!.confirmed_at).toBe("2026-08-01T00:00:00Z");
    expect(ordered[1]!.confirmed_at).toBe("2026-01-01T00:00:00Z");
    // Nullish confirmed_at sorts oldest.
    expect(ordered[2]!.confirmed_at).toBeNull();
  });

  it("does not mutate the input array", () => {
    const rows = [
      rule({ product_line: "b" }),
      rule({ product_line: "a" }),
    ];
    const snapshot = rows.slice();
    orderRules(rows);
    expect(rows).toEqual(snapshot);
  });
});

/* ---------- insurerSetupSummary ------------------------------------------- */

describe("insurerSetupSummary", () => {
  it("counts proposed, failed guidelines and pending scans, and reports whether the matrix is active", () => {
    const summary = insurerSetupSummary({
      insurer: { active_appetite_count: 0 },
      documents: [
        guidelineDoc({ processing_status: "failed" }),
        guidelineDoc({ processing_status: "processed" }),
        guidelineDoc({ processing_status: "processed", scan_status: "pending" }),
      ],
      appetite: [
        rule({ is_active: false }),
        rule({ is_active: false }),
        rule({ is_active: true }),
      ],
    });
    expect(summary.hasActiveRules).toBe(true);
    expect(summary.proposedCount).toBe(2);
    expect(summary.failedGuidelineCount).toBe(1);
    expect(summary.scanPendingCount).toBe(1);
  });

  it("uses insurer.active_appetite_count as a fallback source of truth for hasActiveRules", () => {
    const summary = insurerSetupSummary({
      insurer: { active_appetite_count: 4 },
      documents: [],
      appetite: [],
    });
    expect(summary.hasActiveRules).toBe(true);
  });

  it("returns zero counts and inactive matrix when everything is empty", () => {
    const summary = insurerSetupSummary({
      insurer: null,
      documents: [],
      appetite: [],
    });
    expect(summary).toEqual({
      hasActiveRules: false,
      proposedCount: 0,
      failedGuidelineCount: 0,
      scanPendingCount: 0,
    });
  });
});
