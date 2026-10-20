/**
 * Atlas — structural guards for persisted recommendation evidence
 * ----------------------------------------------------------------------------
 * `evidence_json` is read from the database as untyped JSON. A packet can carry
 * a valid `schema_version` and still be hollow (a missing `quality.gaps`, an
 * insurer without `rule_evidence`, a mistyped number). Rather than scatter
 * optional chaining through the UI — which would quietly turn "missing" into
 * "none" and imply evidence exists — the boundary is checked ONCE here:
 *
 *   • every field the Evidence Mode view model reads must be present with the
 *     right primitive shape, or the whole packet is rejected as malformed;
 *   • nothing is defaulted, repaired or reconstructed;
 *   • rejection is reported (see resolveEvidence → kind "malformed"), never thrown.
 *
 * These are shape guards, not semantic validation: they do not judge whether a
 * score is plausible, only whether the display code can read the packet safely.
 */

type Rec = Record<string, unknown>;

const isRec = (value: unknown): value is Rec => !!value && typeof value === "object" && !Array.isArray(value);
const isStr = (value: unknown): value is string => typeof value === "string";
const isNum = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isBool = (value: unknown): value is boolean => typeof value === "boolean";
const strOrNull = (value: unknown): boolean => value === null || isStr(value);
const numOrNull = (value: unknown): boolean => value === null || isNum(value);
const arrOf = (value: unknown, check: (item: unknown) => boolean): boolean =>
  Array.isArray(value) && value.every(check);
const strArr = (value: unknown): boolean => arrOf(value, isStr);
const oneOf = (value: unknown, allowed: readonly string[]): boolean => isStr(value) && allowed.includes(value);

/** A record whose listed fields all pass their checks. */
const shape = (value: unknown, checks: Record<string, (v: unknown) => boolean>): value is Rec =>
  isRec(value) && Object.entries(checks).every(([key, check]) => check(value[key]));

const TERM = (v: unknown) => shape(v, { term: isStr, input_source: strOrNull });

const RULE_EVIDENCE = (v: unknown) =>
  shape(v, {
    evidence_id: isStr,
    rule_id: isStr,
    product_line: isStr,
    risk_type: isStr,
    appetite_level: isStr,
    effect: isStr,
    matcher_component: isStr,
    score_contribution: numOrNull,
    matched_rule_terms: (x) => arrOf(x, TERM),
    source: strOrNull,
    source_document_id: strOrNull,
    source_file_name: strOrNull,
    source_page: numOrNull,
    source_section: strOrNull,
    source_quote: strOrNull,
  });

const REQUIRED_DOCUMENT = (v: unknown) =>
  shape(v, {
    document_type: isStr,
    present: isBool,
    confidence_adjustment: isNum,
    rule_evidence_ids: strArr,
  });

const SCORE_RECONCILIATION = (v: unknown) =>
  shape(v, { component_subtotal: isNum, hard_decline_adjustment: isNum, clamp_adjustment: isNum, final_score: isNum });

const CONFIDENCE_RECONCILIATION = (v: unknown) =>
  shape(v, { input_confidence_available: isBool, required_document_adjustment: isNum, manual_review_cap_adjustment: isNum });

const OUTCOME_REASONS = (v: unknown) =>
  shape(v, { why_ranked: strArr, strengthened_by: strArr, weakened_by: strArr });

const SCORED_BASE = {
  rank: isNum,
  score: isNum,
  band: isStr,
  rule_status: isStr,
  confidence: numOrNull,
  confidence_available: isBool,
  referral_required: isBool,
  manual_review_required: isBool,
  senior_review_required: isBool,
  ruled_out: isBool,
  scored_against_rule_id: strOrNull,
  unresolved_rule_ids: strArr,
  rule_evidence: (v: unknown) => arrOf(v, RULE_EVIDENCE),
  required_documents: (v: unknown) => arrOf(v, REQUIRED_DOCUMENT),
  score_reconciliation: SCORE_RECONCILIATION,
  confidence_reconciliation: CONFIDENCE_RECONCILIATION,
  outcome_reasons: OUTCOME_REASONS,
  unmatched_sections: strArr,
  unmatched_product_candidates: strArr,
  nearby_rule_matches: strArr,
};

const TIE_DIFFERENCES = (v: unknown) =>
  arrOf(v, (x) =>
    oneOf(x, ["appetite_level", "hard_decline", "soft_decline", "preferred_terms", "caution_terms", "referral_terms", "required_documents"])
  );

