export type MissingInfoItemType =
  | "document"
  | "quote_term"
  | "underwriting_info"
  | "referral_info"
  | "other";

export type MissingInfoStatus = "open" | "requested" | "received" | "waived" | "not_required";
export type MissingInfoSource = "extraction" | "quote_review" | "manual" | "rule";
export type MissingInfoOwner =
  | "broker"
  | "client"
  | "consultant"
  | "insurer"
  | "senior_underwriter"
  | "unknown";

export type CommunicationType =
  | "missing_info_request"
  | "referral_pack"
  | "review_summary"
  | "broker_note"
  | "internal_note"
  | "other";

export type CommunicationAudience =
  | "broker"
  | "client"
  | "insurer"
  | "senior_underwriter"
  | "internal"
  | "unknown";

export type CommunicationStatus = "draft" | "copied" | "sent_manually" | "archived";

export interface CommunicationLike {
  id?: string;
  submission_id?: string;
  quote_review_id?: string | null;
  communication_type: CommunicationType;
  audience: CommunicationAudience;
  subject?: string | null;
  body: string;
  status: CommunicationStatus;
  related_missing_info_item_ids?: string[] | null;
  related_section_keys?: string[] | null;
  created_at?: string;
  updated_at?: string;
  sent_at?: string | null;
  notes?: string | null;
}

export interface MissingInfoItemInput {
  submission_id?: string;
  quote_review_id?: string | null;
  section_key?: string | null;
  item_type: MissingInfoItemType;
  title: string;
  description?: string | null;
  status?: MissingInfoStatus;
  required_by_rule_id?: string | null;
  source: MissingInfoSource;
  owner?: MissingInfoOwner;
  due_date?: string | null;
  notes?: string | null;
}

export interface MissingInfoItem extends MissingInfoItemInput {
  id?: string;
  status: MissingInfoStatus;
  owner: MissingInfoOwner;
  created_at?: string;
  updated_at?: string;
  resolved_at?: string | null;
}

export interface ReviewSectionLike {
  section_key: string;
  section_name: string;
  matched_rule_id?: string | null;
  status?: string;
  findings?: string[];
  missing_documents?: string[];
  referral_triggers?: string[];
  declined_reasons?: string[];
  rating_findings?: string[];
  excess_findings?: string[];
  warranty_findings?: string[];
  source_evidence?: {
    consultant_explanation?: string;
    rule?: { source_quote?: string | null; source_file_name?: string | null } | null;
  };
}

export interface ReviewLike {
  id?: string;
  status: string;
  overall_outcome?: string;
  overall_confidence?: number;
  created_at?: string;
  recommendation_id?: string | null;
  insurer_id?: string | null;
  manual_review_required?: boolean;
  created_by?: string | null;
  review_snapshot?: {
    quote_terms?: {
      insurer_name?: string | null;
      quote_reference?: string | null;
      quote_date?: string | null;
      sections?: { section_name?: string; premium?: unknown; sum_insured?: unknown }[];
    };
    reviewed_json?: Record<string, unknown>;
  };
}

const DISCLAIMER =
  "Atlas is a decision-support review tool. This output does not bind cover, confirm acceptance, or replace underwriting authority.";

export function withControlledHeader(title: string, body: string, generatedAt = new Date().toISOString()): string {
  return [
    title,
    `Generated: ${generatedAt}`,
    DISCLAIMER,
    "",
    body.trim(),
  ].join("\n");
}

export function communicationDedupeKey(input: {
  submission_id?: string;
  quote_review_id?: string | null;
  communication_type: CommunicationType;
  audience: CommunicationAudience;
  body: string;
}): string {
  return [
    input.submission_id ?? "",
    input.quote_review_id ?? "",
    input.communication_type,
    input.audience,
    input.body.trim().replace(/\s+/g, " ").toLowerCase(),
  ].join("|");
}

export function transitionCommunication(input: {
  current: CommunicationStatus;
  next: CommunicationStatus;
}): { status: CommunicationStatus; sent_at?: string | null } {
  return {
    status: input.next,
    sent_at: input.next === "sent_manually" ? new Date().toISOString() : undefined,
  };
}

export function validateMissingInfoStatusUpdate(input: {
  status: MissingInfoStatus;
  notes?: string | null;
}): string | null {
  if ((input.status === "waived" || input.status === "not_required") && !input.notes?.trim()) {
    return "notes_required";
  }
  return null;
}

