/**
 * Atlas hybrid pipeline — Haiku normaliser + bounded Sonnet resolver
 * ----------------------------------------------------------------------------
 * Two focused LLM calls used by the orchestrator:
 *
 *   runHaikuNormalisation(...)
 *     Turns an already-extracted TEXT corpus into the canonical Atlas
 *     extraction JSON. Never receives the raw PDF. System prompt reuses the
 *     existing EXTRACTION_SYSTEM_PROMPT so downstream validation & schema
 *     are unchanged. `cache_control: ephemeral` sits on the stable system
 *     block for prompt-cache reads.
 *
 *   runSonnetBoundedResolution(...)
 *     Called ONLY when the deterministic validator escalates. Receives the
 *     specific field names, their current values, why they were flagged, and
 *     a small evidence pack (source-scoped pages). Sonnet returns a JSON
 *     object whose top-level keys are exactly the requested field names. The
 *     orchestrator merges only those keys — any out-of-scope change is
 *     rejected upstream.
 */

import type { Env } from "./config.js";
import { EXTRACTION_SYSTEM_PROMPT } from "./extraction.js";
import {
  ATLAS_MODEL_HAIKU,
  ATLAS_MODEL_SONNET,
  anthropicCall,
  parseJsonReply,
  type Usage,
} from "./anthropic-client.js";
import type { DocumentSection, SectionType } from "./section-splitter.js";
import { schemaFor, mapFocusedReplyToPartial, type CanonicalPartial } from "./section-schemas.js";

export type NormalisationUsage = Usage;

// ---------------------------------------------------------------------------
// Haiku normalisation
// ---------------------------------------------------------------------------

const HAIKU_INSTRUCTION_SUFFIX = `

You are being called by the Atlas HYBRID PIPELINE. The user message contains
ALREADY-EXTRACTED TEXT from PDFs and the broker email, with clear document /
page delimiters. Do NOT hallucinate anything not present in the text. When a
required field is missing, use the "not_found" status per the schema above.
Preserve the source page number for every field you extract when the input
labels pages (--- page N ---). Return ONLY the canonical JSON object.`;

export interface HaikuInput {
  env: Env;
  corpus: string;                     // page-delimited text — never raw PDF
  documentIds: string[];
  brokerEmailPresent: boolean;
}

export interface HaikuOutput {
  extraction: Record<string, unknown>;
  usage: NormalisationUsage;
  model: string;
}

export async function runHaikuNormalisation(input: HaikuInput): Promise<HaikuOutput> {
  const systemBlocks = [
    // Stable content — cacheable. The extraction system prompt is ~7K tokens
    // of instructions + canonical schema; caching this saves the majority of
    // input tokens per call after the first.
    {
      type: "text",
      text: EXTRACTION_SYSTEM_PROMPT + HAIKU_INSTRUCTION_SUFFIX,
      cache_control: { type: "ephemeral" },
    },
  ];

  const userMessage = [
    { type: "text", text: input.corpus.slice(0, 60_000) },
    {
      type: "text",
      text:
        "Now return the canonical JSON risk summary. " +
        "Broker email present: " + (input.brokerEmailPresent ? "yes" : "no") + ". " +
        "Documents supplied: " + input.documentIds.length + ".",
    },
  ];

  const result = await anthropicCall({
    model: ATLAS_MODEL_HAIKU,
    system: systemBlocks,
    messages: [{ role: "user", content: userMessage }],
    maxTokens: 8000,
    temperature: 0,
    apiKey: input.env.ANTHROPIC_API_KEY,
  });

  const extraction = parseJsonReply<Record<string, unknown>>(result.text);
  return { extraction, usage: result.usage, model: result.model };
}

// ---------------------------------------------------------------------------
// Bounded Sonnet resolution
// ---------------------------------------------------------------------------

export interface SonnetResolveField {
  field: string;              // dotted key, e.g. "extracted_client.name"
  currentValue: unknown;
  currentConfidence: number | null;
  reason: string;             // deterministic escalation reason
}

export interface SonnetResolveInput {
  env: Env;
  targetFields: string[];     // authoritative allow-list; nothing else may be returned
  currentValues: SonnetResolveField[];
  evidenceText: string;       // page-scoped, bounded corpus
}

export interface SonnetResolveOutput {
  resolvedFields: { field: string; value: unknown; page?: number | null }[];
  usage: NormalisationUsage;
  model: string;
}

