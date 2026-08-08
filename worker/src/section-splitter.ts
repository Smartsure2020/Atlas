/**
 * Atlas hybrid pipeline — page/heading-aware section splitter
 * ----------------------------------------------------------------------------
 * Turns a set of ParsedDocuments into logical policy-schedule sections so the
 * downstream extractor never has to send an entire document through a single
 * Haiku call. Splitting rules:
 *
 *   1. Prefer heading detection. A heading is a short (<= 90 char) line that
 *      matches one of the recognised section headings (case-insensitive) OR
 *      an all-caps line surrounded by blank space. Heading positions define
 *      section START offsets; a section runs until the next heading.
 *   2. Preserve page numbers. Each section carries the page range where its
 *      text originated. Splits happen at page boundaries where possible.
 *   3. If no headings are detected, fall back to page-window sections of
 *      approxCharCap characters or ~3 pages, whichever comes first.
 *   4. Very large detected sections (> approxCharCap) are re-split at page
 *      boundaries but retain the same sectionType and parent heading.
 *   5. Every emitted section knows its documentId, pages, heading, text,
 *      approxChars, source page offsets (start/end), and sectionType.
 *
 * Section taxonomy is intentionally general (short-term insurance schedules
 * across insurers) and NOT hard-coded to a single insurer's headings.
 */

import type { ParsedDocument } from "./pipeline-types.js";

export type SectionType =
  | "policy_details"
  | "intermediary_details"
  | "premium_index"
  | "buildings"
  | "contents"
  | "all_risks"
  | "personal_liability"
  | "motor"
  | "claims_history"
  | "excesses"
  | "endorsements"
  | "other_cover"
  | "unclassified";

export interface DocumentSection {
  documentId: string;
  fileName: string;
  sectionType: SectionType;
  heading: string;                 // normalised label; may echo the source heading
  pages: number[];                 // pages contributing to this section
  text: string;                    // section text with `--- page N ---` markers preserved
  approxChars: number;
  sourceOffsets: {
    startPage: number;
    endPage: number;
  };
  /**
   * Stable, monotonic ordering assigned when the document set is split. This
   * is the deterministic tie-breaker downstream: it does NOT depend on Haiku
   * completion order, on section content, or on section type. Two splits of
   * the same input always assign the same index.
   */
  stableIndex: number;
  /**
   * Zero-based order of this section's parent document within the split call.
   * Together with `stableIndex` this defines "source order" — a total order
   * independent of concurrency.
   */
  documentIndex: number;
}

export interface SplitterConfig {
  /** Maximum characters per section before it's re-split at page boundaries. */
  approxCharCap: number;
  /** Fallback page window when no headings are detected. */
  fallbackPageWindow: number;
}

export const DEFAULT_SPLITTER_CONFIG: SplitterConfig = {
  approxCharCap: 12_000,
  fallbackPageWindow: 3,
};

// ---------------------------------------------------------------------------
// Heading recognition — deliberately generic across insurers
// ---------------------------------------------------------------------------

const HEADING_PATTERNS: { type: SectionType; label: string; test: RegExp }[] = [
  { type: "policy_details",       label: "Policy Details",       test: /^(policy\s*(details|information|schedule|holder)|insured\s*(details|information)|schedule\s*of\s*insurance|policy\s*summary)\b/i },
  { type: "intermediary_details", label: "Intermediary Details", test: /^(intermediary|broker|administrator|insurer)\s*(details|information|contact)?\b/i },
  { type: "premium_index",        label: "Premium & Index of Cover", test: /^(premium(s)?(\s*summary)?|index\s*(to|of)\s*cover|schedule\s*of\s*premiums|total\s*premium(s)?)\b/i },
  { type: "buildings",            label: "Buildings",            test: /^(building(s)?|structure(s)?|residential\s*building|main\s*dwelling)\b/i },
  { type: "contents",             label: "Contents",             test: /^(contents|householders?\s*contents|domestic\s*contents)\b/i },
  { type: "all_risks",            label: "All Risks",            test: /^(all\s*risks?|personal\s*(all\s*risks|possessions?)|portable\s*possessions?|specified\s*(all\s*risks|items)|unspecified\s*(all\s*risks|items))\b/i },
  { type: "personal_liability",   label: "Personal Liability",   test: /^(personal\s*liability|householders?\s*liability|liability\s*to\s*third\s*parties|public\s*liability)\b/i },
  { type: "motor",                label: "Motor",                test: /^(motor(\s*vehicles?)?|private\s*motor|commercial\s*motor|caravans?\s*and\s*trailers?|watercraft)\b/i },
  { type: "claims_history",       label: "Claims History",       test: /^(claims?\s*(history|experience|record)|previous\s*claims?|loss\s*history)\b/i },
  { type: "excesses",             label: "Excesses",             test: /^(excesses?|deductibles?|first\s*amount\s*payable)\b/i },
  { type: "endorsements",         label: "Endorsements & Conditions", test: /^(endorsements?|memoranda|special\s*conditions|conditions\s*and\s*warranties|policy\s*conditions|referrals?)\b/i },
];

