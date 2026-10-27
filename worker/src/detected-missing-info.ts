/**
 * Server-side boundary for turning a persisted Evidence v3 completeness item
 * into a broker-readable missing-information workflow row.
 *
 * This module deliberately accepts no client-authored title, description, type,
 * owner or provenance. Those fields are derived from the narrow allow-list below.
 */

import { sha256Hex } from "./digest.js";
import { documentKey } from "./matcher.js";
import { resolveSchemaPath, schemaFieldLabel, type CompletenessItem } from "./completeness.js";

export interface DetectedMissingInfoRow {
  item_type: "document" | "underwriting_info";
  title: string;
  description: string;
  section_key: null;
  source: "extraction" | "quote_review" | "rule";
  owner: "broker";
}

export interface ExistingMissingInfoIdentity {
  id: unknown;
  item_type: unknown;
  title: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeRuleLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Only completeness classes that a broker can actually supply cross this boundary. */
export function deriveDetectedMissingInfo(item: unknown): DetectedMissingInfoRow | null {
  if (!isRecord(item) || typeof item.item_id !== "string" || item.status !== "missing") return null;

  if (item.code === "required_document_missing") {
    if (
      item.scope !== "document" ||
      item.source !== "required_document_outcome" ||
      item.trust_basis !== "active_exact_clean" ||
      !safeRuleLabel(item.document_type) ||
      item.document_key !== documentKey(item.document_type)
    ) return null;
    return {
      item_type: "document",
      title: item.document_type,
      description: "Required by an insurer's guideline and not among the trusted documents.",
      section_key: null,
      source: "rule",
      owner: "broker",
    };
  }

  if (item.code === "requested_sections_not_declared") {
    if (item.scope !== "submission" || item.source !== "declared_sections") return null;
    return {
      item_type: "underwriting_info",
      title: "Cover sections required",
      description: "The submission does not say which cover sections are required.",
      section_key: null,
      source: "quote_review",
      owner: "broker",
    };
  }

  if (item.code === "extraction_reported_information_missing") {
    if (item.scope !== "fact" || item.source !== "reviewed_extraction" || typeof item.field_path !== "string") return null;
    const canonicalPath = resolveSchemaPath(item.field_path);
    if (!canonicalPath || canonicalPath !== item.field_path) return null;
    return {
      item_type: "underwriting_info",
      title: schemaFieldLabel(canonicalPath),
      description: "Reported as outstanding when the submission was read.",
      section_key: null,
      source: "extraction",
      owner: "broker",
    };
  }

  return null;
}

/** Mirrors the workbench's logical tracking join without using mutable status. */
export function findExistingLogicalMissingInfo(
  items: readonly ExistingMissingInfoIdentity[],
  candidate: DetectedMissingInfoRow
): ExistingMissingInfoIdentity | null {
  return items.find((item) => {
    if (typeof item.id !== "string" || item.item_type !== candidate.item_type || typeof item.title !== "string") return false;
    if (candidate.item_type === "document") return documentKey(item.title) === documentKey(candidate.title);
    return item.title === candidate.title;
  }) ?? null;
}

/**
 * The UUID primary key is the concurrency backstop for repeated requests against
 * one recommendation. Cross-recommendation identity is checked separately using
 * the same logical type/title (or canonical document key) join as the workbench.
 */
export function detectedMissingInfoId(submissionId: string, recommendationId: string, detectedItemId: string): string {
  const hex = sha256Hex(`atlas-detected-missing-info-v1\u0000${submissionId}\u0000${recommendationId}\u0000${detectedItemId}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function findTrackableCompletenessItem(evidence: unknown, detectedItemId: string): {
  item: CompletenessItem;
  row: DetectedMissingInfoRow;
} | null {
  if (!isRecord(evidence) || evidence.schema_version !== "recommendation-evidence-v3") return null;
  if (!isRecord(evidence.completeness) || !Array.isArray(evidence.completeness.items)) return null;
  const item = evidence.completeness.items.find(
    (candidate) => isRecord(candidate) && candidate.item_id === detectedItemId
  );
  const row = deriveDetectedMissingInfo(item);
  return item && row ? { item: item as unknown as CompletenessItem, row } : null;
}
