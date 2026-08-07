/**
 * Atlas hybrid pipeline — canonical parsed/extracted document shapes.
 * ----------------------------------------------------------------------------
 * These are the small, provider-neutral types the rest of the pipeline speaks.
 * A "parser" (local unpdf, Azure Document Intelligence, a future provider…)
 * returns a ParsedDocument. A "normaliser" (Haiku, deterministic mapper) turns
 * that into StructuredExtraction. Everything else (validation, matching,
 * explanation, communications) already exists in Atlas — the new interfaces do
 * NOT replace them, they feed them.
 */

export type DocumentQuality =
  | "text_clean"        // extractable text, high char density, low garbled ratio
  | "text_sparse"       // some text but low density → probably needs OCR
  | "scanned"           // essentially no text; image-only
  | "layout_heavy"      // text present but tables/forms dominate → needs layout
  | "encrypted"         // password-protected; no extraction possible
  | "corrupt"           // parser errored on the bytes
  | "empty"             // valid but zero content
  | "unsupported";      // not a PDF or format we don't handle

export interface ParsedPage {
  page: number;
  text: string;               // plain text as parsed; may be empty
  charCount: number;
  emptyRegions?: number;      // parser-reported empty regions, if any
  hasTables?: boolean;        // parser hint; true only if the parser can tell
}

export interface ParsedTable {
  page: number;
  rows: string[][];           // parser-provided, if available
}

export interface ParsedKeyValue {
  page: number;
  key: string;
  value: string;
  confidence: number | null;  // null when provider does not supply one
}

export interface ParsedDocument {
  documentId: string;
  fileName: string;
  pageCount: number;
  quality: DocumentQuality;
  fullText: string;           // concatenated (page-separated) plain text
  pages: ParsedPage[];
  tables: ParsedTable[];
  keyValues: ParsedKeyValue[];
  /** Parser/provider metadata (numbers/flags only; sanitized before logging). */
  parserMeta: {
    parser: string;           // "unpdf" | "azure-doc-intel" | "legacy"
    parserVersion: string;
    charsPerPage: number;
    emptyPageRatio: number;
    invalidCharRatio: number;
    encrypted: boolean;
    parseMs: number;
  };
}

export interface DocumentInput {
  documentId: string;
  fileName: string;
  mimeType: string | null;    // NEVER trusted; parser sniffs bytes
  bytes: ArrayBuffer;
  documentType?: string | null;
}

export interface DocumentParser {
  /** Cheap check based on bytes/filename; may return false → next parser tries. */
  canHandle(input: DocumentInput): Promise<boolean>;
  parse(input: DocumentInput): Promise<ParsedDocument>;
}

/**
 * Routing decision produced by classifyRoute() and consumed by the pipeline.
 * "reason" is a short enum-like tag, never free-form user text.
 */
export type PipelineRoute =
  | "text_fast_path"
  | "ocr_required"
  | "layout_required"
  | "large_model_fallback"
  | "legacy_full_sonnet"
  | "unsupported"
  | "encrypted"
  | "failed";

export interface RouteDecision {
  route: PipelineRoute;
  reason: string;             // short, enum-like
}

/**
 * A single extracted field with provenance. Mirrors the existing Atlas field
 * shape (extraction.ts) so downstream validators keep working. Confidence is
 * nullable to make it explicit when a provider does not supply one — the
 * pipeline must NOT invent numeric confidences.
 */
export interface CanonicalField {
  value: unknown;
  confidence: number | null;
  sourceDocumentId: string | null;
  sourcePage: number | null;
  sourceText: string | null;
  boundingRegion: unknown | null;
  extractionMethod: string;   // e.g. "azure_doc_intel" | "haiku_normalise" | "legacy_sonnet"
  warnings: string[];
}
