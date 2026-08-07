/**
 * Atlas hybrid pipeline — mode + progressive-status vocabulary
 * ----------------------------------------------------------------------------
 * Kept in one small module so the mode gate and the UI stage strings never
 * drift. Reads ATLAS_DOCUMENT_PIPELINE_MODE from env with a safe default of
 * "legacy" — the old path is authoritative until someone flips the switch.
 */

export type PipelineMode = "legacy" | "hybrid" | "shadow";

export interface PipelineEnv {
  ATLAS_DOCUMENT_PIPELINE_MODE?: string;
  ATLAS_DOCUMENT_PROVIDER?: string;
  AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT?: string;
  AZURE_DOCUMENT_INTELLIGENCE_KEY?: string;
  ATLAS_HYBRID_MAX_TEXT_FASTPATH_PAGES?: string;
  ATLAS_EXPLANATION_MODE?: string;    // 'deterministic' (default) | 'polish'
  ATLAS_EMAIL_MODE?: string;          // 'template' (default) | 'polish' | 'legacy'
}

export function pipelineMode(env: PipelineEnv): PipelineMode {
  const raw = (env.ATLAS_DOCUMENT_PIPELINE_MODE ?? "").trim().toLowerCase();
  if (raw === "hybrid" || raw === "shadow") return raw;
  return "legacy";
}

export function azureConfigured(env: PipelineEnv): boolean {
  return Boolean(
    (env.ATLAS_DOCUMENT_PROVIDER ?? "azure").toLowerCase() === "azure" &&
      env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT &&
      env.AZURE_DOCUMENT_INTELLIGENCE_KEY
  );
}

export function maxTextFastpathPages(env: PipelineEnv): number {
  const n = Number(env.ATLAS_HYBRID_MAX_TEXT_FASTPATH_PAGES);
  return Number.isFinite(n) && n > 0 ? n : 40;
}

export function explanationMode(env: PipelineEnv): "deterministic" | "polish" {
  return (env.ATLAS_EXPLANATION_MODE ?? "").toLowerCase() === "polish" ? "polish" : "deterministic";
}

export function emailMode(env: PipelineEnv): "template" | "polish" | "legacy" {
  const raw = (env.ATLAS_EMAIL_MODE ?? "").toLowerCase();
  if (raw === "polish") return "polish";
  if (raw === "legacy") return "legacy";
  return "template";
}

/**
 * Progressive-status vocabulary. The strings here are used as `current_step`
 * on atlas_jobs so the UI can render meaningful stage badges instead of a
 * fake percentage. Ordered from earliest to latest.
 */
export const PIPELINE_STAGES = [
  "queued",
  "validating_document",
  "extracting_pdf_text",
  "processing_scanned_pages",
  "extracting_risk_information",
  "validating_extracted_fields",
  "resolving_uncertain_fields",
  "running_insurer_matching",
  "preparing_recommendation",
  "ready_for_review",
  "failed",
  "cancelled",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export function isValidStage(s: string): s is PipelineStage {
  return (PIPELINE_STAGES as readonly string[]).includes(s);
}