const SONNET_SYSTEM = `
You are the BOUNDED RESOLVER for the Atlas hybrid extraction pipeline. The
primary extraction has already been performed. You are being asked to resolve
a SHORT list of specific fields that the deterministic validator could not
confirm.

STRICT RULES:
- Return ONLY a single JSON object.
- Its top-level keys MUST be a subset of the "target_fields" list in the user
  message. NO other keys.
- For each key, return:
    { "value": <the resolved value | null>, "page": <source page | null> }
- If the evidence does not support a value, return {"value": null, "page": null}.
- Do NOT invent values.
- Do NOT propose recommendations, premiums, or new fields.
- Preserve the shape/type of the field (string, number, array, object).
`.trim();

export async function runSonnetBoundedResolution(
  input: SonnetResolveInput
): Promise<SonnetResolveOutput> {
  const promptLines: string[] = [];
  promptLines.push("TARGET FIELDS (only these keys may appear in your reply):");
  for (const t of input.targetFields) promptLines.push(`- ${t}`);
  promptLines.push("");
  promptLines.push("CURRENT VALUES:");
  for (const cv of input.currentValues) {
    promptLines.push(
      `- ${cv.field}: value=${JSON.stringify(cv.currentValue)}, confidence=${cv.currentConfidence ?? "null"}, reason=${cv.reason}`
    );
  }
  promptLines.push("");
  promptLines.push("EVIDENCE (relevant page slices only):");
  promptLines.push(input.evidenceText);

  const result = await anthropicCall({
    model: ATLAS_MODEL_SONNET,
    system: [{ type: "text", text: SONNET_SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: promptLines.join("\n") }],
    maxTokens: 2000,
    temperature: 0,
    apiKey: input.env.ANTHROPIC_API_KEY,
  });

  const parsed = parseJsonReply<Record<string, { value?: unknown; page?: number | null } | unknown>>(result.text);
  const resolvedFields: SonnetResolveOutput["resolvedFields"] = [];
  const allowed = new Set(input.targetFields);
  for (const [k, v] of Object.entries(parsed ?? {})) {
    if (!allowed.has(k)) continue;                    // reject out-of-scope keys
    if (v && typeof v === "object" && "value" in (v as object)) {
      const entry = v as { value?: unknown; page?: number | null };
      resolvedFields.push({ field: k, value: entry.value, page: entry.page ?? null });
    } else {
      resolvedFields.push({ field: k, value: v, page: null });
    }
  }
  return { resolvedFields, usage: result.usage, model: result.model };
}

// ---------------------------------------------------------------------------
// Bounded per-section Sonnet fallback
// ---------------------------------------------------------------------------
// Called ONLY when a single section failed or timed out in the Haiku pass.
// Receives only that section's text (page-scoped), returns the SAME focused
// section schema, and is mapped through mapFocusedReplyToPartial. This is
// the mechanism that replaces sending the entire document through Sonnet.

export interface SonnetSectionInput {
  env: Env;
  section: DocumentSection;
  timeoutMs?: number;
}

export interface SonnetSectionOutput {
  sectionType: SectionType;
  partial: CanonicalPartial;
  usage: Usage;
  model: string;
}

export async function runSonnetSectionResolution(
  input: SonnetSectionInput
): Promise<SonnetSectionOutput> {
  const schema = schemaFor(input.section.sectionType);
  const system = [
    {
      type: "text",
      text: `${schema.systemPromptFragment}\n\nYou are the BOUNDED SECTION RESOLVER: the primary extractor could not read this section. Return ONLY the JSON described below. Do not invent values.`,
      cache_control: { type: "ephemeral" },
    },
    { type: "text", text: schema.schemaHint, cache_control: { type: "ephemeral" } },
  ];
  const userText = [
    `SECTION HEADING: ${input.section.heading}`,
    `SOURCE PAGES: ${input.section.pages.join(", ") || "unknown"}`,
    "",
    "SECTION TEXT:",
    input.section.text.length > 20_000 ? input.section.text.slice(0, 20_000) : input.section.text,
    "",
    "Return the focused JSON described in the system message.",
  ].join("\n");

  const result = await anthropicCall({
    model: ATLAS_MODEL_SONNET,
    system,
    messages: [{ role: "user", content: userText }],
    maxTokens: Math.max(1500, schema.maxOutputTokens),
    temperature: 0,
    apiKey: input.env.ANTHROPIC_API_KEY,
    timeoutMs: input.timeoutMs ?? 60_000,
  });
  const reply = parseJsonReply<Record<string, unknown>>(result.text);
  const partial = mapFocusedReplyToPartial(input.section.sectionType, reply);
  return {
    sectionType: input.section.sectionType,
    partial,
    usage: result.usage,
    model: result.model,
  };
}
