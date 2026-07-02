import type { AppetiteRow } from "./matcher-types.js";
import { canonicalTaxonomyKey } from "./taxonomy.js";

export type QuoteReviewStatus =
  | "draft"
  | "review_required"
  | "can_proceed"
  | "refer"
  | "declined"
  | "info_required"
  | "overridden";

export type QuoteReviewSectionStatus =
  | "ok"
  | "caution"
  | "refer"
  | "declined"
  | "info_required"
  | "insufficient_rule_match";

export interface QuoteTermSection {
  section_key: string;
  section_name: string;
  premium?: unknown;
  rate?: unknown;
  sum_insured?: unknown;
  excess?: unknown;
  cover_limit?: unknown;
  warranties?: unknown[];
  endorsements?: unknown[];
  exclusions?: unknown[];
  conditions?: unknown[];
  required_documents?: unknown[];
  notes?: unknown[];
  source?: unknown;
}

export interface QuoteTerms {
  insurer_name?: string | null;
  quote_reference?: string | null;
  quote_date?: string | null;
  quote_expiry_date?: string | null;
  insured_name?: string | null;
  risk_address?: string | null;
  sections: QuoteTermSection[];
  required_documents: string[];
  notes: string[];
}

export interface QuoteReviewSection {
  section_key: string;
  section_name: string;
  matched_rule_id: string | null;
  status: QuoteReviewSectionStatus;
  confidence: number;
  findings: string[];
  missing_documents: string[];
  referral_triggers: string[];
  declined_reasons: string[];
  rating_findings: string[];
  excess_findings: string[];
  warranty_findings: string[];
  source_evidence: Record<string, unknown>;
  consultant_explanation: string;
}

export interface QuoteReviewResult {
  status: QuoteReviewStatus;
  overall_outcome: QuoteReviewStatus;
  overall_confidence: number;
  manual_review_required: boolean;
  quote_terms: QuoteTerms;
  sections: QuoteReviewSection[];
  findings: string[];
}

