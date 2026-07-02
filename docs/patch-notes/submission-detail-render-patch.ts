/**
 * Atlas Blueprint — patch for src/pages/SubmissionDetail.tsx
 * ----------------------------------------------------------------------------
 * Fixes the "[object Object], [object Object], ..." rendering on fields that
 * Claude legitimately extracts as arrays of structured objects — sums_insured
 * and excesses are the obvious ones, where each entry naturally has
 * {section, amount} or {section, excess} shape.
 *
 * The existing FieldRow does:
 *
 *   const display = Array.isArray(field.value)
 *     ? field.value.join(", ")
 *     : field.value === null || field.value === undefined
 *     ? ""
 *     : String(field.value);
 *
 * which calls Array#join on objects, producing the [object Object] string.
 *
 * The fix: detect arrays-of-objects and format each entry as a readable
 * "key: value · key: value" string, joined by line breaks (or " | " in
 * compact form). Plain string arrays still join with commas as before.
 *
 * Editing such fields stays workable: editing collapses to the joined-string
 * form, and saving back keeps it as a string (the extraction's `reviewed_json`
 * accepts either shape since we already permit per-field correction). The
 * underwriter who wants to genuinely edit a structured array can do so as
 * one entry per line.
 *
 * Apply by finding the `display` calculation in FieldRow and replacing it
 * with the version below.
 * ============================================================================
 */

// ----- REPLACE the existing `display` calculation in FieldRow with this: -----

/*

const display = formatFieldValue(field.value);

*/

// ----- ADD this helper near the top of the file (after the isField helper): --

/*

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return value
      .map((item) => formatOne(item))
      .filter((s) => s.length > 0)
      .join("\n");
  }
  return formatOne(value);
}

function formatOne(item: unknown): string {
  if (item === null || item === undefined) return "";
  if (typeof item === "object") {
    // Render an object as "key: value · key: value", skipping null/undefined.
    return Object.entries(item as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(" · ");
  }
  return String(item);
}

*/

// ----- UPDATE the input rendering in FieldRow to use a textarea when the
//       value is a multi-line string (arrays now render with newlines): -----
//
// Find:
//
//   editing ? (
//     <input
//       className="atlas-field__input"
//       value={display}
//       placeholder="—"
//       onChange={(e) => onChange(e.target.value)}
//     />
//   ) : (
//     <div className="atlas-field__value">{display || <span ...>—</span>}</div>
//   )
//
// Replace the editing branch with a textarea-or-input choice:

/*

editing ? (
  display.includes("\n") ? (
    <textarea
      className="atlas-field__input"
      rows={Math.min(8, display.split("\n").length + 1)}
      value={display}
      placeholder="—"
      onChange={(e) => onChange(e.target.value)}
    />
  ) : (
    <input
      className="atlas-field__input"
      value={display}
      placeholder="—"
      onChange={(e) => onChange(e.target.value)}
    />
  )
) : (
  <div className="atlas-field__value" style={{ whiteSpace: "pre-line" }}>
    {display || <span className="atlas-muted-dash">—</span>}
  </div>
)

*/

// (The whiteSpace: "pre-line" preserves the line breaks visually so a
// multi-entry list reads as a list rather than a wall of text.)

export {}; // documentation file
