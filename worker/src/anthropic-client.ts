/**
 * Atlas hybrid pipeline — Anthropic client wrapper
 * ----------------------------------------------------------------------------
 * A thin wrapper around the Messages API that:
 *
 *  1. Names model IDs in one place — model choice is a routing decision, not
 *     scattered strings.
 *  2. Adds `cache_control` breakpoints on the stable system prompt so we get
 *     prompt-cache reads/writes instead of paying full input tokens per call.
 *  3. Parses the usage counters (input_tokens, cache_read_input_tokens,
 *     cache_creation_input_tokens, output_tokens) so the telemetry emitter
 *     can log them per job.
 *  4. Returns TTFT (first-byte latency) alongside total duration.
 *
 * NOTE: we deliberately keep this in the Worker only. The browser never talks
 * to Anthropic. Existing callers can migrate incrementally.
 */

export type AtlasModel =
  | "claude-haiku-4-5"      // default primary for structured/normalisation work
  | "claude-sonnet-4-6";    // reserved for bounded uncertainty escalation

export const ATLAS_MODEL_HAIKU: AtlasModel = "claude-haiku-4-5";
export const ATLAS_MODEL_SONNET: AtlasModel = "claude-sonnet-4-6";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** Cacheable text block: adds cache_control if `cache` is true. */
export function cacheableText(text: string, cache: boolean): unknown {
  const block: Record<string, unknown> = { type: "text", text };
  if (cache) block.cache_control = { type: "ephemeral" };
  return block;
}

export interface CallOptions {
  model: AtlasModel;
  system: string | unknown[];   // string OR array of content blocks (for cache)
  messages: { role: "user" | "assistant"; content: unknown }[];
  maxTokens: number;
  temperature?: number;
  apiKey: string;
  fetchImpl?: typeof fetch;
  abortSignal?: AbortSignal;
  /** Hard deadline for this single call. Enforced with an AbortController; on
   *  expiry the fetch is aborted and the thrown error is classified as
   *  `anthropic_timeout` — the exact category telemetry expects.
   */
  timeoutMs?: number;
}

/**
 * Privacy-safe failure categories. Callers translate these into the pipeline
 * metric's fallback_reason without leaking provider bodies or PII.
 *
 * Semantic split (important for retry policy):
 *   invalid_request       — WE sent the wrong shape (bad model id, malformed
 *                           messages, forbidden field, auth-tier mismatch,
 *                           schema error at the HTTP layer). Retrying with a
 *                           different model does NOT help.
 *   invalid_model_output  — The model REPLIED with something we cannot use
 *                           (non-JSON, wrong keys, truncated). This is worth
 *                           ONE bounded retry with a larger model.
 *   `schema_failure` is retained as an alias for invalid_model_output to keep
 *   the pipeline metric column stable during rollout.
 */
export type AnthropicFailureCategory =
  | "timeout"
  | "network_failure"
  | "auth_failed"
  | "rate_limited"
  | "server_error"
  | "invalid_request"
  | "output_truncated"
  | "invalid_model_output"
  | "schema_failure"           // alias of invalid_model_output; do not remove
  | "unknown_failure";

export interface Usage {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
}

export interface CallResult {
  text: string;
  usage: Usage;
  model: string;
  ttftMs: number | null;   // first-byte latency; null when not streamed
  totalMs: number;
  status: number;
}

export class AnthropicCallError extends Error {
  constructor(
    public code: string,
    public status: number,
    public detail: string,
    public category: AnthropicFailureCategory = "unknown_failure",
    /**
     * Bounded delay hint parsed from the provider's `Retry-After` header on
     * rate-limit / server-error responses. `null` when the header was absent
     * or unparseable. Callers must clamp this against their own remaining
     * budget — the value is bounded here (0..RETRY_AFTER_MAX_MS) but has no
     * knowledge of the caller's deadline.
     */
    public retryAfterMs: number | null = null
  ) {
    super(`${code} (${status})`);
  }
}

/**
 * Upper bound on a parsed Retry-After hint. A provider could send an absurdly
 * large delta-seconds or a far-future HTTP-date; we cap it so a misconfigured
 * upstream cannot lock the pipeline into a many-minute sleep.
 */
export const RETRY_AFTER_MAX_MS = 30_000;

/**
 * Parse a Retry-After header value per RFC 9110 §10.2.3: either a positive
 * delta-seconds integer, or an HTTP-date. Negative and non-finite values are
 * treated as absent. The result is clamped to `[0, RETRY_AFTER_MAX_MS]`.
 * Returns `null` when the header is missing or unparseable.
 */
export function parseRetryAfterMs(header: string | null | undefined, now: number = Date.now()): number | null {
  if (header == null) return null;
  const raw = String(header).trim();
  if (!raw) return null;
  // delta-seconds form (integer, may include a fractional part in practice)
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) {
    if (asNumber < 0) return 0;
    return Math.min(Math.round(asNumber * 1000), RETRY_AFTER_MAX_MS);
  }
  // HTTP-date form
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) {
    const delta = asDate - now;
    if (delta <= 0) return 0;
    return Math.min(delta, RETRY_AFTER_MAX_MS);
  }
  return null;
}