const ISOLATION_SENSITIVE = new Set([
  "public_liability",
  "theft",
  "business_all_risks",
  "accidental_damage",
  "accounts_receivable",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function fieldValue(reviewed: Record<string, unknown>, section: string, key: string): unknown {
  const sec = reviewed[section];
  if (!isRecord(sec)) return undefined;
  const field = sec[key];
  if (isRecord(field) && "value" in field) return field.value;
  return undefined;
}

function fieldConfidence(reviewed: Record<string, unknown>, section: string, key: string): number {
  const sec = reviewed[section];
  if (!isRecord(sec)) return 0.7;
  const field = sec[key];
  if (!isRecord(field)) return 0.7;
  const confidence = Number(field.confidence);
  return Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.7;
}

function strings(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const s = String(value).trim();
    return s ? [s] : [];
  }
  if (Array.isArray(value)) return value.flatMap(strings);
  if (isRecord(value)) return Object.values(value).flatMap(strings);
  return [];
}

function normalizeList(value: unknown): string[] {
  return strings(value).map((s) => s.trim()).filter(Boolean);
}

function textIncludesAny(haystack: string[], needles: string[]): string[] {
  const hay = haystack.join(" ").toLowerCase();
  return needles.filter((needle) => {
    const n = needle.toLowerCase().trim();
    return n && hay.includes(n);
  });
}

function parseMoney(value: unknown): number | null {
  const first = strings(value)[0];
  if (!first) return null;
  const normalized = first.replace(/[^0-9.,-]/g, "").replace(/,/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function parseRate(value: unknown): number | null {
  const first = strings(value)[0];
  if (!first) return null;
  const match = first.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function ratingBand(notes: string | null | undefined): { min?: number; max?: number } | null {
  if (!notes) return null;
  const text = notes.toLowerCase();
  const range = text.match(/([0-9]+(?:\.[0-9]+)?)\s*%?\s*(?:-|to)\s*([0-9]+(?:\.[0-9]+)?)\s*%/);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const max = text.match(/(?:max|maximum|not exceed|up to)\s*([0-9]+(?:\.[0-9]+)?)\s*%/);
  if (max) return { max: Number(max[1]) };
  const min = text.match(/(?:min|minimum|at least)\s*([0-9]+(?:\.[0-9]+)?)\s*%/);
  if (min) return { min: Number(min[1]) };
  return null;
}

function limitFromTrigger(trigger: string): number | null {
  const m = trigger.match(/(?:>|over|above|exceed(?:s|ing)?)\s*r?\s*([0-9][0-9,.\s]*)/i);
  if (!m) return null;
  const n = Number(m[1].replace(/[\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function quoteTermsFromReviewed(reviewed: Record<string, unknown>): QuoteTerms {
  const quoteSection = reviewed.quote_terms;
  const q = isRecord(quoteSection) ? quoteSection : {};
  const rawSections = fieldValue(reviewed, "quote_terms", "sections");
  const quoteSections = Array.isArray(rawSections) ? rawSections : [];

  const sections: QuoteTermSection[] = quoteSections
    .filter(isRecord)
    .map((item, index) => {
      const name = strings(item.section_name ?? item.section ?? item.name)[0] ?? `Section ${index + 1}`;
      const key = canonicalTaxonomyKey(strings(item.section_key ?? name)[0] ?? name);
      return {
        section_key: key || `section_${index + 1}`,
        section_name: name,
        premium: item.premium,
        rate: item.rate,
        sum_insured: item.sum_insured ?? item.sumInsured,
        excess: item.excess,
        cover_limit: item.cover_limit ?? item.limit,
        warranties: Array.isArray(item.warranties) ? item.warranties : [],
        endorsements: Array.isArray(item.endorsements) ? item.endorsements : [],
        exclusions: Array.isArray(item.exclusions) ? item.exclusions : [],
        conditions: Array.isArray(item.conditions) ? item.conditions : [],
        required_documents: Array.isArray(item.required_documents) ? item.required_documents : [],
        notes: Array.isArray(item.notes) ? item.notes : [],
        source: item.source,
      };
    });

  if (sections.length === 0) {
    const coverSections = normalizeList(fieldValue(reviewed, "current_cover", "cover_sections"));
    const sums = Array.isArray(fieldValue(reviewed, "current_cover", "sums_insured"))
      ? (fieldValue(reviewed, "current_cover", "sums_insured") as unknown[])
      : [];
    const excesses = Array.isArray(fieldValue(reviewed, "current_cover", "excesses"))
      ? (fieldValue(reviewed, "current_cover", "excesses") as unknown[])
      : [];
    for (const [index, name] of coverSections.entries()) {
      const key = canonicalTaxonomyKey(name) || `section_${index + 1}`;
      sections.push({
        section_key: key,
        section_name: name,
        sum_insured: sums[index],
        excess: excesses[index],
        warranties: normalizeList(fieldValue(reviewed, "current_cover", "warranties")),
        endorsements: normalizeList(fieldValue(reviewed, "current_cover", "endorsements")),
        exclusions: normalizeList(fieldValue(reviewed, "current_cover", "exclusions")),
        required_documents: normalizeList(fieldValue(reviewed, "current_cover", "required_documents")),
        notes: [],
      });
    }
  }

  return {
    insurer_name: strings(fieldValue(reviewed, "quote_terms", "insurer_name"))[0] ?? null,
    quote_reference: strings(fieldValue(reviewed, "quote_terms", "quote_reference"))[0] ?? null,
    quote_date: strings(fieldValue(reviewed, "quote_terms", "quote_date"))[0] ?? null,
    quote_expiry_date: strings(fieldValue(reviewed, "quote_terms", "quote_expiry_date"))[0] ?? null,
    insured_name: strings(fieldValue(reviewed, "quote_terms", "insured_name"))[0] ?? null,
    risk_address: strings(fieldValue(reviewed, "quote_terms", "risk_address"))[0] ?? null,
    sections,
    required_documents: normalizeList(fieldValue(reviewed, "quote_terms", "required_documents")),
    notes: normalizeList(fieldValue(reviewed, "quote_terms", "notes")),
  };
}

function findRule(section: QuoteTermSection, appetite: AppetiteRow[]): AppetiteRow | null {
  const sectionKey = canonicalTaxonomyKey(section.section_key || section.section_name);
  const candidates = appetite.filter((r) => canonicalTaxonomyKey(r.product_line) === sectionKey);
  return candidates[0] ?? null;
}

function portfolioRules(appetite: AppetiteRow[]): AppetiteRow[] {
  return appetite.filter((r) => r.product_line.trim() === "*" && r.risk_type.trim() === "*");
}

function deriveSectionStatus(section: QuoteReviewSection): QuoteReviewSectionStatus {
  if (section.declined_reasons.length > 0) return "declined";
  if (section.status === "insufficient_rule_match") return "insufficient_rule_match";
  if (section.referral_triggers.length > 0) return "refer";
  if (section.missing_documents.length > 0) return "info_required";
  if (
    section.rating_findings.length > 0 ||
    section.excess_findings.length > 0 ||
    section.warranty_findings.length > 0 ||
    section.findings.length > 0
  ) return "caution";
  return "ok";
}

export function buildQuoteReview(input: {
  reviewed: Record<string, unknown>;
  recommendation?: Record<string, unknown> | null;
  appetite: AppetiteRow[];
  availableDocuments: string[];
}): QuoteReviewResult {
  const quoteTerms = quoteTermsFromReviewed(input.reviewed);
  const activeRules = input.appetite.filter((r) => r.is_active);
  const globals = portfolioRules(activeRules);
  const availableDocs = input.availableDocuments.map((d) => d.toLowerCase());
  const sections: QuoteReviewSection[] = [];

  for (const quoteSection of quoteTerms.sections) {
    const rule = findRule(quoteSection, activeRules);
    const matchedRules = rule ? [rule, ...globals] : globals;
    const sectionText = [
      quoteSection.section_name,
      ...strings(quoteSection.notes),
      ...strings(quoteSection.warranties),
      ...strings(quoteSection.endorsements),
      ...strings(quoteSection.exclusions),
      ...strings(quoteSection.conditions),
    ];
    const result: QuoteReviewSection = {
      section_key: quoteSection.section_key,
      section_name: quoteSection.section_name,
      matched_rule_id: rule?.id ?? null,
      status: rule ? "ok" : "insufficient_rule_match",
      confidence: rule ? fieldConfidence(input.reviewed, "quote_terms", "sections") : 0.35,
      findings: [],
      missing_documents: [],
      referral_triggers: [],
      declined_reasons: [],
      rating_findings: [],
      excess_findings: [],
      warranty_findings: [],
      source_evidence: {
        rule: rule
          ? {
              id: rule.id,
              product_line: rule.product_line,
              risk_type: rule.risk_type,
              source_quote: rule.source_quote ?? null,
              source_page: rule.source_page ?? null,
              source_section: rule.source_section ?? null,
              source_file_name: rule.source_file_name ?? null,
            }
          : null,
        quote: quoteSection.source ?? null,
      },
      consultant_explanation: "",
    };

    if (!rule) {
      result.findings.push("No product-level appetite rule matched this quoted section.");
    }

    const requiredDocs = new Set<string>();
    for (const r of matchedRules) for (const doc of r.required_documents) requiredDocs.add(doc);
    for (const doc of requiredDocs) {
      const n = doc.toLowerCase();
      if (!availableDocs.some((d) => d.includes(n) || n.includes(d))) result.missing_documents.push(doc);
    }

    for (const r of matchedRules) {
      result.declined_reasons.push(...textIncludesAny(sectionText, r.declined_risks));
      result.referral_triggers.push(...textIncludesAny(sectionText, r.referral_triggers));
      for (const trigger of r.referral_triggers) {
        const limit = limitFromTrigger(trigger);
        const sumInsured = parseMoney(quoteSection.sum_insured ?? quoteSection.cover_limit);
        if (limit !== null && sumInsured !== null && sumInsured > limit) {
          result.referral_triggers.push(`${trigger} (quoted ${sumInsured} exceeds ${limit})`);
        }
      }
    }

    const sumInsured = parseMoney(quoteSection.sum_insured ?? quoteSection.cover_limit);
    const premium = parseMoney(quoteSection.premium);
    const quotedRate = parseRate(quoteSection.rate);
    if (sumInsured === null) result.findings.push("Sum insured or cover limit is missing or unclear.");
    if (premium !== null && sumInsured === null) result.rating_findings.push("unable_to_validate: premium exists but sum insured is missing.");

    const band = ratingBand(rule?.rating_notes ?? rule?.notes ?? null);
    if (band) {
      if (quotedRate === null) {
        result.rating_findings.push("unable_to_validate_rate: rating note exists but quoted rate is missing or unclear.");
      } else if ((band.min !== undefined && quotedRate < band.min) || (band.max !== undefined && quotedRate > band.max)) {
        result.rating_findings.push("rating_review_required: quoted rate appears outside the expected band.");
      }
    } else if (premium !== null && sumInsured !== null && quotedRate === null) {
      result.rating_findings.push("unable_to_validate_rate: premium and sum insured exist but no expected rate band is stored.");
    }

    if (strings(quoteSection.excess).length === 0) {
      const sensitive = ["theft", "glass", "accidental", "electronic", "fire", "motor"];
      if (sensitive.some((s) => quoteSection.section_name.toLowerCase().includes(s))) {
        result.excess_findings.push("Excess is missing or unclear for a section that normally needs one reviewed.");
      }
    }

    const warrantyText = [...strings(quoteSection.warranties), ...strings(quoteSection.endorsements), ...strings(quoteSection.conditions)];
    for (const r of matchedRules) {
      for (const expected of [...r.caution_risks, ...r.referral_triggers]) {
        if (/warranty|endorsement|condition|alarm|surge|transit|entry/i.test(expected)) {
          const found = textIncludesAny(warrantyText, [expected]).length > 0;
          if (!found) result.warranty_findings.push(`Missing or unclear warranty/endorsement: ${expected}`);
        }
      }
    }

    if (quoteTerms.sections.length === 1 && ISOLATION_SENSITIVE.has(canonicalTaxonomyKey(quoteSection.section_name))) {
      result.findings.push("Section may require review before being written in isolation.");
    }

    const business = strings(fieldValue(input.reviewed, "extracted_client", "occupation_or_business_description")).join(" ").toLowerCase();
    const quotedKeys = quoteTerms.sections.map((s) => canonicalTaxonomyKey(s.section_name));
    if (/restaurant|hotel|food|franchise/.test(business) && !quotedKeys.includes("public_liability")) {
      result.findings.push("Food or hospitality exposure detected without a clear liability/product liability section.");
    }
    if (/motor|vehicle|fleet|transport|delivery|courier/.test(business) && !quotedKeys.some((k) => k.includes("motor") || k === "goods_in_transit")) {
      result.findings.push("Motor or transit exposure detected without a clear motor/GIT section.");
    }

    result.status = deriveSectionStatus(result);
    result.consultant_explanation =
      result.status === "ok"
        ? "No blocking quote review issues were found for this section."
        : [
            ...result.declined_reasons.map((x) => `Declined: ${x}`),
            ...result.referral_triggers.map((x) => `Refer: ${x}`),
            ...result.missing_documents.map((x) => `Missing document: ${x}`),
            ...result.findings,
            ...result.rating_findings,
            ...result.excess_findings,
            ...result.warranty_findings,
          ].join(" ");
    sections.push(result);
  }

  if (sections.length === 0) {
    sections.push({
      section_key: "quote_terms",
      section_name: "Quote terms",
      matched_rule_id: null,
      status: "info_required",
      confidence: 0,
      findings: ["No quote sections could be identified from the reviewed extraction."],
      missing_documents: [],
      referral_triggers: [],
      declined_reasons: [],
      rating_findings: [],
      excess_findings: [],
      warranty_findings: [],
      source_evidence: {},
      consultant_explanation: "Atlas needs quote section terms before it can review the quote.",
    });
  }

  let status: QuoteReviewStatus = "can_proceed";
  if (sections.some((s) => s.status === "declined")) status = "declined";
  else if (sections.some((s) => s.status === "refer")) status = "refer";
  else if (sections.some((s) => s.status === "info_required")) status = "info_required";
  else if (sections.some((s) => s.status === "insufficient_rule_match")) status = "review_required";
  else if (sections.some((s) => s.status === "caution")) status = "review_required";

  const confidence = sections.reduce((sum, s) => sum + s.confidence, 0) / Math.max(1, sections.length);
  return {
    status,
    overall_outcome: status,
    overall_confidence: Math.max(0, Math.min(1, confidence)),
    manual_review_required: status !== "can_proceed",
    quote_terms: quoteTerms,
    sections,
    findings: sections.flatMap((s) => s.findings),
  };
}
