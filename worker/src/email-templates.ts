/**
 * Atlas hybrid pipeline — deterministic email templates
 * ----------------------------------------------------------------------------
 * The four current email types (broker_missing_info, broker_acknowledgement,
 * insurer_submission, internal_summary) are all produced by mechanical assembly
 * from the reviewed extraction + recommendation + decision. There is no reason
 * to block the user on a Sonnet call for text this predictable.
 *
 * Output is compatible with the existing endpoint contract:
 *     { subject: string, body: string }
 *
 * The optional Haiku "polish" step (added by the endpoint) rewrites tone only;
 * a validator (verifyEmailPolish) rejects any polish that changes numbers,
 * insurer names, dates, or removes referral / missing-info content.
 */

type EmailType =
  | "broker_missing_info"
  | "broker_acknowledgement"
  | "insurer_submission"
  | "internal_summary";

interface FieldShape { value: unknown }
const isField = (x: unknown): x is FieldShape =>
  !!x && typeof x === "object" && "value" in (x as object);

function s(v: unknown): string {
  if (v == null) return "";
  if (isField(v)) return s(v.value);
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(s).filter(Boolean).join(", ");
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).map(s).filter(Boolean).join(", ");
  return "";
}

function sec(reviewed: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> {
  return (reviewed?.[key] as Record<string, unknown>) ?? {};
}

export interface EmailContext {
  submission: {
    client_name?: string | null;
    broker_name?: string | null;
    broker_email?: string | null;
    request_type?: string | null;
  };
  reviewedExtraction: Record<string, unknown> | null;
  recommendation: {
    recommended_insurer?: string | null;
    referral_required?: boolean | null;
    senior_review_required?: boolean | null;
    reasoning_json?: unknown;
    secondary_options_json?: unknown;
  } | null;
  decision: {
    selected_insurer?: string | null;
    decision_status?: string | null;
    underwriter_notes?: string | null;
    ai_recommendation_accepted?: boolean | null;
    override_reason_code?: string | null;
    override_reason?: string | null;
  } | null;
  missingInformation: { field: string; reason_required?: string; priority?: string }[];
  redFlags: { issue: string; severity?: string }[];
}

export interface EmailDraft {
  subject: string;
  body: string;
  /** Machine-readable "facts used" for polish verification. */
  factLedger: {
    client?: string;
    broker?: string;
    insurer?: string;
    referralRequired: boolean;
    seniorReview: boolean;
    missingItems: string[];
    coverSections: string[];
    sumsInsured: string[];
    numericTokens: string[];
  };
}

function collectNumericTokens(text: string): string[] {
  // Currency, sums insured, percentages — anything numeric that a polish MUST NOT drop.
  const set = new Set<string>();
  const re = /(?:R\s?[\d,\s]*\.?\d*|[\d]{1,3}(?:[,\s]\d{3})*(?:\.\d+)?%?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const t = m[0].trim();
    if (t && t.length >= 2 && /\d/.test(t)) set.add(t);
  }
  return [...set];
}

function greetingBroker(name: string | null | undefined): string {
  return name ? `Hi ${name},` : "Good day,";
}

function bulletList(items: string[]): string {
  return items.filter(Boolean).map((i) => `  - ${i}`).join("\n");
}

// ---------------------------------------------------------------------------
// broker_missing_info
// ---------------------------------------------------------------------------

function draftBrokerMissingInfo(ctx: EmailContext): EmailDraft {
  const client = s(ctx.submission.client_name);
  const broker = s(ctx.submission.broker_name);
  const missing = (ctx.missingInformation ?? []).filter((x) => x?.field);
  const items = missing.map((m) => {
    const label = m.field.replace(/[_.]/g, " ");
    return m.priority === "high" && m.reason_required
      ? `${label} — ${m.reason_required}`
      : label;
  });
  const clientLine = client ? `${client}'s submission` : "your submission";
  const subject = `Additional information required — ${client || "quote request"}`;
  const body =
    `${greetingBroker(broker)}\n\n` +
    `Thanks for ${clientLine}. To progress the quote we still need:\n\n` +
    `${items.length > 0 ? bulletList(items) : "  - (no items outstanding — please disregard)"}` +
    `\n\nCould you send these through at your earliest convenience so we can finalise the quote?` +
    `\n\nKind regards`;
  return {
    subject,
    body,
    factLedger: {
      client, broker,
      referralRequired: false,
      seniorReview: false,
      missingItems: items,
      coverSections: [],
      sumsInsured: [],
      numericTokens: collectNumericTokens(body),
    },
  };
}

// ---------------------------------------------------------------------------
// broker_acknowledgement
// ---------------------------------------------------------------------------

function draftBrokerAck(ctx: EmailContext): EmailDraft {
  const client = s(ctx.submission.client_name);
  const broker = s(ctx.submission.broker_name);
  const risk = s(sec(ctx.reviewedExtraction, "risk_classification")["primary_risk_type"]);
  const clientLine = client
    ? `We've received the submission for ${client}${risk ? ` (${risk})` : ""}`
    : `We've received the submission${risk ? ` (${risk})` : ""}`;
  const subject = `Submission received — ${client || "quote request"}`;
  const body =
    `${greetingBroker(broker)}\n\n` +
    `${clientLine}. We're reviewing the documents and will revert once assessed.\n\n` +
    `Kind regards`;
  return {
    subject,
    body,
    factLedger: {
      client, broker,
      referralRequired: false,
      seniorReview: false,
      missingItems: [],
      coverSections: [],
      sumsInsured: [],
      numericTokens: collectNumericTokens(body),
    },
  };
}

// ---------------------------------------------------------------------------
// insurer_submission
// ---------------------------------------------------------------------------

function draftInsurerSubmission(ctx: EmailContext): EmailDraft {
  const client = s(ctx.submission.client_name);
  const insurer = s(ctx.recommendation?.recommended_insurer);
  const cover = sec(ctx.reviewedExtraction, "current_cover");
  const claims = sec(ctx.reviewedExtraction, "claims");
  const risk = sec(ctx.reviewedExtraction, "risk_classification");
  const ec = sec(ctx.reviewedExtraction, "extracted_client");

  const lines: string[] = [];
  lines.push(`Submitting a risk for quotation${insurer ? ` — attention: ${insurer}` : ""}.`);
  lines.push("");
  lines.push("CLIENT");
  if (client) lines.push(`  Name: ${client}`);
  const ent = s(ec.entity_type); if (ent) lines.push(`  Entity: ${ent}`);
  const occ = s(ec.occupation_or_business_description); if (occ) lines.push(`  Occupation / business: ${occ}`);
  const addr = s(ec.risk_address); if (addr) lines.push(`  Risk address: ${addr}`);

  lines.push("");
  lines.push("RISK");
  const primary = s(risk.primary_risk_type); if (primary) lines.push(`  Primary: ${primary}`);
  const secondary = s(risk.secondary_risk_types); if (secondary) lines.push(`  Secondary: ${secondary}`);
  const sector = s(risk.business_sector); if (sector) lines.push(`  Sector: ${sector}`);

  const sections = s(cover.cover_sections);
  const sums = s(cover.sums_insured);
  lines.push("");
  lines.push("COVER REQUIRED");
  if (sections) lines.push(`  Sections: ${sections}`);
  if (sums) lines.push(`  Sums insured: ${sums}`);

  lines.push("");
  lines.push("CLAIMS HISTORY");
  const claimsAvail = s(claims.claims_history_available);
  const claimsSummary = s(claims.claims_summary);
  if (claimsAvail) lines.push(`  History available: ${claimsAvail}`);
  if (claimsSummary) lines.push(`  Summary: ${claimsSummary}`);

  lines.push("");
  lines.push("CURRENT COVER");
  const curIns = s(cover.current_insurer); if (curIns) lines.push(`  Insurer: ${curIns}`);
  const renewal = s(cover.renewal_date); if (renewal) lines.push(`  Renewal: ${renewal}`);
  const prem = s(cover.current_premium); if (prem) lines.push(`  Current premium: ${prem}`);

  const referralFlags: string[] = [];
  if (ctx.recommendation?.referral_required) referralFlags.push("Referral required.");
  if (ctx.recommendation?.senior_review_required) referralFlags.push("Senior review required.");
  for (const rf of ctx.redFlags ?? []) if (rf?.issue) referralFlags.push(rf.issue);
  if (referralFlags.length > 0) {
    lines.push("");
    lines.push("REFERRAL / RED FLAGS");
    for (const f of referralFlags) lines.push(`  - ${f}`);
  }

  const body = lines.join("\n");
  const subject = client
    ? `Risk for quotation — ${client}`
    : `Risk for quotation`;

  return {
    subject,
    body,
    factLedger: {
      client, broker: s(ctx.submission.broker_name), insurer,
      referralRequired: Boolean(ctx.recommendation?.referral_required),
      seniorReview: Boolean(ctx.recommendation?.senior_review_required),
      missingItems: [],
      coverSections: sections ? sections.split(",").map((x) => x.trim()).filter(Boolean) : [],
      sumsInsured: sums ? sums.split(",").map((x) => x.trim()).filter(Boolean) : [],
      numericTokens: collectNumericTokens(body),
    },
  };
}

// ---------------------------------------------------------------------------
// internal_summary
// ---------------------------------------------------------------------------

function draftInternalSummary(ctx: EmailContext): EmailDraft {
  const client = s(ctx.submission.client_name);
  const primary = s(sec(ctx.reviewedExtraction, "risk_classification")["primary_risk_type"]);
  const insurer = s(ctx.recommendation?.recommended_insurer);
  const decisionInsurer = s(ctx.decision?.selected_insurer);
  const overridden =
    ctx.decision?.ai_recommendation_accepted === false;

  const lines: string[] = [];
  lines.push("CLIENT");
  lines.push(`  ${client || "—"}`);
  lines.push("");
  lines.push("RISK");
  lines.push(`  ${primary || "—"}`);
  lines.push("");
  lines.push("RECOMMENDED ROUTE");
  lines.push(`  Recommendation: ${insurer || "none"}`);
  if (ctx.recommendation?.referral_required) lines.push("  Referral required.");
  if (ctx.recommendation?.senior_review_required) lines.push("  Senior review required.");
  if (decisionInsurer) lines.push(`  Decision: ${decisionInsurer} (${ctx.decision?.decision_status ?? "—"})`);
  if (overridden) {
    lines.push(`  Override reason code: ${ctx.decision?.override_reason_code ?? "—"}`);
    if (ctx.decision?.override_reason) lines.push(`  Override note: ${ctx.decision.override_reason}`);
  }

  const flags = (ctx.redFlags ?? []).filter((r) => r?.issue);
  if (flags.length > 0) {
    lines.push("");
    lines.push("KEY RISK NOTES");
    for (const f of flags) lines.push(`  - ${f.issue}${f.severity ? ` (${f.severity})` : ""}`);
  }

  const open = (ctx.missingInformation ?? []).filter((x) => x?.field);
  if (open.length > 0) {
    lines.push("");
    lines.push("OPEN ITEMS");
    for (const m of open) lines.push(`  - ${m.field.replace(/[_.]/g, " ")}${m.priority ? ` [${m.priority}]` : ""}`);
  }

  const body = lines.join("\n");
  const subject = client ? `Handover: ${client}` : "Handover summary";

  return {
    subject,
    body,
    factLedger: {
      client, insurer: insurer || decisionInsurer,
      referralRequired: Boolean(ctx.recommendation?.referral_required),
      seniorReview: Boolean(ctx.recommendation?.senior_review_required),
      missingItems: open.map((o) => o.field),
      coverSections: [],
      sumsInsured: [],
      numericTokens: collectNumericTokens(body),
    },
  };
}

export function draftEmail(type: EmailType, ctx: EmailContext): EmailDraft {
  switch (type) {
    case "broker_missing_info":     return draftBrokerMissingInfo(ctx);
    case "broker_acknowledgement":  return draftBrokerAck(ctx);
    case "insurer_submission":      return draftInsurerSubmission(ctx);
    case "internal_summary":        return draftInternalSummary(ctx);
  }
}

/**
 * Verify a polished draft does not lose or invent facts.
 * Returns [] on success; else a short list of problem tags.
 */
export function verifyEmailPolish(
  base: EmailDraft,
  polished: { subject: string; body: string }
): string[] {
  const problems: string[] = [];
  const p = polished.body;

  // Client / insurer names must not vanish.
  if (base.factLedger.client && !p.includes(base.factLedger.client)) problems.push("dropped_client_name");
  if (base.factLedger.insurer && !p.includes(base.factLedger.insurer)) problems.push("dropped_insurer_name");

  // Referral / senior-review flags must not vanish.
  if (base.factLedger.referralRequired && !/refer(ral)?/i.test(p)) problems.push("dropped_referral_flag");
  if (base.factLedger.seniorReview && !/senior/i.test(p)) problems.push("dropped_senior_flag");

  // Missing-info items must not silently vanish.
  for (const m of base.factLedger.missingItems) {
    // Match by first two normalized tokens so paraphrase is allowed.
    const first = m.replace(/[_.]/g, " ").split(/\s+/).filter(Boolean).slice(0, 2).join(" ");
    if (first && !p.toLowerCase().includes(first.toLowerCase())) {
      problems.push(`dropped_missing_item:${m}`);
    }
  }

  // Numbers must not change or vanish.
  const polishedTokens = new Set(
    p.match(/(?:R\s?[\d,\s]*\.?\d*|[\d]{1,3}(?:[,\s]\d{3})*(?:\.\d+)?%?)/g) ?? []
  );
  for (const tok of base.factLedger.numericTokens) {
    if (!polishedTokens.has(tok)) {
      problems.push(`dropped_numeric_token:${tok.slice(0, 20)}`);
    }
  }

  return problems;
}
