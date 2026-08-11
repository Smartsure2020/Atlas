/**
 * Atlas — extraction confidence resolver tests
 * ----------------------------------------------------------------------------
 * Guards the four semantic scenarios that must never blur together:
 * provider-rated zero, unavailable, legacy-with-number, not recorded. Numeric
 * truthiness fallbacks are explicitly banned; the "70% ghost" is banned; every
 * malformed input must fail closed rather than silently invent a rating.
 */

import { describe, expect, it } from "vitest";
import {
  formatExtractionConfidence,
  resolveExtractionConfidence,
  type ExtractionRecordLike,
} from "../lib/extraction-confidence";

function record(input: Partial<ExtractionRecordLike>): ExtractionRecordLike {
  return {
    extracted_json: input.extracted_json ?? null,
    reviewed_json: input.reviewed_json ?? null,
    extraction_confidence: input.extraction_confidence ?? null,
  };
}

describe("resolveExtractionConfidence — availability semantics", () => {
  it("returns available for a provider-rated 0 with available=true", () => {
    const state = resolveExtractionConfidence(
      record({
        extracted_json: {
          overall_confidence: 0,
          overall_confidence_available: true,
          overall_confidence_source: "provider",
        },
      })
    );
    expect(state.state).toBe("available");
    if (state.state === "available") {
      expect(state.value).toBe(0);
      expect(state.source).toBe("provider");
      expect(state.available).toBe(true);
    }
  });

  it("returns available for a provider-rated 0.4 with available=true", () => {
    const state = resolveExtractionConfidence(
      record({
        extracted_json: {
          overall_confidence: 0.4,
          overall_confidence_available: true,
          overall_confidence_source: "provider",
        },
      })
    );
    expect(state.state).toBe("available");
    if (state.state === "available") {
      expect(state.value).toBe(0.4);
    }
  });

  it("returns unavailable when explicit flag=false, even with column 0 present", () => {
    const state = resolveExtractionConfidence(
      record({
        extracted_json: {
          overall_confidence: 0,
          overall_confidence_available: false,
          overall_confidence_source: "unavailable",
        },
        extraction_confidence: 0,
      })
    );
    expect(state.state).toBe("unavailable");
    if (state.state === "unavailable") {
      expect(state.value).toBeNull();
    }
  });

  it("reviewed explicit unavailable wins outright", () => {
    const state = resolveExtractionConfidence(
      record({
        reviewed_json: {
          overall_confidence: 0.8,
          overall_confidence_available: false,
        },
        extracted_json: { overall_confidence: 0.9, overall_confidence_available: true },
      })
    );
    expect(state.state).toBe("unavailable");
  });

  it("reviewed explicit available=true with valid zero wins over extracted", () => {
    const state = resolveExtractionConfidence(
      record({
        reviewed_json: { overall_confidence: 0, overall_confidence_available: true },
        extracted_json: { overall_confidence: 0.9, overall_confidence_available: true },
      })
    );
    expect(state.state).toBe("available");
    if (state.state === "available") {
      expect(state.value).toBe(0);
      expect(state.source).toBe("reviewed");
    }
  });

  it("reviewed number with extracted explicit unavailable and no reviewed override → unavailable", () => {
    const state = resolveExtractionConfidence(
      record({
        reviewed_json: { overall_confidence: 0.7 },
        extracted_json: { overall_confidence: 0, overall_confidence_available: false },
      })
    );
    expect(state.state).toBe("unavailable");
  });

  it("reviewed number with extracted explicit unavailable but reviewer explicitly true → available", () => {
    const state = resolveExtractionConfidence(
      record({
        reviewed_json: { overall_confidence: 0.7, overall_confidence_available: true },
        extracted_json: { overall_confidence: 0, overall_confidence_available: false },
      })
    );
    expect(state.state).toBe("available");
    if (state.state === "available") {
      expect(state.value).toBe(0.7);
      expect(state.source).toBe("reviewed");
    }
  });

  it("extracted available number without a flag", () => {
    const state = resolveExtractionConfidence(
      record({
        extracted_json: { overall_confidence: 0.55, overall_confidence_source: "provider" },
      })
    );
    expect(state.state).toBe("available");
    if (state.state === "available") {
      expect(state.value).toBeCloseTo(0.55);
      expect(state.source).toBe("provider");
    }
  });

  it("legacy: valid compat column, no flags anywhere", () => {
    const state = resolveExtractionConfidence(
      record({ extraction_confidence: 0.42 })
    );
    expect(state.state).toBe("available");
    if (state.state === "available") {
      expect(state.value).toBeCloseTo(0.42);
      expect(state.source).toBe("legacy");
    }
  });

  it("legacy: no number, no flags → not_recorded (NEVER 0.7)", () => {
    const state = resolveExtractionConfidence(
      record({ extracted_json: {}, reviewed_json: {} })
    );
    expect(state.state).toBe("not_recorded");
    // Explicitly guard against the ghost 0.7 fallback.
    if (state.state === "not_recorded") {
      expect(state.value).toBeNull();
    }
  });

  it("null extraction → not_recorded", () => {
    const state = resolveExtractionConfidence(null);
    expect(state.state).toBe("not_recorded");
  });
});

