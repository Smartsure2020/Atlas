/**
 * Atlas Blueprint — matcher shared types
 * ----------------------------------------------------------------------------
 * Kept separate so the matcher module is pure and testable in isolation. These
 * shapes match the atlas_insurer_appetite row.
 */

export type AppetiteLevel = "preferred" | "standard" | "caution" | "declined";

export interface AppetiteRow {
  id: string;
  insurer_id: string;
  insurer_name: string;
  product_line: string;
  risk_type: string;
  appetite_level: AppetiteLevel;
  preferred_risks: string[];
  caution_risks: string[];
  declined_risks: string[];
  required_documents: string[];
  referral_triggers: string[];
  notes: string | null;
  rating_notes?: string | null;
  source: "ai_extracted" | "manual";
  source_document_id: string | null;
  source_quote?: string | null;
  source_page?: number | null;
  source_section?: string | null;
  source_file_name?: string | null;
  ingestion_confidence?: number | null;
  line_of_business?: "personal" | "commercial" | "both" | null;
  is_active: boolean;
}
