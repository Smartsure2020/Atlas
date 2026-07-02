/**
 * Atlas Blueprint — appetite ingestion contract (REFINED)
 * ----------------------------------------------------------------------------
 * REPLACES the original Phase 2A version of this file. Only the prompt changes;
 * the validator and types are unchanged. Drop in over the existing file.
 *
 * What's new: explicit guidance for PORTFOLIO-LEVEL rules — the cross-cutting
 * limits/exclusions/referral-controls/new-business-requirements that apply
 * across an insurer's whole book regardless of product line. The earlier
 * prompt only asked for product_line × risk_type granular rules, which made
 * Claude drop these (correctly, given its instructions). We now ask for both,
 * with portfolio rules expressed as product_line="*" and risk_type="*".
 *
 * The matcher reads these rules as an OVERLAY: a portfolio rule applies in
 * addition to any product-specific rule that matched. So a body-corporate
 * quote against Infiniti gets scored against the body-corporate rule AND has
 * portfolio-level exclusions/triggers/required-docs applied on top.
 */

export const APPETITE_MODEL = "claude-sonnet-4-6";

export const APPETITE_SYSTEM_PROMPT = `
You are the appetite ingestion engine for Atlas, an internal underwriting
decision-support tool at a South African short-term insurance administrator.

Your ONLY job: read the supplied insurer guideline / wording / appetite document
and propose STRUCTURED APPETITE RULES as JSON. These proposals will be reviewed
and confirmed by an underwriting manager before they enter the live matrix.

YOU MUST CAPTURE TWO KINDS OF RULES:

(A) PRODUCT-SPECIFIC RULES — one rule per product_line × risk_type combination
    the document genuinely addresses. RICH granularity: do not collapse
    distinct risks into one rule. Examples:
      - "buildings" × "body_corporate"
      - "motor" × "personal_vehicle"
      - "sectional_title" × "free_standing_house"

(B) PORTFOLIO-LEVEL RULES — cross-cutting rules that apply across the
    insurer's whole book regardless of product line. Express these with
    product_line="*" AND risk_type="*". Examples of portfolio-level content:
      - Territorial limits ("South Africa only", "worldwide ex USA/Canada")
      - Blanket exclusions (war, nuclear, pandemic, cyber loss, hire/reward)
      - Standard referral controls (backdated endorsements, credits over R5k,
        dual insurance, staff policies)
      - Hard underwriting limits (sum insured caps applying across all sections)
      - New-business requirements (proposal form, 3-year claims, GRIP report,
        client declaration, inventory form below a threshold)
      - Residency requirements ("RSA resident only")

    Capture portfolio rules ONLY when the document genuinely describes them;
    do NOT invent portfolio rules to "complete" an insurer. If the document
    has no portfolio-level material, omit the portfolio rule entirely.

For BOTH kinds of rule, the same JSON shape applies.

STRICT RULES:
- Return ONLY a single JSON object. No prose, no markdown, no code fences.
- Do NOT invent rules. Extract only what the document supports.
- appetite_level (per the document):
    preferred  -> actively encouraged / listed as core appetite
    standard   -> accepted / written routinely without special conditions
    caution    -> accepted with conditions, referral, or warnings
    declined   -> explicitly excluded or refused
  For PORTFOLIO RULES that primarily express exclusions/limits/referrals,
  appetite_level="standard" is the right baseline — the meaningful content
  lives in declined_risks / caution_risks / referral_triggers / required_documents.
- preferred_risks / caution_risks / declined_risks: ARRAYS of characteristic
  strings drawn from the document (e.g. "thatch roof", "coastal within 5km",
  "war", "nuclear", "pandemic"). Empty array if none.
- referral_triggers: array of conditions forcing referral/senior review
  rather than disqualifying (e.g. "sum insured > R50m", "backdated endorsement",
  "credit over R5,000"). Empty array if none.
- required_documents: array of documents this insurer needs to quote
  (e.g. "proposal form", "3-year claims history", "GRIP report"). Empty if none.
- source_quote: short verbatim phrase (under 15 words) from the document that
  supports the proposal, so the manager can find it in the source. Use null if
  the PDF text is not clear enough to quote safely. Never invent source text.
- source_page: page number where the supporting wording appears, or null if unknown.
- source_section: heading/section where the supporting wording appears, or null if unknown.
- line_of_business: "personal", "commercial", or "both" when the guideline makes the scope clear; otherwise null.
- rating_notes: rating, limits, excess, or underwriting nuance that should help the manager but should not become a hard match by itself.
- confidence: 0..1 — how unambiguously the document supports the proposal.

Use South African insurance context (sectional title, body corporate, SASRIA,
CSOS, ZAR, etc.).

Return JSON in EXACTLY this shape:

{
  "insurer_summary": "one-sentence overview of this insurer's appetite per the document",
  "rules": [
    {
      "product_line": "buildings|motor|sectional_title|fleet|*|...",
      "risk_type": "body_corporate|commercial_building|transport|*|...",
      "appetite_level": "preferred|standard|caution|declined",
      "preferred_risks": [],
      "caution_risks": [],
      "declined_risks": [],
      "required_documents": [],
      "referral_triggers": [],
      "notes": "free text any nuance not captured above",
      "rating_notes": "rating/underwriting nuance, or empty string",
      "line_of_business": "personal|commercial|both|null",
      "source_quote": "short verbatim phrase from the document, or null",
      "source_page": 0,
      "source_section": "heading/section, or null",
      "confidence": 0
    }
  ],
  "document_notes": [
    {"note": "anything the manager should know — unreadable section, ambiguity, etc."}
  ]
}

If the document is a scan with no readable text, return an empty rules array
and a document_notes entry explaining why. Do not fabricate rules.
`.trim();