export function missingInfoFromQuoteReview(input: {
  submissionId?: string;
  quoteReviewId?: string | null;
  sections: ReviewSectionLike[];
  extractionMissing?: { field?: string; reason_required?: string; priority?: string }[];
}): MissingInfoItemInput[] {
  const items: MissingInfoItemInput[] = [];
  for (const m of input.extractionMissing ?? []) {
    if (!m.field) continue;
    items.push({
      submission_id: input.submissionId,
      quote_review_id: input.quoteReviewId ?? null,
      section_key: null,
      item_type: "underwriting_info",
      title: m.field,
      description: m.reason_required ?? "Outstanding underwriting information.",
      status: "open",
      source: "extraction",
      owner: "broker",
    });
  }
  for (const section of input.sections) {
    for (const doc of section.missing_documents ?? []) {
      items.push({
        submission_id: input.submissionId,
        quote_review_id: input.quoteReviewId ?? null,
        section_key: section.section_key,
        item_type: "document",
        title: doc,
        description: `Required for ${section.section_name}.`,
        status: "open",
        required_by_rule_id: section.matched_rule_id ?? null,
        source: "quote_review",
        owner: "broker",
      });
    }
    for (const finding of [...(section.findings ?? []), ...(section.rating_findings ?? []), ...(section.excess_findings ?? []), ...(section.warranty_findings ?? [])]) {
      if (!/missing|unclear|unable_to_validate|required/i.test(finding)) continue;
      items.push({
        submission_id: input.submissionId,
        quote_review_id: input.quoteReviewId ?? null,
        section_key: section.section_key,
        item_type: /document/i.test(finding) ? "document" : "quote_term",
        title: section.section_name,
        description: finding,
        status: "open",
        required_by_rule_id: section.matched_rule_id ?? null,
        source: "quote_review",
        owner: "broker",
      });
    }
  }
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.section_key ?? ""}|${item.item_type}|${item.title}|${item.description ?? ""}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sectionLabel(item: MissingInfoItemInput | MissingInfoItem): string {
  return item.section_key ? item.section_key.replace(/_/g, " ") : "General";
}

export function generateMissingInfoRequestDraft(input: {
  recipient: "broker" | "client" | "internal";
  clientName?: string | null;
  brokerName?: string | null;
  items: (MissingInfoItemInput | MissingInfoItem)[];
  generatedAt?: string;
}): string {
  const openItems = input.items.filter((i) => !i.status || i.status === "open" || i.status === "requested");
  const grouped = new Map<string, (MissingInfoItemInput | MissingInfoItem)[]>();
  for (const item of openItems) {
    const label = sectionLabel(item);
    grouped.set(label, [...(grouped.get(label) ?? []), item]);
  }
  const greeting = input.recipient === "client" ? "Dear Client," : input.recipient === "broker" ? "Dear Broker," : "Internal missing information note:";
  const lines = [
    greeting,
    "",
    "Please could you assist with the below outstanding information so that we can complete the underwriting review.",
    "",
  ];
  for (const [section, items] of grouped) {
    lines.push(section, "-".repeat(section.length));
    const docs = items.filter((i) => i.item_type === "document");
    const clarifications = items.filter((i) => i.item_type !== "document");
    if (docs.length) {
      lines.push("Documents:");
      for (const item of docs) lines.push(`- ${item.title}${item.description ? `: ${item.description}` : ""}`);
    }
    if (clarifications.length) {
      lines.push("Clarifications:");
      for (const item of clarifications) lines.push(`- ${item.title}${item.description ? `: ${item.description}` : ""}`);
    }
    lines.push("");
  }
  lines.push(
    "This will help us complete the review. It does not confirm that cover has been accepted.",
    "",
    "Kind regards"
  );
  return withControlledHeader("Missing information request", lines.join("\n").trim(), input.generatedAt);
}

export function generateReferralPack(input: {
  review: ReviewLike;
  sections: ReviewSectionLike[];
  missingItems?: (MissingInfoItemInput | MissingInfoItem)[];
  consultantNotes?: string | null;
  generatedAt?: string;
}): string {
  const quote = input.review.review_snapshot?.quote_terms;
  const lines = [
    "Referral summary for review",
    "",
    `Client/insured: ${quote?.insurer_name ? quote.insurer_name : "Not specified"}`,
    `Quote reference: ${quote?.quote_reference ?? "Not specified"}`,
    `Overall Atlas outcome: ${input.review.status}`,
    input.review.id ? `Quote review reference: ${input.review.id}` : "",
    "",
    "Section outcomes:",
  ].filter(Boolean);
  for (const section of input.sections) {
    lines.push(`- ${section.section_name}: ${section.status ?? "unknown"}`);
    for (const trigger of section.referral_triggers ?? []) lines.push(`  Referral trigger: ${trigger}`);
    for (const reason of section.declined_reasons ?? []) lines.push(`  Declined issue: ${reason}`);
    const ruleQuote = section.source_evidence?.rule?.source_quote;
    if (ruleQuote) lines.push(`  Rule evidence: ${ruleQuote}`);
  }
  const missing = input.missingItems?.filter((i) => !i.status || i.status === "open" || i.status === "requested") ?? [];
  if (missing.length) {
    lines.push("", "Outstanding information:");
    for (const item of missing) lines.push(`- ${sectionLabel(item)}: ${item.title}`);
  }
  if (input.consultantNotes?.trim()) lines.push("", "Consultant notes:", input.consultantNotes.trim());
  lines.push("", "This is a referral summary for review only and does not bind cover.");
  return withControlledHeader("Referral pack", lines.join("\n"), input.generatedAt);
}