/**
 * Map an unknown thrown error / HTTP status into a privacy-safe category.
 * Never returns provider text — telemetry emits the category alone.
 */
export function classifyAnthropicError(err: unknown): AnthropicFailureCategory {
  if (err instanceof AnthropicCallError) return err.category;
  if (err && typeof err === "object") {
    const e = err as { name?: string; message?: string; code?: string };
    const name = String(e.name ?? "");
    const msg = String(e.message ?? "").toLowerCase();
    if (name === "AbortError" || msg.includes("aborted") || msg.includes("timeout")) return "timeout";
    if (msg.includes("fetch") || msg.includes("network") || msg.includes("ecconn") || msg.includes("enotfound")) {
      return "network_failure";
    }
    if (msg.includes("json") || msg.includes("unexpected token")) return "invalid_model_output";
  }
  return "unknown_failure";
}

/** HTTP status → category. Used by the wrapper for non-2xx responses. */
export function categoryFromStatus(status: number): AnthropicFailureCategory {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 404 || status === 422) return "invalid_request";
  if (status >= 500 && status < 600) return "server_error";
  return "unknown_failure";
}

/**
 * Non-streaming call. Returns usage counters so callers can log cache hits.
 * TTFT for the non-streaming variant is not observable; we return null.
 */
export async function anthropicCall(opts: CallOptions): Promise<CallResult> {
  const started = Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;

  const body = {
    model: opts.model,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature ?? 0,
    system: opts.system,
    messages: opts.messages,
  };

  // Combine caller abort + optional deadline into a single signal so we
  // classify local timeouts as `timeout` instead of `network_failure`.
  const controller = new AbortController();
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) controller.abort();
    else opts.abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timerId = setTimeout(() => { timedOut = true; controller.abort(); }, opts.timeoutMs);
  }

  let res: Response;
  try {
    res = await fetchImpl(ANTHROPIC_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": opts.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (timerId) clearTimeout(timerId);
    if (timedOut) {
      throw new AnthropicCallError("anthropic_timeout", 0, "local_deadline_exceeded", "timeout");
    }
    const category = classifyAnthropicError(err);
    throw new AnthropicCallError(
      category === "timeout" ? "anthropic_timeout" : "anthropic_network_error",
      0,
      (err as Error)?.message?.slice(0, 60) ?? "network",
      category
    );
  }
  if (timerId) clearTimeout(timerId);

  const totalMs = Date.now() - started;

  if (!res.ok) {
    // Extract a SHORT, code-only diagnostic. We deliberately do NOT include
    // the raw provider body — for `invalid_request` the body can echo our
    // own prompt fragments (which contain document text) back at us, and
    // that must never reach telemetry.
    let detail = "";
    try {
      const raw = await res.text();
      const codeMatch =
        raw.match(/"type"\s*:\s*"([a-z_]+_error|api_error|invalid_request_error)"/i) ??
        raw.match(/"error"\s*:\s*{[^}]*"type"\s*:\s*"([a-z_]+)"/i);
      detail = codeMatch ? codeMatch[1] : `status_${res.status}`;
    } catch {
      detail = `status_${res.status}`;
    }
    // Parse Retry-After for rate-limit and server-error responses so callers
    // can honour a provider-supplied backoff instead of a hard-coded delay.
    const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
    throw new AnthropicCallError(
      `anthropic_${res.status}`,
      res.status,
      detail,
      categoryFromStatus(res.status),
      retryAfterMs
    );
  }

  const data = (await res.json()) as {
    content?: { type: string; text?: string }[];
    model?: string;
    stop_reason?: string;
    usage?: Partial<Usage>;
  };
  const text = (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  const usage: Usage = {
    input_tokens: data.usage?.input_tokens ?? 0,
    cache_read_input_tokens: data.usage?.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: data.usage?.cache_creation_input_tokens ?? 0,
    output_tokens: data.usage?.output_tokens ?? 0,
  };
  if (data.stop_reason === "max_tokens") {
    throw new AnthropicCallError(
      "anthropic_output_truncated",
      res.status,
      `max_tokens=${opts.maxTokens}`,
      "output_truncated"
    );
  }
  return { text, usage, model: data.model ?? opts.model, ttftMs: null, totalMs, status: res.status };
}

/**
 * Convenience: parse a JSON reply that may include ```json fences. A parse
 * error is `invalid_model_output` — the model gave us something we cannot
 * use, distinct from an invalid API request. The `detail` field carries a
 * short, redacted error message; the raw reply body is intentionally NOT
 * logged so PDF/PII content cannot leak into telemetry.
 */
export function parseJsonReply<T = unknown>(text: string): T {
  const clean = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean) as T;
  } catch (err) {
    throw new AnthropicCallError(
      "anthropic_invalid_model_output",
      200,
      (err as Error)?.message?.slice(0, 60) ?? "json_parse",
      "invalid_model_output"
    );
  }
}
