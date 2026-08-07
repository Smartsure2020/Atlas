/**
 * Atlas hybrid pipeline — local PDF parser
 * ----------------------------------------------------------------------------
 * Uses `unpdf` (pdf.js under the hood) as the canonical local extractor. It
 * handles compressed content streams (FlateDecode etc.), preserves per-page
 * text, and is Cloudflare Workers-compatible via unpdf's DOMMatrix polyfill.
 *
 * A minimal built-in extractor is retained ONLY as a controlled fallback for
 * cases where unpdf itself throws (rare — malformed PDFs, unsupported filter
 * combinations). When both fail, the classifier reports "corrupt" and the
 * router escalates via the documented fallback policy.
 *
 * Security posture:
 *   - MIME/filename NOT trusted. We sniff for %PDF- magic bytes.
 *   - Encrypted PDFs are detected and returned without further parsing.
 *   - No embedded content is executed.
 *   - Caller applies file-size + page-count caps.
 */

import { extractText } from "unpdf";
import type {
  DocumentInput,
  DocumentParser,
  DocumentQuality,
  ParsedDocument,
  ParsedPage,
} from "./pipeline-types.js";

const PARSER_NAME = "atlas-local-pdf";
const PARSER_VERSION = "2.0.0";

// --- byte helpers ---------------------------------------------------------

function looksLikePdf(bytes: Uint8Array): boolean {
  const cap = Math.min(bytes.length, 1024);
  const view = bytes.subarray(0, cap);
  const marker = new TextEncoder().encode("%PDF-");
  outer: for (let i = 0; i <= view.length - marker.length; i++) {
    for (let j = 0; j < marker.length; j++) {
      if (view[i + j] !== marker[j]) continue outer;
    }
    return true;
  }
  return false;
}

function looksEncrypted(text: string): boolean {
  return /\/Encrypt(\s|<<|\d)/.test(text);
}

function decodeLatin1(bytes: Uint8Array): string {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return out;
}

// --- controlled built-in fallback ----------------------------------------
// Deliberately narrow. Handles uncompressed BT/ET literal-string blocks only.
// Only invoked when unpdf throws.

function extractLiteralStrings(pageContent: string): string {
  const chunks: string[] = [];
  const btBlocks = pageContent.match(/BT([\s\S]*?)ET/g) ?? [];
  for (const block of btBlocks) {
    const strings = block.match(/\(((?:\\.|[^\\()])*)\)/g) ?? [];
    for (const s of strings) {
      const inner = s.slice(1, -1)
        .replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
        .replace(/\\\(/g, "(").replace(/\\\)/g, ")").replace(/\\\\/g, "\\");
      if (inner) chunks.push(inner);
    }
    const tjArrays = block.match(/\[([\s\S]*?)\]\s*TJ/g) ?? [];
    for (const arr of tjArrays) {
      const parts = arr.match(/\(((?:\\.|[^\\()])*)\)/g) ?? [];
      for (const p of parts) chunks.push(p.slice(1, -1));
    }
  }
  return chunks.join(" ").replace(/\s+/g, " ").trim();
}

function splitByPage(pdfText: string): string[] {
  const marker = /\/Type\s*\/Page\b/g;
  const idxs: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = marker.exec(pdfText))) idxs.push(m.index);
  if (idxs.length === 0) return [pdfText];
  const pages: string[] = [];
  for (let i = 0; i < idxs.length; i++) {
    const start = idxs[i];
    const end = i + 1 < idxs.length ? idxs[i + 1] : pdfText.length;
    pages.push(pdfText.slice(start, end));
  }
  return pages;
}

// --- classifier ----------------------------------------------------------

export interface QualityThresholds {
  minCharsPerPage: number;
  maxEmptyPageRatio: number;
  maxInvalidCharRatio: number;
}

export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = {
  minCharsPerPage: 200,
  maxEmptyPageRatio: 0.4,
  maxInvalidCharRatio: 0.3,
};

function invalidCharRatio(text: string): number {
  if (!text) return 0;
  let bad = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0xfffd) { bad++; continue; }
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) { bad++; continue; }
    if (code >= 0xe000 && code <= 0xf8ff) bad++;
  }
  return bad / text.length;
}

