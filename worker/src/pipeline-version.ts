/**
 * Atlas hybrid pipeline — version constant
 * ----------------------------------------------------------------------------
 * Bump when ANY of the following changes in a way that invalidates a previous
 * shadow comparison:
 *   - Local parser output shape
 *   - Azure adapter output shape
 *   - Normalisation prompt (EXTRACTION_SYSTEM_PROMPT + Haiku suffix)
 *   - Normalisation model default
 *   - Validation rules
 *   - Orchestrator sequencing or escalation policy
 *
 * Format: yyyymmdd-<short-hint>. Max 40 chars, no spaces.
 */
export const PIPELINE_VERSION = "20260806-orch-v1-unpdf-haiku45";
