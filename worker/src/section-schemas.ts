/**
 * Atlas hybrid pipeline — focused per-section schemas
 * ----------------------------------------------------------------------------
 * Each section type gets a small, focused JSON contract that Haiku can emit
 * quickly (~500-1500 output tokens instead of 8000). The mapper turns the
 * focused reply into a PARTIAL of the canonical Atlas extraction, keyed by
 * dotted field paths so the deterministic merger can combine partials.
 *
 *   { "extracted_client.name": { value, page }, ... }
 *
 * The canonical extraction shape (extraction.ts) is unchanged; nothing here
 * introduces a new downstream schema.
 */

import type { SectionType } from "./section-splitter.js";

export interface SectionSchema {
  sectionType: SectionType;
  /** Small system prompt fragment scoped to this section only. */
  systemPromptFragment: string;
  /** Human-readable focused schema — sent inside the user message. */
  schemaHint: string;
  /** Approximate output-token cap for this section. */
  maxOutputTokens: number;
}

export interface FocusedField {
  value: unknown;
  page?: number | null;
  confidence?: number | null;
}

/** Partial canonical extraction produced from a focused section reply. */
export interface CanonicalPartial {
  /** Dotted-path patches, e.g. "extracted_client.name". */
  fieldPatches: Record<string, FocusedField>;
  /** Additive list entries produced by the section (cover_sections etc.). */
  listAppends: Record<string, FocusedField[]>;
  /** Free-form notes the section produced (goes into document_notes). */
  documentNotes: string[];
  sectionType: SectionType;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const COMMON_RULES = `
STRICT RULES:
- Return ONLY a single JSON object. No prose, no markdown, no code fences.
- Every value you emit MUST come from the supplied section text. Do NOT guess.
- When a field is not present, return {"value": null, "page": null}.
- Preserve source page numbers exactly as they appear in --- page N --- markers.
- Never invent monetary amounts, dates, or identifiers.
`.trim();

function fieldSpec(desc: string): string {
  return `{ "value": <${desc} | null>, "page": <int | null> }`;
}

export const SECTION_SCHEMAS: Record<SectionType, SectionSchema> = {
  policy_details: {
    sectionType: "policy_details",
    maxOutputTokens: 1500,
    systemPromptFragment: `You extract POLICY / INSURED DETAILS from a short-term insurance schedule section. ${COMMON_RULES}`,
    schemaHint: `Return exactly this shape:
{
  "insured_name":            ${fieldSpec("string — full legal name")},
  "co_insureds":             ${fieldSpec("array of strings")},
  "entity_type":             ${fieldSpec("string — e.g. individual, cc, pty_ltd")},
  "registration_or_id_number": ${fieldSpec("string")},
  "occupation_or_business":  ${fieldSpec("string")},
  "risk_address":            ${fieldSpec("string — full postal-style address")},
  "policy_number":           ${fieldSpec("string")},
  "insurer_name":            ${fieldSpec("string")},
  "policy_type":             ${fieldSpec("string — e.g. personal_lines, commercial_lines")},
  "inception_date":          ${fieldSpec("YYYY-MM-DD")},
  "renewal_date":            ${fieldSpec("YYYY-MM-DD")},
  "contract_type":           ${fieldSpec("string — e.g. annual, monthly")}
}`,
  },
  intermediary_details: {
    sectionType: "intermediary_details",
    maxOutputTokens: 800,
    systemPromptFragment: `You extract INTERMEDIARY / BROKER / ADMINISTRATOR details from a short-term insurance schedule section. ${COMMON_RULES}`,
    schemaHint: `Return exactly this shape:
{
  "broker_name":       ${fieldSpec("string")},
  "brokerage":         ${fieldSpec("string")},
  "broker_email":      ${fieldSpec("string")},
  "administrator":     ${fieldSpec("string")},
  "insurer_name":      ${fieldSpec("string")}
}`,
  },
  premium_index: {
    sectionType: "premium_index",
    maxOutputTokens: 1500,
    systemPromptFragment: `You extract the PREMIUM SUMMARY / INDEX OF COVER from a short-term insurance schedule section. ${COMMON_RULES}`,
    schemaHint: `Return exactly this shape:
{
  "included_covers":  { "value": <array of {"section": string, "included": bool}> | null, "page": <int | null> },
  "section_premiums": { "value": <array of {"section": string, "premium": string}> | null, "page": <int | null> },
  "section_sums":     { "value": <array of {"section": string, "sum_insured": string}> | null, "page": <int | null> },
  "sasria":           ${fieldSpec("string — annual SASRIA amount if present")},
  "fees":             { "value": <array of {"fee_type": string, "amount": string}> | null, "page": <int | null> },
  "total_premium":    ${fieldSpec("string — including currency symbol")}
}`,
  },
  buildings: {
    sectionType: "buildings",
    maxOutputTokens: 1200,
    systemPromptFragment: `You extract the BUILDINGS section of a short-term insurance schedule. ${COMMON_RULES}`,
    schemaHint: `Return exactly this shape:
{
  "risk_address":  ${fieldSpec("string")},
  "sum_insured":   ${fieldSpec("string")},
  "premium":       ${fieldSpec("string")},
  "cover_type":    ${fieldSpec("string — e.g. all_risks, defined_perils")},
  "excess":        ${fieldSpec("string")},
  "endorsements":  { "value": <array of strings> | null, "page": <int | null> },
  "conditions":    { "value": <array of strings> | null, "page": <int | null> }
}`,
  },
  contents: {
    sectionType: "contents",
    maxOutputTokens: 1200,
    systemPromptFragment: `You extract the CONTENTS section of a short-term insurance schedule. ${COMMON_RULES}`,
    schemaHint: `Return exactly this shape:
{
  "risk_address":  ${fieldSpec("string")},
  "sum_insured":   ${fieldSpec("string")},
  "premium":       ${fieldSpec("string")},
  "cover_type":    ${fieldSpec("string")},
  "excess":        ${fieldSpec("string")},
  "endorsements":  { "value": <array of strings> | null, "page": <int | null> },
  "conditions":    { "value": <array of strings> | null, "page": <int | null> }
}`,
  },
  all_risks: {
    sectionType: "all_risks",
    maxOutputTokens: 1500,
    systemPromptFragment: `You extract ALL RISKS / PORTABLE POSSESSIONS from a short-term insurance schedule. ${COMMON_RULES}`,
    schemaHint: `Return exactly this shape:
{
  "specified_items":    { "value": <array of {"description": string, "value": string}> | null, "page": <int | null> },
  "unspecified_sum":    ${fieldSpec("string")},
  "premium":            ${fieldSpec("string")},
  "excess":             ${fieldSpec("string")},
  "conditions":         { "value": <array of strings> | null, "page": <int | null> }
}`,
  },
  personal_liability: {
    sectionType: "personal_liability",
    maxOutputTokens: 800,
    systemPromptFragment: `You extract PERSONAL / PUBLIC LIABILITY details from a short-term insurance schedule. ${COMMON_RULES}`,
    schemaHint: `Return exactly this shape:
{
  "sum_insured":  ${fieldSpec("string")},
  "premium":      ${fieldSpec("string")},
  "excess":       ${fieldSpec("string")},
  "conditions":   { "value": <array of strings> | null, "page": <int | null> }
}`,
  },
  motor: {
    sectionType: "motor",
    maxOutputTokens: 2500,
    systemPromptFragment: `You extract the MOTOR VEHICLES section of a short-term insurance schedule. Each vehicle is a separate object in the array. ${COMMON_RULES}`,
    schemaHint: `Return exactly this shape:
{
  "vehicles": { "value": <array of {
    "registration": <string | null>,
    "vin":          <string | null>,
    "make":         <string | null>,
    "model":        <string | null>,
    "year":         <int | string | null>,
    "sum_insured":  <string | null>,
    "cover_type":   <string | null>,
    "regular_driver": <string | null>,
    "excess":       <string | null>,
    "security_requirements": <array of strings | null>,
    "endorsements": <array of strings | null>
  }> | null, "page": <int | null> }
}`,
  },
  claims_history: {
    sectionType: "claims_history",
    maxOutputTokens: 1500,
    systemPromptFragment: `You extract CLAIMS HISTORY from a short-term insurance schedule. ${COMMON_RULES}`,
    schemaHint: `Return exactly this shape:
{
  "claims_history_available": ${fieldSpec("bool")},
  "claims_summary":           ${fieldSpec("string — brief text summary")},
  "loss_ratio_available":     ${fieldSpec("bool")},
  "claims_detail":            { "value": <array of {"date": string, "type": string, "amount": string, "status": string}> | null, "page": <int | null> }
}`,
  },
  excesses: {
    sectionType: "excesses",
    maxOutputTokens: 1200,
    systemPromptFragment: `You extract the EXCESSES / DEDUCTIBLES section from a short-term insurance schedule. ${COMMON_RULES}`,
    schemaHint: `Return exactly this shape:
{
  "excesses": { "value": <array of {"section": string, "basis": string, "amount": string, "minimum": string}> | null, "page": <int | null> }
}`,
  },
  endorsements: {
    sectionType: "endorsements",
    maxOutputTokens: 1500,
    systemPromptFragment: `You extract ENDORSEMENTS / CONDITIONS / REFERRALS from a short-term insurance schedule. ${COMMON_RULES}`,
    schemaHint: `Return exactly this shape:
{
  "endorsements": { "value": <array of strings> | null, "page": <int | null> },
  "conditions":   { "value": <array of strings> | null, "page": <int | null> },
  "warranties":   { "value": <array of strings> | null, "page": <int | null> },
  "exclusions":   { "value": <array of strings> | null, "page": <int | null> }
}`,
  },
  other_cover: {
    sectionType: "other_cover",
    maxOutputTokens: 1500,
    systemPromptFragment: `You extract an OTHER (unclassified) insurance cover section. ${COMMON_RULES}`,
    schemaHint: `Return exactly this shape:
{
  "section_name":  ${fieldSpec("string — copy the source heading verbatim")},
  "sum_insured":   ${fieldSpec("string")},
  "premium":       ${fieldSpec("string")},
  "excess":        ${fieldSpec("string")},
  "notes":         { "value": <array of strings> | null, "page": <int | null> }
}`,
  },
  unclassified: {
    sectionType: "unclassified",
    maxOutputTokens: 1800,
    systemPromptFragment: `You are reading a fragment of a short-term insurance policy schedule. Extract only the anchor facts you can see. ${COMMON_RULES}`,
    schemaHint: `Return exactly this shape (any/all keys may be null):
{
  "insured_name":  ${fieldSpec("string")},
  "policy_number": ${fieldSpec("string")},
  "risk_address":  ${fieldSpec("string")},
  "total_premium": ${fieldSpec("string")},
  "renewal_date":  ${fieldSpec("YYYY-MM-DD")},
  "notes":         { "value": <array of strings> | null, "page": <int | null> }
}`,
  },
};

export function schemaFor(sectionType: SectionType): SectionSchema {
  return SECTION_SCHEMAS[sectionType] ?? SECTION_SCHEMAS.unclassified;
}

// ---------------------------------------------------------------------------
// Mapper: focused JSON → CanonicalPartial (dotted-path patches)
// ---------------------------------------------------------------------------

function asFocused(raw: unknown): FocusedField | null {
  if (raw == null) return null;
  if (typeof raw === "object" && !Array.isArray(raw) && "value" in (raw as object)) {
    const r = raw as { value?: unknown; page?: number | null; confidence?: number | null };
    return { value: r.value ?? null, page: typeof r.page === "number" ? r.page : null, confidence: typeof r.confidence === "number" ? r.confidence : null };
  }
  return { value: raw, page: null, confidence: null };
}

function set(patches: Record<string, FocusedField>, key: string, ff: FocusedField | null): void {
  if (!ff || ff.value == null) return;
  patches[key] = ff;
}

function appendList(lists: Record<string, FocusedField[]>, key: string, ff: FocusedField | null): void {
  if (!ff || ff.value == null) return;
  const values = Array.isArray(ff.value) ? ff.value : [ff.value];
  const arr = (lists[key] ??= []);
  for (const v of values) arr.push({ value: v, page: ff.page ?? null, confidence: ff.confidence ?? null });
}

export function mapFocusedReplyToPartial(
  sectionType: SectionType,
  reply: Record<string, unknown>
): CanonicalPartial {
  const patches: Record<string, FocusedField> = {};
  const lists: Record<string, FocusedField[]> = {};
  const notes: string[] = [];

  const get = (k: string) => asFocused(reply[k]);

  switch (sectionType) {
    case "policy_details": {
      set(patches, "extracted_client.name", get("insured_name"));
      set(patches, "extracted_client.entity_type", get("entity_type"));
      set(patches, "extracted_client.registration_or_id_number", get("registration_or_id_number"));
      set(patches, "extracted_client.occupation_or_business_description", get("occupation_or_business"));
      set(patches, "extracted_client.risk_address", get("risk_address"));
      set(patches, "quote_terms.quote_reference", get("policy_number"));
      set(patches, "current_cover.current_insurer", get("insurer_name"));
      set(patches, "current_cover.renewal_date", get("renewal_date"));
      const coIns = get("co_insureds");
      if (coIns && Array.isArray(coIns.value)) {
        for (const v of coIns.value) if (typeof v === "string") appendList(lists, "quote_terms.notes", { value: `co_insured:${v}`, page: coIns.page });
      }
      break;
    }
    case "intermediary_details": {
      set(patches, "broker.name", get("broker_name"));
      set(patches, "broker.brokerage", get("brokerage"));
      set(patches, "broker.email", get("broker_email"));
      set(patches, "current_cover.current_insurer", get("insurer_name"));
      break;
    }
    case "premium_index": {
      const covers = get("included_covers");
      if (covers && Array.isArray(covers.value)) {
        for (const c of covers.value) {
          if (c && typeof c === "object" && (c as { included?: boolean }).included) {
            const name = String((c as { section?: string }).section ?? "").trim();
            if (name) appendList(lists, "current_cover.cover_sections", { value: name, page: covers.page });
          }
        }
      }
      const sums = get("section_sums");
      if (sums && Array.isArray(sums.value)) {
        for (const s of sums.value) {
          if (s && typeof s === "object") {
            const desc = `${(s as { section?: string }).section ?? ""}: ${(s as { sum_insured?: string }).sum_insured ?? ""}`.trim();
            if (desc && desc !== ":") appendList(lists, "current_cover.sums_insured", { value: desc, page: sums.page });
          }
        }
      }
      set(patches, "current_cover.current_premium", get("total_premium"));
      break;
    }
    case "buildings":
    case "contents":
    case "all_risks":
    case "personal_liability":
    case "other_cover": {
      const cover = sectionType === "buildings" ? "buildings"
        : sectionType === "contents" ? "contents"
        : sectionType === "all_risks" ? "all_risks"
        : sectionType === "personal_liability" ? "personal_liability"
        : (get("section_name")?.value as string | undefined ?? "other").toString().toLowerCase();
      appendList(lists, "current_cover.cover_sections", { value: cover, page: get("sum_insured")?.page ?? null });
      const sum = get("sum_insured");
      if (sum && sum.value != null) {
        appendList(lists, "current_cover.sums_insured", { value: `${cover}: ${String(sum.value)}`, page: sum.page });
      }
      const excess = get("excess");
      if (excess && excess.value != null) {
        appendList(lists, "current_cover.excesses", { value: `${cover}: ${String(excess.value)}`, page: excess.page });
      }
      const ends = get("endorsements");
      if (ends && Array.isArray(ends.value)) for (const v of ends.value) if (typeof v === "string") appendList(lists, "current_cover.endorsements", { value: `${cover}: ${v}`, page: ends.page });
      const cond = get("conditions");
      if (cond && Array.isArray(cond.value)) for (const v of cond.value) if (typeof v === "string") appendList(lists, "current_cover.warranties", { value: `${cover}: ${v}`, page: cond.page });
      if (sectionType === "buildings" || sectionType === "contents") {
        set(patches, "extracted_client.risk_address", get("risk_address"));
      }
      break;
    }
    case "motor": {
      const vehicles = get("vehicles");
      appendList(lists, "current_cover.cover_sections", { value: "motor", page: vehicles?.page ?? null });
      if (vehicles && Array.isArray(vehicles.value)) {
        for (const v of vehicles.value) {
          if (v && typeof v === "object") {
            const veh = v as Record<string, unknown>;
            const desc = [veh.year, veh.make, veh.model, veh.registration ? `(${veh.registration})` : null]
              .filter((x) => x != null && String(x).trim() !== "")
              .join(" ").trim();
            if (desc) appendList(lists, "current_cover.sums_insured", { value: `motor: ${desc} — ${veh.sum_insured ?? ""}`, page: vehicles.page });
            if (veh.excess) appendList(lists, "current_cover.excesses", { value: `motor: ${desc} — ${veh.excess}`, page: vehicles.page });
            if (Array.isArray(veh.endorsements)) for (const e of veh.endorsements) if (typeof e === "string") appendList(lists, "current_cover.endorsements", { value: `motor: ${e}`, page: vehicles.page });
          }
        }
      }
      break;
    }
    case "claims_history": {
      set(patches, "claims.claims_history_available", get("claims_history_available"));
      set(patches, "claims.claims_summary", get("claims_summary"));
      set(patches, "claims.loss_ratio_available", get("loss_ratio_available"));
      break;
    }
    case "excesses": {
      const excesses = get("excesses");
      if (excesses && Array.isArray(excesses.value)) {
        for (const e of excesses.value) {
          if (e && typeof e === "object") {
            const rec = e as Record<string, unknown>;
            const s = `${rec.section ?? ""}: ${rec.basis ?? ""} ${rec.amount ?? ""}${rec.minimum ? ` (min ${rec.minimum})` : ""}`.trim();
            if (s.length > 2) appendList(lists, "current_cover.excesses", { value: s, page: excesses.page });
          }
        }
      }
      break;
    }
    case "endorsements": {
      for (const [k, field] of [
        ["endorsements", "current_cover.endorsements"],
        ["conditions", "current_cover.warranties"],
        ["warranties", "current_cover.warranties"],
        ["exclusions", "current_cover.exclusions"],
      ] as const) {
        const raw = get(k);
        if (raw && Array.isArray(raw.value)) for (const v of raw.value) if (typeof v === "string") appendList(lists, field, { value: v, page: raw.page });
      }
      break;
    }
    case "unclassified": {
      set(patches, "extracted_client.name", get("insured_name"));
      set(patches, "quote_terms.quote_reference", get("policy_number"));
      set(patches, "extracted_client.risk_address", get("risk_address"));
      set(patches, "current_cover.current_premium", get("total_premium"));
      set(patches, "current_cover.renewal_date", get("renewal_date"));
      const n = get("notes");
      if (n && Array.isArray(n.value)) for (const s of n.value) if (typeof s === "string") notes.push(s);
      break;
    }
  }

  return { fieldPatches: patches, listAppends: lists, documentNotes: notes, sectionType };
}