describe("resolveExtractionConfidence — malformed numbers are rejected", () => {
  it("NaN as overall_confidence falls through to not_recorded", () => {
    const state = resolveExtractionConfidence(
      record({ extracted_json: { overall_confidence: NaN } })
    );
    expect(state.state).toBe("not_recorded");
  });

  it("Infinity is rejected", () => {
    const state = resolveExtractionConfidence(
      record({ extracted_json: { overall_confidence: Infinity } })
    );
    expect(state.state).toBe("not_recorded");
  });

  it("negative numbers are rejected", () => {
    const state = resolveExtractionConfidence(
      record({ extracted_json: { overall_confidence: -0.5 } })
    );
    expect(state.state).toBe("not_recorded");
  });

  it("values > 1 are rejected", () => {
    const state = resolveExtractionConfidence(
      record({ extracted_json: { overall_confidence: 1.4 } })
    );
    expect(state.state).toBe("not_recorded");
  });

  it("legacy column NaN is rejected", () => {
    const state = resolveExtractionConfidence(record({ extraction_confidence: NaN }));
    expect(state.state).toBe("not_recorded");
  });

  it("malformed source string does not override explicit availability", () => {
    // "unavailable" as a source string alone must not flip a value that
    // was explicitly marked available.
    const state = resolveExtractionConfidence(
      record({
        extracted_json: {
          overall_confidence: 0.6,
          overall_confidence_available: true,
          overall_confidence_source: "gibberish",
        },
      })
    );
    expect(state.state).toBe("available");
    if (state.state === "available") {
      expect(state.value).toBeCloseTo(0.6);
      expect(state.source).toBe("provider");
    }
  });
});

describe("formatExtractionConfidence — display rules", () => {
  it("unavailable never formats as 0%", () => {
    const formatted = formatExtractionConfidence({
      state: "unavailable",
      value: null,
      source: "unavailable",
      available: false,
    });
    expect(formatted.headline).toBe("Unavailable");
    expect(formatted.hasPercent).toBe(false);
    expect(formatted.headline).not.toMatch(/\d/);
  });

  it("provider zero renders as 0%", () => {
    const formatted = formatExtractionConfidence({
      state: "available",
      value: 0,
      source: "provider",
      available: true,
    });
    expect(formatted.headline).toBe("0%");
    expect(formatted.provenance).toMatch(/provider/i);
    expect(formatted.hasPercent).toBe(true);
  });

  it("provider 0.4 rounds to 40%", () => {
    const formatted = formatExtractionConfidence({
      state: "available",
      value: 0.4,
      source: "provider",
      available: true,
    });
    expect(formatted.headline).toBe("40%");
  });

  it("legacy value carries a legacy provenance label", () => {
    const formatted = formatExtractionConfidence({
      state: "available",
      value: 0.5,
      source: "legacy",
      available: true,
    });
    expect(formatted.provenance).toMatch(/legacy/i);
  });

  it("not_recorded renders as Not recorded and no fallback percentage anywhere", () => {
    const formatted = formatExtractionConfidence({
      state: "not_recorded",
      value: null,
      source: "legacy",
      available: null,
    });
    expect(formatted.headline).toBe("Not recorded");
    // Guarantees the 70% ghost never appears in any format string.
    expect(formatted.headline).not.toMatch(/70/);
    expect(formatted.explanation).not.toMatch(/70/);
  });
});

describe("resolveExtractionConfidence — crossed reviewed/provenance input (M2)", () => {
  it("extracted-only row with source='reviewed' but no reviewed_json resolves as provider", () => {
    const state = resolveExtractionConfidence(
      record({
        extracted_json: {
          overall_confidence: 0.6,
          overall_confidence_available: true,
          overall_confidence_source: "reviewed",
        },
        reviewed_json: null,
      })
    );
    expect(state.state).toBe("available");
    if (state.state === "available") {
      expect(state.source).toBe("provider");
    }
  });

  it("extracted-only row with source='reviewed' and empty reviewed_json {} resolves as provider", () => {
    const state = resolveExtractionConfidence(
      record({
        extracted_json: {
          overall_confidence: 0.6,
          overall_confidence_available: true,
          overall_confidence_source: "reviewed",
        },
        reviewed_json: {},
      })
    );
    expect(state.state).toBe("available");
    if (state.state === "available") {
      expect(state.source).toBe("provider");
    }
  });

  it("extracted row with source='reviewed' AND a real reviewed_json still resolves via the reviewed number branch", () => {
    // When a reviewer really has committed a reviewed_json (with its own valid
    // number), the reviewed-number precedence branch fires — so source is
    // "reviewed" for the legitimate reason, not from the extracted source string.
    const state = resolveExtractionConfidence(
      record({
        extracted_json: {
          overall_confidence: 0.6,
          overall_confidence_available: true,
          overall_confidence_source: "reviewed",
        },
        reviewed_json: {
          overall_confidence: 0.72,
          overall_confidence_available: true,
        },
      })
    );
    expect(state.state).toBe("available");
    if (state.state === "available") {
      expect(state.value).toBeCloseTo(0.72);
      expect(state.source).toBe("reviewed");
    }
  });
});