const HEADING_MAX_LEN = 90;

interface HeadingHit {
  sectionType: SectionType;
  label: string;
  line: number;   // index into the joined lines array
  page: number;
  raw: string;
}

/**
 * Detect heading lines in a per-document line stream. A line qualifies when it
 * matches a known heading pattern OR is a short all-caps line likely to be a
 * heading. The result is ordered by appearance.
 */
function detectHeadings(lines: string[], lineToPage: number[]): HeadingHit[] {
  const hits: HeadingHit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]?.trim() ?? "";
    if (!raw || raw.length > HEADING_MAX_LEN) continue;
    // Skip page markers
    if (/^---\s*page\s+\d+\s*---$/i.test(raw)) continue;
    // Skip "Key: value" data lines and "Foo included: Yes" style lines — a
    // heading line is a label, not a data row.
    if (/:\s*\S/.test(raw)) continue;
    if (/\b(included|excluded|amount|sum\s*insured|premium|excess|value|no)\s*:/i.test(raw)) continue;
    let matched: { type: SectionType; label: string } | null = null;
    for (const h of HEADING_PATTERNS) {
      if (h.test.test(raw)) { matched = { type: h.type, label: h.label }; break; }
    }
    if (!matched) {
      // "OTHER SECTION" style all-caps short lines with surrounding blanks.
      const prev = (lines[i - 1] ?? "").trim();
      const next = (lines[i + 1] ?? "").trim();
      const isAllCapsish =
        raw.length >= 4 &&
        raw === raw.toUpperCase() &&
        /[A-Z]/.test(raw) &&
        !prev &&
        (next === "" || next === next);
      if (isAllCapsish) {
        matched = { type: "other_cover", label: raw };
      }
    }
    if (matched) {
      hits.push({
        sectionType: matched.type,
        label: matched.label,
        line: i,
        page: lineToPage[i] ?? 1,
        raw,
      });
    }
  }
  return dedupeAdjacent(hits);
}

