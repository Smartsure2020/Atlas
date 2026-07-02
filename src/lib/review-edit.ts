export type EditParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export function isComplexReviewValue(value: unknown): boolean {
  return Array.isArray(value) || (!!value && typeof value === "object");
}

export function reviewValueToEditorText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (isComplexReviewValue(value)) return JSON.stringify(value, null, 2);
  return String(value);
}

export function parseReviewFieldValue(previousValue: unknown, text: string): EditParseResult {
  if (Array.isArray(previousValue)) {
    try {
      const parsed = text.trim() ? JSON.parse(text) : [];
      if (!Array.isArray(parsed)) return { ok: false, error: "Expected a JSON array." };
      return { ok: true, value: parsed };
    } catch {
      return { ok: false, error: "Invalid JSON array." };
    }
  }

  if (previousValue && typeof previousValue === "object") {
    try {
      const parsed = text.trim() ? JSON.parse(text) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "Expected a JSON object." };
      }
      return { ok: true, value: parsed };
    } catch {
      return { ok: false, error: "Invalid JSON object." };
    }
  }

  return { ok: true, value: text };
}