export interface ProposedRule {
  product_line: string;
  risk_type: string;
  appetite_level: "preferred" | "standard" | "caution" | "declined";
  preferred_risks: string[];
  caution_risks: string[];
  declined_risks: string[];
  required_documents: string[];
  referral_triggers: string[];
  notes: string;
  rating_notes: string;
  line_of_business: "personal" | "commercial" | "both" | null;
  source_quote: string | null;
  source_page: number | null;
  source_section: string | null;
  confidence: number;
}

export interface IngestionResult {
  insurer_summary: string;
  rules: ProposedRule[];
  document_notes: { note: string }[];
}

const APPETITE_LEVELS = new Set(["preferred", "standard", "caution", "declined"]);
const LINES_OF_BUSINESS = new Set(["personal", "commercial", "both"]);

export function validateIngestion(obj: unknown): IngestionResult | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.rules)) return null;

  const rules: ProposedRule[] = [];
  for (const raw of o.rules) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (
      typeof r.product_line !== "string" ||
      typeof r.risk_type !== "string" ||
      typeof r.appetite_level !== "string" ||
      !APPETITE_LEVELS.has(r.appetite_level)
    ) return null;

    const arr = (k: string): string[] =>
      Array.isArray(r[k]) ? (r[k] as unknown[]).map(String) : [];

    const conf = Number(r.confidence);
    const sourcePage =
      r.source_page === null || r.source_page === undefined ? null : Number(r.source_page);
    const rawLine =
      typeof r.line_of_business === "string" ? r.line_of_business.trim().toLowerCase() : null;
    rules.push({
      product_line: r.product_line.trim(),
      risk_type: r.risk_type.trim(),
      appetite_level: r.appetite_level as ProposedRule["appetite_level"],
      preferred_risks: arr("preferred_risks"),
      caution_risks: arr("caution_risks"),
      declined_risks: arr("declined_risks"),
      required_documents: arr("required_documents"),
      referral_triggers: arr("referral_triggers"),
      notes: typeof r.notes === "string" ? r.notes : "",
      rating_notes: typeof r.rating_notes === "string" ? r.rating_notes : "",
      line_of_business:
        rawLine && LINES_OF_BUSINESS.has(rawLine)
          ? (rawLine as ProposedRule["line_of_business"])
          : null,
      source_quote:
        typeof r.source_quote === "string" && r.source_quote.trim()
          ? r.source_quote.trim()
          : null,
      source_page:
        sourcePage !== null && Number.isFinite(sourcePage) && sourcePage > 0
          ? Math.trunc(sourcePage)
          : null,
      source_section:
        typeof r.source_section === "string" && r.source_section.trim()
          ? r.source_section.trim()
          : null,
      confidence: Number.isFinite(conf) && conf >= 0 && conf <= 1 ? conf : 0,
    });
  }

  return {
    insurer_summary: typeof o.insurer_summary === "string" ? o.insurer_summary : "",
    rules,
    document_notes: Array.isArray(o.document_notes)
      ? (o.document_notes as Record<string, unknown>[])
          .filter((d) => d && typeof d.note === "string")
          .map((d) => ({ note: String(d.note) }))
      : [],
  };
}
