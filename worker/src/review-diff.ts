/**
 * Atlas Blueprint — extraction review diff
 * ----------------------------------------------------------------------------
 * Computes WHICH fields an underwriter changed when saving corrections, so the
 * audit trail records the names of corrected fields. Correcting the AI's read
 * is the most important human act in the workflow; "extraction_reviewed" with
 * only an id said nothing about what was actually corrected.
 *
 * Paths only, never values: audit metadata must not carry client data.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** An extraction field object ({value, status, ...}) is compared as ONE leaf —
 *  we report "extracted_client.name changed", not each sub-key. */
function isFieldLeaf(value: unknown): boolean {
  return isPlainObject(value) && "value" in value && "status" in value;
}

/** Key-order-independent serialization so legacy rows with different key
 *  ordering don't produce phantom diffs. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

export interface FieldDiff {
  changed_paths: string[];
  truncated: boolean;
}

/**
 * Field-level paths that differ between two extraction JSON documents.
 * Recurses through plain-object sections; field objects, arrays, and scalars
 * are compared whole. Capped so a total rewrite can't bloat an audit row.
 */
export function diffFieldPaths(before: unknown, after: unknown, maxPaths = 50): FieldDiff {
  const changed: string[] = [];
  let truncated = false;

  const walk = (a: unknown, b: unknown, path: string) => {
    if (changed.length >= maxPaths) {
      truncated = true;
      return;
    }
    if (isPlainObject(a) && isPlainObject(b) && !isFieldLeaf(a) && !isFieldLeaf(b)) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of [...keys].sort()) {
        walk(a[key], b[key], path ? `${path}.${key}` : key);
        if (truncated) return;
      }
      return;
    }
    if (stableStringify(a) !== stableStringify(b)) {
      changed.push(path || "(root)");
    }
  };

  walk(before ?? {}, after ?? {}, "");
  return { changed_paths: changed, truncated };
}