const SECTION_EVALUATION = (v: unknown) =>
  shape(v, {
    section: isStr,
    section_key: isStr,
    status: (x) => oneOf(x, ["evaluated", "no_applicable_rule"]),
    applicable_rule_ids: strArr,
    selected_rule_id: strOrNull,
    tied_rule_ids: strArr,
    tied_rules_disagree: isBool,
    tie_differences: TIE_DIFFERENCES,
    outcome: strOrNull,
    reflected_in_insurer_outcome: isBool,
  });

const CONDITION = (v: unknown) =>
  shape(v, { kind: isStr, origin: isStr, matched_rule_terms: (x) => arrOf(x, TERM) });

const CONSIDERED_RULE = (v: unknown) =>
  shape(v, {
    rule_id: isStr,
    product_line: isStr,
    risk_type: isStr,
    appetite_level: isStr,
    section_keys: strArr,
    selected_for_section_keys: strArr,
    scored: isBool,
    listed_because: isStr,
    conditions: (x) => arrOf(x, CONDITION),
    snapshot_resolved: isBool,
    required_documents: (x) => x === null || strArr(x),
    source: strOrNull,
    source_document_id: strOrNull,
    source_file_name: strOrNull,
    source_page: numOrNull,
    source_section: strOrNull,
    source_quote: strOrNull,
  });

const SELECTION = (v: unknown) =>
  shape(v, {
    product_rule_id: strOrNull,
    tied_rule_ids: strArr,
    tied_rules_disagree: isBool,
    tie_differences: TIE_DIFFERENCES,
    omitted_risk_only_rule_count: isNum,
  });

const COUNTS = { blocker_count: isNum, material_count: isNum, advisory_count: isNum };

const SCORED_V1 = (v: unknown) => shape(v, SCORED_BASE);

const SCORED_V2 = (v: unknown) =>
  shape(v, {
    ...SCORED_BASE,
    selection: SELECTION,
    section_evaluations: (x) => arrOf(x, SECTION_EVALUATION),
    implied_product_evaluations: (x) => arrOf(x, SECTION_EVALUATION),
    considered_rules: (x) => arrOf(x, CONSIDERED_RULE),
    quality: (x) =>
      shape(x, { state: (s) => oneOf(s, ["decision_ready", "caution", "incomplete"]), ...COUNTS, gap_ids: strArr }),
  });

const insurerShell = (v: unknown, scoredCheck: (x: unknown) => boolean): boolean => {
  if (!shape(v, { insurer_id: isStr, insurer_name: isStr, status: isStr })) return false;
  if (v.status === "no_appetite_data") return true;
  return v.status === "scored" && scoredCheck(v);
};

const PROVENANCE = (v: unknown) =>
  shape(v, {
    recommendation_id: isStr,
    extraction_id: isStr,
    matcher_version: isStr,
    taxonomy_version: isStr,
    recommendation_input_fingerprint: isStr,
  });

const TRUSTED = (v: unknown) => arrOf(v, (x) => shape(x, { document_type: isStr }));

/** True when the packet has everything the v1 display code reads. */
export function isReadableV1(value: unknown): boolean {
  return shape(value, {
    provenance: PROVENANCE,
    trusted_documents: TRUSTED,
    insurers: (x) => arrOf(x, (i) => insurerShell(i, SCORED_V1)),
    quality: (q) =>
      shape(q, {
        status: (s) => oneOf(s, ["complete", "gaps_present"]),
        gaps: (g) => arrOf(g, (gap) => shape(gap, { code: isStr, insurer_id: strOrNull, rule_id: strOrNull, missing: strArr })),
      }),
  });
}

/** True when the packet has everything the v2 display code reads. */
export function isReadableV2(value: unknown): boolean {
  return shape(value, {
    provenance: PROVENANCE,
    trusted_documents: TRUSTED,
    requested_sections: (x) => arrOf(x, (s) => shape(s, { section: isStr, section_key: isStr })),
    scoring_scope: (s) => shape(s, { section_outcomes: isStr }),
    insurers: (x) => arrOf(x, (i) => insurerShell(i, SCORED_V2)),
    quality: (q) =>
      shape(q, {
        model: isStr,
        state: (s) => oneOf(s, ["decision_ready", "caution", "incomplete"]),
        ...COUNTS,
        gaps: (g) =>
          arrOf(g, (gap) =>
            shape(gap, {
              gap_id: isStr,
              code: isStr,
              severity: (s) => oneOf(s, ["blocker", "material", "advisory"]),
              insurer_id: strOrNull,
              rule_id: strOrNull,
              section_key: strOrNull,
              missing: strArr,
            })
          ),
      }),
  });
}
