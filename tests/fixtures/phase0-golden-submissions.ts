export type Phase0ControlOutcome =
  | "proceed_after_review"
  | "request_information"
  | "refer_for_authority"
  | "decline_or_escalate"
  | "manual_review_required";

export type Phase0GoldenSubmission = {
  id: string;
  title: string;
  lineOfBusiness: "personal" | "commercial";
  riskType: "private_motor" | "personal_property" | "commercial_building" | "sectional_title";
  scenario: string;
  expectedControlOutcome: Phase0ControlOutcome;
  requiredControls: readonly string[];
};

/**
 * Phase 0 contract fixtures. These describe the control outcome Atlas must surface.
 * They deliberately do not encode a particular insurer's appetite score.
 */
export const PHASE0_GOLDEN_SUBMISSIONS: readonly Phase0GoldenSubmission[] = [
  {
    id: "P0-001",
    title: "Clean personal motor risk",
    lineOfBusiness: "personal",
    riskType: "private_motor",
    scenario: "Complete vehicle schedule, claims history, driver details, and current cover details.",
    expectedControlOutcome: "proceed_after_review",
    requiredControls: ["human_extraction_review", "source_evidence"],
  },
  {
    id: "P0-002",
    title: "Clean commercial building",
    lineOfBusiness: "commercial",
    riskType: "commercial_building",
    scenario: "Complete proposal, claims history, sums insured, and current cover details.",
    expectedControlOutcome: "proceed_after_review",
    requiredControls: ["human_extraction_review", "source_evidence"],
  },
  {
    id: "P0-003",
    title: "Personal claims history missing",
    lineOfBusiness: "personal",
    riskType: "private_motor",
    scenario: "The broker requests terms but supplies no claims history or loss information.",
    expectedControlOutcome: "request_information",
    requiredControls: ["missing_information", "communication_draft"],
  },
  {
    id: "P0-004",
    title: "Commercial proposal information incomplete",
    lineOfBusiness: "commercial",
    riskType: "commercial_building",
    scenario: "Building schedule is present, but occupancy, construction, or protection details are absent.",
    expectedControlOutcome: "request_information",
    requiredControls: ["missing_information", "human_extraction_review"],
  },
  {
    id: "P0-005",
    title: "Personal vehicle above authority threshold",
    lineOfBusiness: "personal",
    riskType: "private_motor",
    scenario: "The vehicle value or usage exceeds a configured insurer or authority limit.",
    expectedControlOutcome: "refer_for_authority",
    requiredControls: ["quote_review", "referral_reason", "authority_check"],
  },
  {
    id: "P0-006",
    title: "Commercial sum insured above appetite threshold",
    lineOfBusiness: "commercial",
    riskType: "commercial_building",
    scenario: "The quoted sum insured exceeds a configured insurer or authority limit.",
    expectedControlOutcome: "refer_for_authority",
    requiredControls: ["quote_review", "referral_reason", "authority_check"],
  },
  {
    id: "P0-007",
    title: "Explicitly declined personal exposure",
    lineOfBusiness: "personal",
    riskType: "personal_property",
    scenario: "The reviewed personal risk contains a characteristic explicitly declined by the matched appetite rule.",
    expectedControlOutcome: "decline_or_escalate",
    requiredControls: ["matched_rule_evidence", "decision_reason", "manager_override_gate"],
  },
  {
    id: "P0-008",
    title: "Explicitly declined commercial exposure",
    lineOfBusiness: "commercial",
    riskType: "commercial_building",
    scenario: "The reviewed risk contains a characteristic explicitly declined by the matched appetite rule.",
    expectedControlOutcome: "decline_or_escalate",
    requiredControls: ["matched_rule_evidence", "decision_reason", "manager_override_gate"],
  },
  {
    id: "P0-009",
    title: "Ambiguous classification",
    lineOfBusiness: "commercial",
    riskType: "commercial_building",
    scenario: "The submission contains mixed business activities and no single reliable risk classification.",
    expectedControlOutcome: "manual_review_required",
    requiredControls: ["unmatched_sections", "manual_review_flag", "human_extraction_review"],
  },
  {
    id: "P0-010",
    title: "Low-confidence personal extraction",
    lineOfBusiness: "personal",
    riskType: "private_motor",
    scenario: "A scanned vehicle schedule produces conflicting or low-confidence values for key risk fields.",
    expectedControlOutcome: "manual_review_required",
    requiredControls: ["field_confidence", "source_evidence", "human_extraction_review"],
  },
  {
    id: "P0-011",
    title: "Missing warranty or endorsement",
    lineOfBusiness: "commercial",
    riskType: "commercial_building",
    scenario: "The quote is present, but a required warranty or endorsement cannot be evidenced.",
    expectedControlOutcome: "refer_for_authority",
    requiredControls: ["quote_review", "warranty_or_endorsement_finding", "decision_reason"],
  },
  {
    id: "P0-012",
    title: "Rate outside expected band",
    lineOfBusiness: "commercial",
    riskType: "commercial_building",
    scenario: "The quote contains a rate outside the configured appetite or rating-note band.",
    expectedControlOutcome: "refer_for_authority",
    requiredControls: ["quote_review", "rating_finding", "referral_reason"],
  },
  {
    id: "P0-013",
    title: "Multi-section exposure gap",
    lineOfBusiness: "commercial",
    riskType: "sectional_title",
    scenario: "A multi-section building risk has business exposure, but the quote omits an expected section.",
    expectedControlOutcome: "manual_review_required",
    requiredControls: ["section_comparison", "business_exposure_check", "manual_review_flag"],
  },
];
