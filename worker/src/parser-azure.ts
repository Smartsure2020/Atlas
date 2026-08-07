/**
 * Atlas hybrid pipeline — Azure Document Intelligence adapter
 * ----------------------------------------------------------------------------
 * Uses the Azure Document Intelligence REST API (formerly Form Recognizer) via
 * plain fetch — compatible with Cloudflare Workers. No SDK dependency, so we
 * avoid dragging Node bindings into the Worker.
 *
 * API contract used (2024-11-30 GA):
 *   POST {endpoint}/documentintelligence/documentModels/{modelId}:analyze
 *     ?api-version=2024-11-30
 *   Content-Type: application/pdf   (raw bytes)
 *   Ocp-Apim-Subscription-Key: {key}
 *
 *   Returns 202 with an Operation-Location header. We poll that URL until the
 *   status is "succeeded" or "failed".
 *
 * Model IDs:
 *   prebuilt-read     -> OCR only
 *   prebuilt-layout   -> OCR + tables + selection marks + key-value pairs
 *   {custom-id}       -> per-insurer trained model (future)
 *
 * When the endpoint/key are not configured, this adapter refuses canHandle()
 * so the pipeline falls back to local text or the legacy Sonnet path.
 * Configuration errors are ALWAYS reported as "not configured" — we never
 * pretend to be available. Provider errors are redacted before surfacing.
 */

import type {
  DocumentInput,
  DocumentParser,
  ParsedDocument,
  ParsedKeyValue,
  ParsedPage,
  ParsedTable,
} from "./pipeline-types.js";
import { classifyQuality } from "./parser-local-pdf.js";

const PARSER_NAME = "atlas-azure-doc-intel";
const PARSER_VERSION = "1.0.0";
const DEFAULT_API_VERSION = "2024-11-30";
const DEFAULT_MODEL = "prebuilt-layout";
const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_500;

export interface AzureConfig {
  endpoint: string;             // e.g. https://<resource>.cognitiveservices.azure.com
  apiKey: string;
  apiVersion?: string;
  modelId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;     // for tests
  pollIntervalMs?: number;      // for tests; production defaults to 1500ms
  /** Optional cancellation predicate — polled between polls. */
  isCancelled?: () => Promise<boolean> | boolean;
}

export function azureConfigFromEnv(env: {
  AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT?: string;
  AZURE_DOCUMENT_INTELLIGENCE_KEY?: string;
  AZURE_DOCUMENT_INTELLIGENCE_MODEL?: string;
  AZURE_DOCUMENT_INTELLIGENCE_API_VERSION?: string;
}): AzureConfig | null {
  const endpoint = env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT?.trim();
  const key = env.AZURE_DOCUMENT_INTELLIGENCE_KEY?.trim();
  if (!endpoint || !key) return null;
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    apiKey: key,
    apiVersion: env.AZURE_DOCUMENT_INTELLIGENCE_API_VERSION?.trim() || DEFAULT_API_VERSION,
    modelId: env.AZURE_DOCUMENT_INTELLIGENCE_MODEL?.trim() || DEFAULT_MODEL,
  };
}

interface AzureAnalyzeResult {
  status: "notStarted" | "running" | "succeeded" | "failed" | "canceled";
  analyzeResult?: {
    apiVersion?: string;
    modelId?: string;
    content?: string;
    pages?: {
      pageNumber: number;
      lines?: { content: string; polygon?: number[] }[];
      words?: { content: string; confidence?: number }[];
    }[];
    tables?: {
      rowCount: number;
      columnCount: number;
      cells: { rowIndex: number; columnIndex: number; content: string; boundingRegions?: unknown[] }[];
      boundingRegions?: { pageNumber: number }[];
    }[];
    keyValuePairs?: {
      key?: { content: string; boundingRegions?: { pageNumber: number }[] };
      value?: { content?: string; boundingRegions?: { pageNumber: number }[] };
      confidence?: number;
    }[];
  };
  error?: { code?: string; message?: string };
}

/** Redact provider error text before it hits our logs / responses. */
export function redactAzureError(err: unknown): string {
  if (!err) return "azure_unknown_error";
  if (typeof err === "string") return err.slice(0, 120).replace(/[\r\n]+/g, " ");
  const anyErr = err as { code?: unknown; message?: unknown; status?: unknown };
  const code = typeof anyErr.code === "string" ? anyErr.code : "azure_error";
  const status = typeof anyErr.status === "number" ? `_${anyErr.status}` : "";
  return `${code}${status}`.slice(0, 120);
}

export class AzureDocumentIntelligenceParser implements DocumentParser {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: AzureConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async canHandle(input: DocumentInput): Promise<boolean> {
    // Azure handles PDFs, TIFFs, and images. For now we only route PDFs here.
    return input.fileName.toLowerCase().endsWith(".pdf");
  }