export function classifyQuality(
  pages: ParsedPage[],
  encrypted: boolean,
  parseError: boolean,
  thresholds: QualityThresholds = DEFAULT_QUALITY_THRESHOLDS
): { quality: DocumentQuality; charsPerPage: number; emptyPageRatio: number; invalidCharRatio: number } {
  if (encrypted) return { quality: "encrypted", charsPerPage: 0, emptyPageRatio: 1, invalidCharRatio: 0 };
  if (parseError) return { quality: "corrupt", charsPerPage: 0, emptyPageRatio: 1, invalidCharRatio: 1 };
  if (pages.length === 0) return { quality: "empty", charsPerPage: 0, emptyPageRatio: 1, invalidCharRatio: 0 };
  const totalChars = pages.reduce((s, p) => s + p.charCount, 0);
  const empty = pages.filter((p) => p.charCount === 0).length;
  const emptyRatio = empty / pages.length;
  const charsPerPage = totalChars / pages.length;
  const invalidRatio = invalidCharRatio(pages.map((p) => p.text).join(" "));

  if (totalChars === 0) return { quality: "scanned", charsPerPage, emptyPageRatio: emptyRatio, invalidCharRatio: invalidRatio };
  if (invalidRatio > thresholds.maxInvalidCharRatio) return { quality: "corrupt", charsPerPage, emptyPageRatio: emptyRatio, invalidCharRatio: invalidRatio };
  if (charsPerPage < thresholds.minCharsPerPage || emptyRatio > thresholds.maxEmptyPageRatio) {
    return { quality: "text_sparse", charsPerPage, emptyPageRatio: emptyRatio, invalidCharRatio: invalidRatio };
  }
  return { quality: "text_clean", charsPerPage, emptyPageRatio: emptyRatio, invalidCharRatio: invalidRatio };
}

// --- public parser -------------------------------------------------------

export class LocalPdfParser implements DocumentParser {
  constructor(private readonly thresholds: QualityThresholds = DEFAULT_QUALITY_THRESHOLDS) {}

  async canHandle(input: DocumentInput): Promise<boolean> {
    const bytes = new Uint8Array(input.bytes);
    return looksLikePdf(bytes);
  }

  async parse(input: DocumentInput): Promise<ParsedDocument> {
    const started = Date.now();
    const bytes = new Uint8Array(input.bytes);

    if (!looksLikePdf(bytes)) {
      return this.buildParsed(input, [], false, true, Date.now() - started, "none");
    }

    // Encryption check without asking pdf.js — it errors on encrypted docs with
    // a generic message that would look like a normal parse failure.
    const raw = decodeLatin1(bytes);
    if (looksEncrypted(raw)) {
      return this.buildParsed(input, [], true, false, Date.now() - started, "none");
    }

    // Canonical path: unpdf/pdf.js.
    try {
      const result = await extractText(bytes, { mergePages: false });
      const texts: string[] = Array.isArray(result.text) ? result.text.map((p) => String(p ?? "")) : [];
      const pages: ParsedPage[] = texts.map((text, i) => ({
        page: i + 1,
        text,
        charCount: text.length,
      }));
      return this.buildParsed(input, pages, false, false, Date.now() - started, "unpdf");
    } catch (unpdfErr) {
      // Controlled fallback — never used for encrypted (caught above) and
      // never used to "invent" text. Its output is deterministic and the
      // classifier will still route empty results to OCR.
      try {
        const rawPages = splitByPage(raw);
        const texts = rawPages.map(extractLiteralStrings);
        const pages: ParsedPage[] = texts.map((text, i) => ({
          page: i + 1,
          text: text ?? "",
          charCount: (text ?? "").length,
        }));
        return this.buildParsed(input, pages, false, false, Date.now() - started, "builtin_fallback", (unpdfErr as Error).message?.slice(0, 60));
      } catch {
        return this.buildParsed(input, [], false, true, Date.now() - started, "none", (unpdfErr as Error).message?.slice(0, 60));
      }
    }
  }

  private buildParsed(
    input: DocumentInput,
    pages: ParsedPage[],
    encrypted: boolean,
    parseError: boolean,
    parseMs: number,
    backend: "unpdf" | "builtin_fallback" | "none" = "none",
    unpdfError?: string
  ): ParsedDocument {
    const cls = classifyQuality(pages, encrypted, parseError, this.thresholds);
    return {
      documentId: input.documentId,
      fileName: input.fileName,
      pageCount: pages.length,
      quality: cls.quality,
      fullText: pages.map((p) => p.text).join("\n\n"),
      pages,
      tables: [],
      keyValues: [],
      parserMeta: {
        parser: `${PARSER_NAME}:${backend}${unpdfError ? ":fallback" : ""}`,
        parserVersion: PARSER_VERSION,
        charsPerPage: Math.round(cls.charsPerPage),
        emptyPageRatio: Number(cls.emptyPageRatio.toFixed(3)),
        invalidCharRatio: Number(cls.invalidCharRatio.toFixed(3)),
        encrypted,
        parseMs,
      },
    };
  }
}
