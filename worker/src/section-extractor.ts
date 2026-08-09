/**
 * Atlas hybrid pipeline — controlled parallel section extractor
 * ----------------------------------------------------------------------------
 * Runs focused Haiku calls per DocumentSection with:
 *
 *   - concurrency cap (default 2; configurable)
 *   - per-section timeout enforced via AbortController
 *   - overall deadline shared across every call
 *   - one section failure never aborts other in-flight sections
 *   - rate-limit retry (single retry; honours provider Retry-After header up
 *     to RETRY_AFTER_MAX_MS, clamped against the remaining per-section budget)
 *   - invalid-request errors NEVER retried
 *   - cancellation via isCancelled callback (checked between sections)
 *   - progress heartbeat via onProgress(completedCount, totalCount, sectionType)
 *
 * The extractor knows nothing about the canonical Atlas extraction; it just
 * emits per-section outcomes for the deterministic merger to combine.
 */

import type { Env } from "./config.js";
import { EXTRACTION_SCHEMA_VERSION } from "./extraction.js";
import {
  ATLAS_MODEL_HAIKU,
  anthropicCall,
  parseJsonReply,
  AnthropicCallError,
  classifyAnthropicError,
  type AnthropicFailureCategory,
  type Usage,
} from "./anthropic-client.js";
import type { DocumentSection } from "./section-splitter.js";
import type { SectionType } from "./section-splitter.js";
import { schemaFor, mapFocusedReplyToPartial, type CanonicalPartial } from "./section-schemas.js";

export interface SectionRunResult {
  section: DocumentSection;
  outcome: "success" | "failure" | "timeout" | "cancelled";
  category?: AnthropicFailureCategory | "cancelled" | "deadline_exceeded";
  partial?: CanonicalPartial;
  usage?: Usage;
  model?: string;
  durationMs: number;
  attempts: number;
}

export interface ExtractSectionsOptions {
  env: Env;
  sections: DocumentSection[];
  concurrency?: number;
  perSectionTimeoutMs?: number;
  overallDeadlineMs?: number;
  isCancelled?: () => Promise<boolean>;
  onProgress?: (completed: number, total: number, lastSectionType: SectionType) => Promise<void> | void;
  /** Injected for tests; real callers omit. */
  callOverride?: (opts: {
    env: Env;
    section: DocumentSection;
    timeoutMs: number;
  }) => Promise<{ text: string; usage: Usage; model: string }>;
  /**
   * Injected for tests — resolves after `ms` without actually waiting on the
   * OS clock. Production callers omit; the extractor uses setTimeout.
   */
  sleep?: (ms: number) => Promise<void>;
}

export interface ExtractSectionsOutcome {
  results: SectionRunResult[];
  totals: {
    total: number;
    success: number;
    failure: number;
    timeout: number;
    cancelled: number;
    haikuTotalMs: number;
    slowestSectionMs: number;
    concurrency: number;
    deadlineExceeded: boolean;
  };
}

// ---------------------------------------------------------------------------
// Prompt builder for a single section
// ---------------------------------------------------------------------------

function buildSectionPrompt(section: DocumentSection): { system: unknown[]; userText: string; maxTokens: number } {
  const schema = schemaFor(section.sectionType);
  const system = [
    // Cacheable stable block: fragment + schema hint.
    {
      type: "text",
      text: `${schema.systemPromptFragment}\n\nCanonical Atlas schema version: ${EXTRACTION_SCHEMA_VERSION}. Section type: ${section.sectionType}.`,
      cache_control: { type: "ephemeral" },
    },
    // The schema hint is also stable per section type, and cacheable.
    { type: "text", text: schema.schemaHint, cache_control: { type: "ephemeral" } },
  ];
  const userText = [
    `SECTION HEADING: ${section.heading}`,
    `SOURCE PAGES: ${section.pages.join(", ") || "unknown"}`,
    "",
    "SECTION TEXT (page markers preserved):",
    section.text.length > 20_000 ? section.text.slice(0, 20_000) : section.text,
    "",
    "Return the focused JSON described in the system message. Nothing else.",
  ].join("\n");
  return { system, userText, maxTokens: schema.maxOutputTokens };
}

// ---------------------------------------------------------------------------
// Single section run (with retry for rate-limit)
// ---------------------------------------------------------------------------