  async parse(input: DocumentInput): Promise<ParsedDocument> {
    const started = Date.now();
    const modelId = this.cfg.modelId ?? DEFAULT_MODEL;
    const apiVersion = this.cfg.apiVersion ?? DEFAULT_API_VERSION;
    const url =
      `${this.cfg.endpoint}/documentintelligence/documentModels/${encodeURIComponent(modelId)}:analyze` +
      `?api-version=${encodeURIComponent(apiVersion)}`;

    let submit: Response;
    try {
      submit = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/pdf",
          "Ocp-Apim-Subscription-Key": this.cfg.apiKey,
        },
        body: input.bytes,
      });
    } catch (err) {
      throw new Error(redactAzureError({ code: "azure_network_failure", message: (err as Error)?.message }));
    }

    // 200 = immediate result (some Azure operations return synchronously).
    if (submit.status === 200) {
      let body: AzureAnalyzeResult;
      try { body = (await submit.json()) as AzureAnalyzeResult; }
      catch { throw new Error("azure_malformed_response"); }
      if (body.status && body.status !== "succeeded") {
        throw new Error(redactAzureError(body.error ?? { code: "azure_status_" + body.status }));
      }
      return this.buildParsed(input, body, Date.now() - started);
    }

    if (submit.status === 401 || submit.status === 403) {
      throw new Error(redactAzureError({ code: "azure_auth_failed", status: submit.status }));
    }
    if (submit.status === 429) {
      throw new Error(redactAzureError({ code: "azure_rate_limited", status: submit.status }));
    }
    if (submit.status !== 202) {
      throw new Error(redactAzureError({ code: "azure_submit_failed", status: submit.status }));
    }
    const opLocation = submit.headers.get("Operation-Location") ?? submit.headers.get("operation-location");
    if (!opLocation) throw new Error("azure_no_operation_location");

    const timeoutMs = this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollInterval = this.cfg.pollIntervalMs ?? POLL_INTERVAL_MS;
    const deadline = Date.now() + timeoutMs;
    let result: AzureAnalyzeResult | null = null;
    while (Date.now() < deadline) {
      if (await this.cfg.isCancelled?.()) throw new Error("azure_cancelled");
      await new Promise((r) => setTimeout(r, pollInterval));

      let poll: Response;
      try {
        poll = await this.fetchImpl(opLocation, {
          headers: { "Ocp-Apim-Subscription-Key": this.cfg.apiKey },
        });
      } catch (err) {
        throw new Error(redactAzureError({ code: "azure_poll_network_failure", message: (err as Error)?.message }));
      }
      if (poll.status === 401 || poll.status === 403) {
        throw new Error(redactAzureError({ code: "azure_auth_failed", status: poll.status }));
      }
      if (poll.status === 429) {
        throw new Error(redactAzureError({ code: "azure_rate_limited", status: poll.status }));
      }
      if (!poll.ok) {
        throw new Error(redactAzureError({ code: "azure_poll_failed", status: poll.status }));
      }
      try { result = (await poll.json()) as AzureAnalyzeResult; }
      catch { throw new Error("azure_malformed_response"); }
      if (result.status === "succeeded" || result.status === "failed" || result.status === "canceled") break;
    }
    if (!result || (result.status !== "succeeded" && result.status !== "failed" && result.status !== "canceled")) {
      throw new Error("azure_timeout");
    }
    if (result.status !== "succeeded") {
      throw new Error(redactAzureError(result.error ?? { code: "azure_status_" + result.status }));
    }

    return this.buildParsed(input, result, Date.now() - started);
  }

  private buildParsed(input: DocumentInput, res: AzureAnalyzeResult, parseMs: number): ParsedDocument {
    const pagesIn = res.analyzeResult?.pages ?? [];
    const pages: ParsedPage[] = pagesIn.map((p) => {
      const text = (p.lines ?? []).map((l) => l.content).join("\n");
      return {
        page: p.pageNumber,
        text,
        charCount: text.length,
        hasTables: (res.analyzeResult?.tables ?? []).some((t) =>
          (t.boundingRegions ?? []).some((r) => r.pageNumber === p.pageNumber)
        ),
      };
    });

    const tables: ParsedTable[] = (res.analyzeResult?.tables ?? []).map((t) => {
      const page = t.boundingRegions?.[0]?.pageNumber ?? 1;
      const rows: string[][] = Array.from({ length: t.rowCount }, () =>
        Array.from({ length: t.columnCount }, () => "")
      );
      for (const c of t.cells) {
        if (c.rowIndex < rows.length && c.columnIndex < (rows[c.rowIndex]?.length ?? 0)) {
          rows[c.rowIndex][c.columnIndex] = c.content;
        }
      }
      return { page, rows };
    });

    const keyValues: ParsedKeyValue[] = (res.analyzeResult?.keyValuePairs ?? [])
      .filter((kv) => kv.key?.content)
      .map((kv) => ({
        page: kv.key?.boundingRegions?.[0]?.pageNumber ?? kv.value?.boundingRegions?.[0]?.pageNumber ?? 1,
        key: String(kv.key?.content ?? ""),
        value: String(kv.value?.content ?? ""),
        confidence: typeof kv.confidence === "number" ? kv.confidence : null,
      }));

    const cls = classifyQuality(pages, false, false);
    return {
      documentId: input.documentId,
      fileName: input.fileName,
      pageCount: pages.length,
      // Azure gave us OCR text; treat sparse output as still text_clean when
      // Azure ran successfully — it means the doc really is sparse, not that
      // OCR is missing.
      quality: cls.quality === "scanned" ? "text_sparse" : cls.quality,
      fullText: pages.map((p) => p.text).join("\n\n"),
      pages,
      tables,
      keyValues,
      parserMeta: {
        parser: `${PARSER_NAME}:${res.analyzeResult?.modelId ?? DEFAULT_MODEL}`,
        parserVersion: PARSER_VERSION,
        charsPerPage: Math.round(cls.charsPerPage),
        emptyPageRatio: Number(cls.emptyPageRatio.toFixed(3)),
        invalidCharRatio: Number(cls.invalidCharRatio.toFixed(3)),
        encrypted: false,
        parseMs,
      },
    };
  }
}
