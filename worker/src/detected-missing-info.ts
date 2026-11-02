/**
 * Server-side boundary for turning a persisted Evidence v3 completeness item
 * into a broker-readable missing-information workflow row.
 *
 * This module deliberately accepts no client-authored title, description, type,
 * owner or provenance. Those fields are derived from the narrow allow-list below.
 */

import { sha256Hex } from "./digest.js";
import { documentKey } from "./matcher.js";
import { resolveSchemaFieldIdentity, resolveSchemaPath, schemaFieldAliases, schemaFieldLabel, type CompletenessItem } from "./completeness.js";

export interface DetectedMissingInfoRow {
  item_type: "document" | "underwriting_info";
  title: string;
  description: string;
  section_key: null;
  source: "extraction" | "quote_review" | "rule";
  owner: "broker";
}

export interface MissingInfoLogicalCandidate {
  id: unknown;
  item_type: unknown;
  title: unknown;
  description?: unknown;
  section_key?: unknown;
  source?: unknown;
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

function exactPart(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function aliasPart(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Only structured rule-sourced rows use document-title canonicalisation. */
export function isCanonicalRequiredDocument(candidate: Omit<MissingInfoLogicalCandidate, "id">): boolean {
  return candidate.item_type === "document" && candidate.source === "rule";
}

export function missingInfoStructuredFactPath(
  candidate: Omit<MissingInfoLogicalCandidate, "id">,
  structuredFactPath?: string | null
): string | null {
  if (candidate.item_type !== "underwriting_info") return null;
  return structuredFactPath ? resolveSchemaPath(structuredFactPath) : resolveSchemaFieldIdentity(String(candidate.title ?? ""));
}

function candidateFactAliases(path: string, peerFactPaths: readonly string[]): Set<string> {
  const aliases = schemaFieldAliases(path) ?? [];
  const peers = peerFactPaths
    .map((peer) => resolveSchemaPath(peer))
    .filter((peer): peer is string => !!peer && peer !== path)
    .map((peer) => new Set((schemaFieldAliases(peer) ?? []).map(aliasPart)));
  return new Set(aliases.map(aliasPart).filter((alias) => !peers.some((peer) => peer.has(alias))));
}

/**
 * One shared identity for Track and Derive. Unknown/free-text rows retain the
 * former exact Derive tuple; only registry-resolved facts gain a canonical key.
 */
export function missingInfoLogicalKey(
  candidate: Omit<MissingInfoLogicalCandidate, "id">,
  structuredFactPath?: string | null
): string {
  const itemType = typeof candidate.item_type === "string" ? candidate.item_type : "";
  const title = typeof candidate.title === "string" ? candidate.title : "";
  if (isCanonicalRequiredDocument(candidate)) return `required_document|${documentKey(title)}`;

  if (itemType === "underwriting_info") {
    const factPath = structuredFactPath
      ? resolveSchemaPath(structuredFactPath)
      : resolveSchemaFieldIdentity(title);
    if (factPath) return `fact|${factPath}`;
    // The only non-fact completeness item Track approves today.
    if (title === "Cover sections required") return "underwriting_info|cover_sections_required";
  }

  return [
    "exact",
    exactPart(candidate.section_key),
    itemType,
    exactPart(candidate.title),
    exactPart(candidate.description),
  ].join("|");
}

/** Server-authoritative, status-blind identity lookup for supported requirements. */
export function findExistingLogicalMissingInfo(
  items: readonly MissingInfoLogicalCandidate[],
  candidate: Omit<MissingInfoLogicalCandidate, "id">,
  structuredFactPath?: string | null,
  peerFactPaths: readonly string[] = []
): MissingInfoLogicalCandidate | null {
  const candidateKey = missingInfoLogicalKey(candidate, structuredFactPath);
  const candidatePath = missingInfoStructuredFactPath(candidate, structuredFactPath);
  const aliases = candidatePath ? candidateFactAliases(candidatePath, peerFactPaths) : null;
  return items.find((item) => {
    if (typeof item.id !== "string") return false;
    if (missingInfoLogicalKey(item) === candidateKey) return true;
    return !!aliases && item.item_type === "underwriting_info" && aliases.has(aliasPart(item.title));
  }) ?? null;
}

/** Canonical fact paths present in one persisted Evidence v3 packet. */
export function structuredFactPathsInEvidence(evidence: unknown): string[] {
  if (!isRecord(evidence) || !isRecord(evidence.completeness) || !Array.isArray(evidence.completeness.items)) return [];
  const paths = new Set<string>();
  for (const item of evidence.completeness.items) {
    if (!isRecord(item) || item.code !== "extraction_reported_information_missing" || typeof item.field_path !== "string") continue;
    const path = resolveSchemaPath(item.field_path);
    if (path && path === item.field_path) paths.add(path);
  }
  return [...paths];
}

/**
 * The UUID primary key is the concurrency backstop for repeated requests against
 * one recommendation. Cross-recommendation identity is checked separately using
 * the shared server-side logical identity matcher.
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