export function generateQuoteReviewSummary(input: {
  review: ReviewLike;
  sections: ReviewSectionLike[];
  decision?: { decision_choice?: string | null; decision_status?: string | null; decision_reason?: string | null } | null;
  generatedAt?: string;
}): string {
  const lines = [
    "Quote review summary",
    "",
    `Overall result: ${input.review.status}`,
    `Review date: ${input.review.created_at ?? "Not recorded"}`,
    input.decision ? `Decision: ${input.decision.decision_choice ?? input.decision.decision_status}${input.decision.decision_reason ? ` - ${input.decision.decision_reason}` : ""}` : "",
    "",
    "Sections:",
  ].filter(Boolean);
  for (const section of input.sections) {
    lines.push(`- ${section.section_name}: ${section.status ?? "unknown"}`);
    const issues = [
      ...(section.referral_triggers ?? []).map((x) => `Referral: ${x}`),
      ...(section.declined_reasons ?? []).map((x) => `Declined: ${x}`),
      ...(section.missing_documents ?? []).map((x) => `Missing: ${x}`),
      ...(section.rating_findings ?? []),
      ...(section.excess_findings ?? []),
      ...(section.warranty_findings ?? []),
    ];
    for (const issue of issues) lines.push(`  - ${issue}`);
    const ruleQuote = section.source_evidence?.rule?.source_quote;
    if (ruleQuote) lines.push(`  Rule evidence: ${ruleQuote}`);
  }
  return withControlledHeader("Quote review summary", lines.join("\n"), input.generatedAt);
}

export function buildComparisonRows(input: {
  reviews: ReviewLike[];
  sectionsByReview: Record<string, ReviewSectionLike[]>;
  decisionsByReview?: Record<string, { decision_choice?: string | null; decision_status?: string | null; decision_reason?: string | null }>;
  missingItemsByReview?: Record<string, (MissingInfoItem | MissingInfoItemInput)[]>;
}) {
  const rows = input.reviews.map((review) => {
    const id = review.id ?? "";
    const sections = input.sectionsByReview[id] ?? [];
    const quote = review.review_snapshot?.quote_terms;
    const openMissing = (input.missingItemsByReview?.[id] ?? []).filter((i) => !i.status || i.status === "open" || i.status === "requested");
    const statusCounts = {
      ok: sections.filter((s) => s.status === "ok").length,
      caution: sections.filter((s) => s.status === "caution").length,
      refer: sections.filter((s) => s.status === "refer").length,
      declined: sections.filter((s) => s.status === "declined").length,
      info_required: sections.filter((s) => s.status === "info_required").length,
      insufficient_rule_match: sections.filter((s) => s.status === "insufficient_rule_match").length,
    };
    const majorCount = sections.reduce(
      (n, s) =>
        n +
        (s.referral_triggers?.length ?? 0) +
        (s.declined_reasons?.length ?? 0) +
        (s.missing_documents?.length ?? 0),
      0
    );
    const totalPremium = quote?.sections?.reduce((sum, s) => sum + money(s.premium), 0) ?? 0;
    const referralCount = sections.reduce((n, s) => n + (s.referral_triggers?.length ?? 0), 0);
    const declinedCount = sections.reduce((n, s) => n + (s.declined_reasons?.length ?? 0), 0);
    const decision = input.decisionsByReview?.[id];
    return {
      quote_review_id: id,
      insurer: quote?.insurer_name ?? review.insurer_id ?? "Unknown",
      quote_reference: quote?.quote_reference ?? null,
      quote_date: quote?.quote_date ?? null,
      date: review.created_at ?? null,
      overall_status: review.status,
      total_premium: totalPremium || null,
      section_count: sections.length,
      status_counts: statusCounts,
      open_missing_info_count: openMissing.length,
      referral_count: referralCount,
      declined_count: declinedCount,
      manual_review_required: Boolean(review.manual_review_required || review.status === "review_required"),
      major_issue_count: majorCount,
      decision: decision?.decision_choice ?? decision?.decision_status ?? null,
      decision_reason: decision?.decision_reason ?? null,
      operationally_ready: declinedCount === 0 && referralCount === 0 && openMissing.length === 0 && review.status === "can_proceed",
      cheapest_comparable: false,
      comparability_warning: null as string | null,
    };
  });
  const comparableKeys = new Set(rows.map((r) => `${r.section_count}|${JSON.stringify(r.status_counts)}`));
  const premiums = rows.filter((r) => r.total_premium !== null);
  const cheapest = premiums.reduce<typeof rows[number] | null>(
    (best, row) => (!best || (row.total_premium ?? Infinity) < (best.total_premium ?? Infinity) ? row : best),
    null
  );
  for (const row of rows) {
    if (cheapest && row.quote_review_id === cheapest.quote_review_id) row.cheapest_comparable = true;
    if (rows.length > 1 && comparableKeys.size > 1) {
      row.comparability_warning = "Premiums may not be comparable because sections or outcomes differ.";
    }
  }
  return rows;
}

