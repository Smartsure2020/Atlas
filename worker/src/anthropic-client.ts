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
}

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
  constructor(public code: string, public status: number, public detail: string) {
    super(`${code} (${status})`);
  }
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

  const res = await fetchImpl(ANTHROPIC_URL, {
    method: "POST",
    signal: opts.abortSignal,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": opts.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  const totalMs = Date.now() - started;

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200).replace(/\s+/g, " ");
    } catch {}
    throw new AnthropicCallError(`anthropic_${res.status}`, res.status, detail);
  }

  const data = (await res.json()) as {
    content?: { type: string; text?: string }[];
    model?: string;
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
  return { text, usage, model: data.model ?? opts.model, ttftMs: null, totalMs, status: res.status };
}

/** Convenience: parse a JSON reply that may include ```json fences. */
export function parseJsonReply<T = unknown>(text: string): T {
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean) as T;
}