/** Collapse consecutive heading hits of the same section type on the same page. */
function dedupeAdjacent(hits: HeadingHit[]): HeadingHit[] {
  const out: HeadingHit[] = [];
  for (const h of hits) {
    const prev = out[out.length - 1];
    if (prev && prev.sectionType === h.sectionType && prev.page === h.page) continue;
    out.push(h);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-document split
// ---------------------------------------------------------------------------

/**
 * Assemble a per-document line stream with `--- page N ---` markers so the
 * splitter can (a) find headings on any page and (b) preserve page numbers in
 * the emitted section text.
 */
function documentLineStream(doc: ParsedDocument): { lines: string[]; lineToPage: number[] } {
  const lines: string[] = [];
  const lineToPage: number[] = [];
  const push = (line: string, page: number) => { lines.push(line); lineToPage.push(page); };
  for (const p of doc.pages) {
    push(`--- page ${p.page} ---`, p.page);
    const text = (p.text ?? "").trim();
    if (text) for (const l of text.split(/\r?\n/)) push(l, p.page);
    else push("(no extractable text on this page)", p.page);
    push("", p.page);
  }
  return { lines, lineToPage };
}

function joinSection(lines: string[], lineToPage: number[], from: number, toExclusive: number): {
  text: string;
  pages: number[];
  startPage: number;
  endPage: number;
} {
  const chunkLines = lines.slice(from, toExclusive);
  const pages = Array.from(new Set(lineToPage.slice(from, toExclusive))).sort((a, b) => a - b);
  return {
    text: chunkLines.join("\n").trim(),
    pages,
    startPage: pages[0] ?? 1,
    endPage: pages[pages.length - 1] ?? 1,
  };
}

/**
 * Re-split an oversized section at page boundaries. Keeps the parent
 * heading/sectionType on every child. Never splits mid-line.
 */
function splitAtPageBoundaries(
  parent: DocumentSection,
  lines: string[],
  lineToPage: number[],
  fromLine: number,
  toLineExclusive: number,
  cap: number
): DocumentSection[] {
  const children: DocumentSection[] = [];
  let cursor = fromLine;
  let chunkStart = cursor;
  let chunkChars = 0;
  const pushChunk = (endExclusive: number) => {
    if (endExclusive <= chunkStart) return;
    const j = joinSection(lines, lineToPage, chunkStart, endExclusive);
    children.push({
      ...parent,
      pages: j.pages,
      text: j.text,
      approxChars: j.text.length,
      sourceOffsets: { startPage: j.startPage, endPage: j.endPage },
    });
    chunkStart = endExclusive;
    chunkChars = 0;
  };
  while (cursor < toLineExclusive) {
    const line = lines[cursor] ?? "";
    const isPageMarker = /^---\s*page\s+\d+\s*---$/i.test(line);
    if (isPageMarker && chunkChars >= cap && cursor > chunkStart) {
      pushChunk(cursor);
    }
    chunkChars += line.length + 1;
    cursor++;
  }
  pushChunk(toLineExclusive);
  return children.length > 0 ? children : [parent];
}

function splitOneDocument(doc: ParsedDocument, cfg: SplitterConfig): DocumentSection[] {
  if (!doc.pages.length) return [];
  const { lines, lineToPage } = documentLineStream(doc);
  const hits = detectHeadings(lines, lineToPage);

  const sections: DocumentSection[] = [];

  if (hits.length === 0) {
    // No headings — fall back to page-window slices of approxCharCap.
    let cursor = 0;
    let chunkStart = 0;
    let chunkChars = 0;
    let pageBoundariesSeen = 0;
    const flush = (endExclusive: number, type: SectionType, label: string) => {
      if (endExclusive <= chunkStart) return;
      const j = joinSection(lines, lineToPage, chunkStart, endExclusive);
      sections.push({
        documentId: doc.documentId,
        fileName: doc.fileName,
        sectionType: type,
        heading: label,
        pages: j.pages,
        text: j.text,
        approxChars: j.text.length,
        sourceOffsets: { startPage: j.startPage, endPage: j.endPage },
        // Placeholder — the outer splitDocumentsIntoSections stamps the
        // authoritative stableIndex/documentIndex once all per-doc sections
        // have been collected in source order.
        stableIndex: -1,
        documentIndex: -1,
      });
      chunkStart = endExclusive;
      chunkChars = 0;
      pageBoundariesSeen = 0;
    };
    while (cursor < lines.length) {
      const line = lines[cursor] ?? "";
      const isPageMarker = /^---\s*page\s+\d+\s*---$/i.test(line);
      if (isPageMarker) {
        pageBoundariesSeen++;
        if (pageBoundariesSeen > cfg.fallbackPageWindow || chunkChars > cfg.approxCharCap) {
          flush(cursor, "unclassified", `Pages ${lineToPage[chunkStart] ?? 1}-${lineToPage[cursor - 1] ?? 1}`);
        }
      }
      chunkChars += line.length + 1;
      cursor++;
    }
    flush(lines.length, "unclassified", `Pages ${lineToPage[chunkStart] ?? 1}-${lineToPage[lines.length - 1] ?? 1}`);
    return sections;
  }

  // Heading-based split. If the first heading isn't at line 0 AND isn't
  // itself policy_details, the leading preamble becomes its own
  // "policy_details" candidate (schedules almost always open with policy /
  // insured details).
  if (hits[0].line > 0 && hits[0].sectionType !== "policy_details") {
    hits.unshift({ sectionType: "policy_details", label: "Policy Details", line: 0, page: lineToPage[0] ?? 1, raw: "" });
  }
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].line;
    const end = i + 1 < hits.length ? hits[i + 1].line : lines.length;
    const j = joinSection(lines, lineToPage, start, end);
    const parent: DocumentSection = {
      documentId: doc.documentId,
      fileName: doc.fileName,
      sectionType: hits[i].sectionType,
      heading: hits[i].label,
      pages: j.pages,
      text: j.text,
      approxChars: j.text.length,
      sourceOffsets: { startPage: j.startPage, endPage: j.endPage },
      // Placeholders — stamped by splitDocumentsIntoSections in source order.
      stableIndex: -1,
      documentIndex: -1,
    };
    if (parent.approxChars > cfg.approxCharCap) {
      sections.push(...splitAtPageBoundaries(parent, lines, lineToPage, start, end, cfg.approxCharCap));
    } else {
      sections.push(parent);
    }
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SplitResult {
  sections: DocumentSection[];
  detectionMs: number;
  /** True when at least one heading was recognised in at least one document. */
  headingsDetected: boolean;
}

export function splitDocumentsIntoSections(
  docs: ParsedDocument[],
  cfg: Partial<SplitterConfig> = {}
): SplitResult {
  const started = Date.now();
  const conf: SplitterConfig = { ...DEFAULT_SPLITTER_CONFIG, ...cfg };
  const sections: DocumentSection[] = [];
  let headingsDetected = false;
  let stableIndex = 0;
  for (let documentIndex = 0; documentIndex < docs.length; documentIndex++) {
    const doc = docs[documentIndex];
    const perDoc = splitOneDocument(doc, conf);
    for (const s of perDoc) {
      if (s.sectionType !== "unclassified") headingsDetected = true;
      // Stamp deterministic ordering at the outer boundary. Splitter output
      // order == source order (per-document sequential), so this is a stable
      // property of the input, not of concurrency.
      s.documentIndex = documentIndex;
      s.stableIndex = stableIndex++;
      sections.push(s);
    }
  }
  return { sections, detectionMs: Date.now() - started, headingsDetected };
}