function money(value: unknown): number {
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const n = Number(text.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function buildManagerStats(input: {
  submissions: { id: string }[];
  reviews: ReviewLike[];
  missingItems: (MissingInfoItem | MissingInfoItemInput)[];
  decisions: { decision_choice?: string | null; ai_recommendation_accepted?: boolean | null }[];
  sections: ReviewSectionLike[];
  communications?: CommunicationLike[];
  filters?: {
    dateRange?: "7d" | "30d" | "90d" | "all";
    status?: string | null;
    insurerId?: string | null;
    consultantId?: string | null;
    lineOfBusiness?: string | null;
    outcome?: string | null;
    now?: string;
  };
}) {
  const filteredReviews = filterReviews(input.reviews, input.filters);
  const reviewsByStatus: Record<string, number> = {};
  for (const review of filteredReviews) reviewsByStatus[review.status] = (reviewsByStatus[review.status] ?? 0) + 1;
  const countCommon = (values: string[]) => {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([label, count]) => ({ label, count }));
  };
  return {
    total_submissions: input.submissions.length,
    quote_reviews_completed: filteredReviews.length,
    reviews_by_status: reviewsByStatus,
    missing_info_open_count: input.missingItems.filter((i) => !i.status || i.status === "open" || i.status === "requested").length,
    referrals_count: filteredReviews.filter((r) => r.status === "refer").length,
    declined_count: filteredReviews.filter((r) => r.status === "declined").length,
    overrides_count: input.decisions.filter((d) => d.decision_choice === "override" || d.ai_recommendation_accepted === false).length,
    communications_generated_count: input.communications?.length ?? 0,
    communications_sent_manually_count: input.communications?.filter((c) => c.status === "sent_manually").length ?? 0,
    common_missing_information: countCommon(input.missingItems.map((i) => i.title)),
    common_referral_triggers: countCommon(input.sections.flatMap((s) => s.referral_triggers ?? [])),
    common_declined_reasons: countCommon(input.sections.flatMap((s) => s.declined_reasons ?? [])),
    recent_reviews_needing_attention: filteredReviews
      .filter((r) => ["refer", "declined", "info_required", "review_required"].includes(r.status))
      .slice(0, 10),
  };
}

function filterReviews(
  reviews: ReviewLike[],
  filters: {
    dateRange?: "7d" | "30d" | "90d" | "all";
    status?: string | null;
    insurerId?: string | null;
    consultantId?: string | null;
    lineOfBusiness?: string | null;
    outcome?: string | null;
    now?: string;
  } = {}
): ReviewLike[] {
  const now = filters.now ? new Date(filters.now).getTime() : Date.now();
  const days = filters.dateRange === "7d" ? 7 : filters.dateRange === "30d" ? 30 : filters.dateRange === "90d" ? 90 : null;
  return reviews.filter((review) => {
    if (days !== null && review.created_at) {
      const t = new Date(review.created_at).getTime();
      if (Number.isFinite(t) && now - t > days * 24 * 60 * 60 * 1000) return false;
    }
    if (filters.status && review.status !== filters.status) return false;
    if (filters.outcome && review.status !== filters.outcome) return false;
    if (filters.insurerId && review.insurer_id !== filters.insurerId) return false;
    if (filters.consultantId && review.created_by !== filters.consultantId) return false;
    if (filters.lineOfBusiness) {
      const snapshot = review.review_snapshot?.reviewed_json as Record<string, unknown> | undefined;
      const raw = JSON.stringify(snapshot?.risk_classification ?? "").toLowerCase();
      if (!raw.includes(filters.lineOfBusiness.toLowerCase())) return false;
    }
    return true;
  });
}