async function runSingleSection(
  opts: ExtractSectionsOptions,
  section: DocumentSection,
  remainingDeadlineMs: number
): Promise<SectionRunResult> {
  const started = Date.now();
  const perSection = Math.min(
    opts.perSectionTimeoutMs ?? 25_000,
    Math.max(1000, remainingDeadlineMs)
  );
  let attempts = 0;
  let lastCategory: AnthropicFailureCategory = "unknown_failure";
  let lastError: string | undefined;
  while (attempts < 2) {
    attempts++;
    try {
      const { system, userText, maxTokens } = buildSectionPrompt(section);
      let text: string;
      let usage: Usage;
      let model: string;
      if (opts.callOverride) {
        const r = await opts.callOverride({ env: opts.env, section, timeoutMs: perSection });
        text = r.text; usage = r.usage; model = r.model;
      } else {
        const r = await anthropicCall({
          model: ATLAS_MODEL_HAIKU,
          system,
          messages: [{ role: "user", content: userText }],
          maxTokens,
          temperature: 0,
          apiKey: opts.env.ANTHROPIC_API_KEY,
          timeoutMs: perSection,
        });
        text = r.text; usage = r.usage; model = r.model;
      }
      const reply = parseJsonReply<Record<string, unknown>>(text);
      const partial = mapFocusedReplyToPartial(section.sectionType, reply);
      return {
        section,
        outcome: "success",
        partial,
        usage,
        model,
        durationMs: Date.now() - started,
        attempts,
      };
    } catch (err) {
      const category: AnthropicFailureCategory =
        err instanceof AnthropicCallError ? err.category : classifyAnthropicError(err);
      lastCategory = category;
      lastError = (err as Error)?.message?.slice(0, 60);
      // Only retry transient transport failures, and only once. `network_failure`
      // is a genuine transport hiccup (DNS blip, TCP reset, TLS handshake); a
      // single bounded retry usually clears it without paying the Sonnet
      // section-recovery cost. `auth_failed` and `invalid_request` are NEVER
      // retried — a bigger model or a re-send does not fix them.
      const retryable =
        category === "rate_limited" ||
        category === "server_error" ||
        category === "network_failure";
      const elapsed = Date.now() - started;
      const remainingSectionBudget = perSection - elapsed;
      // Compute the backoff. For rate_limited responses we honour the
      // provider's Retry-After header when present (parsed + capped upstream
      // in anthropic-client.ts); otherwise fall back to a short fixed delay.
      const providerHint =
        err instanceof AnthropicCallError && typeof err.retryAfterMs === "number"
          ? err.retryAfterMs
          : null;
      const defaultBackoff =
        category === "rate_limited" ? 1500 :
        category === "network_failure" ? 400 : 500;
      const desiredBackoff = providerHint != null ? providerHint : defaultBackoff;
      // Clamp against the remaining per-section budget so we never wait
      // beyond a deadline we cannot honour. We need at least 1000ms of
      // headroom for the retry call itself; if the budget cannot fit both
      // the sleep AND a meaningful call, skip the retry.
      const maxSleep = Math.max(0, remainingSectionBudget - 1000);
      const backoff = Math.min(desiredBackoff, maxSleep);
      const canRetry =
        attempts < 2 &&
        retryable &&
        remainingSectionBudget > 2000 &&
        backoff >= 0 &&
        remainingSectionBudget - backoff > 1000;
      if (canRetry) {
        const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
        if (backoff > 0) await sleep(backoff);
        continue;
      }
      const outcome = category === "timeout" ? "timeout" : "failure";
      return {
        section,
        outcome,
        category,
        durationMs: Date.now() - started,
        attempts,
      };
    }
  }
  return {
    section,
    outcome: "failure",
    category: lastCategory,
    durationMs: Date.now() - started,
    attempts,
  };
}

// ---------------------------------------------------------------------------
// Public: extractSections
// ---------------------------------------------------------------------------

export async function extractSections(opts: ExtractSectionsOptions): Promise<ExtractSectionsOutcome> {
  const concurrency = Math.max(1, Math.min(8, opts.concurrency ?? 2));
  const overallDeadlineMs = opts.overallDeadlineMs ?? 120_000;
  const startedAt = Date.now();
  const results: SectionRunResult[] = [];
  const queue = [...opts.sections];
  let completed = 0;
  let deadlineExceeded = false;

  const active: Promise<void>[] = [];
  const workers = new Set<Promise<void>>();

  async function next(): Promise<void> {
    while (true) {
      // Synchronous atomic pop: any async work above this line risks another
      // worker draining the queue before we shift.
      const section = queue.shift();
      if (!section) return;
      if (deadlineExceeded) return;
      if (await opts.isCancelled?.()) {
        results.push({ section, outcome: "cancelled", category: "cancelled", durationMs: 0, attempts: 0 });
        while (queue.length > 0) {
          const s = queue.shift()!;
          results.push({ section: s, outcome: "cancelled", category: "cancelled", durationMs: 0, attempts: 0 });
        }
        return;
      }
      const remaining = overallDeadlineMs - (Date.now() - startedAt);
      if (remaining <= 500) {
        deadlineExceeded = true;
        results.push({ section, outcome: "timeout", category: "deadline_exceeded", durationMs: 0, attempts: 0 });
        while (queue.length > 0) {
          const s = queue.shift()!;
          results.push({ section: s, outcome: "timeout", category: "deadline_exceeded", durationMs: 0, attempts: 0 });
        }
        return;
      }
      const r = await runSingleSection(opts, section, remaining);
      results.push(r);
      completed++;
      try { await opts.onProgress?.(completed, opts.sections.length, section.sectionType); } catch {}
    }
  }

  for (let i = 0; i < concurrency; i++) {
    const w = next();
    workers.add(w);
    active.push(w.finally(() => workers.delete(w)));
  }
  await Promise.all(active);

  const success = results.filter((r) => r.outcome === "success").length;
  const failure = results.filter((r) => r.outcome === "failure").length;
  const timeout = results.filter((r) => r.outcome === "timeout").length;
  const cancelled = results.filter((r) => r.outcome === "cancelled").length;
  const haikuTotalMs = results.reduce((s, r) => s + r.durationMs, 0);
  const slowestSectionMs = results.reduce((m, r) => Math.max(m, r.durationMs), 0);

  return {
    results,
    totals: {
      total: opts.sections.length,
      success, failure, timeout, cancelled,
      haikuTotalMs, slowestSectionMs, concurrency,
      deadlineExceeded,
    },
  };
}
