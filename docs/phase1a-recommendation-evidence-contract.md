# Phase 1A — deterministic recommendation evidence contract

## Forensic baseline

Starting point: `main` at `e232b70`, with a clean working tree. Production was
not read or mutated by this change.

The remediation chain starts from local Phase 1A commit `6bef2dd`; this final
narrow follow-up starts from `111e406`. It does not deploy a Worker, apply a
migration, enable Graph, or change the legacy document pipeline.

Before Phase 1A, `atlas_recommendations` persisted:

- the top insurer name;
- enriched matcher results split across `reasoning_json.top`,
  `secondary_options_json`, and `not_recommended_json`;
- no-data insurers plus the exact derived `matcher_input`, matcher version,
  taxonomy version, explanation mode/source, and confidence provenance inside
  `reasoning_json`;
- recommendation confidence/referral/senior-review columns;
- the extraction ID and creation time;
- model, prompt, taxonomy, appetite-fingerprint, and extraction-schema metadata
  inside `version_metadata`.

The matcher result already contained score, band/status, rule IDs, matched rule
list and values, source quote/page/section/file, scoring notes, missing required
documents, unmatched taxonomy candidates, referral/manual/senior-review flags,
and no-data insurers. Phase 1A reuses those fields and does not create a second
recommendation engine.

## Schema decision

The evidence packet is stored in a new nullable `atlas_recommendations.evidence_json`
column. Putting the packet in `reasoning_json` was rejected because that field
already combines human-readable explanation with compatibility reconstruction
metadata; adding a complete evidence graph would further obscure its meaning.

Migration `0037_recommendation_evidence_contract.sql` is additive only. It has
no default, no `NOT NULL`, no historical rewrite, and no RLS change. Historical
rows therefore read with `evidence_json` absent/null. The recommendation GET
contract exposes the field additively.

## Version 1 contract

`recommendation-evidence-v1` contains:

1. `provenance`
   - persisted recommendation, submission, and extraction IDs;
   - review and generation timestamps;
   - matcher and taxonomy versions;
   - explanation mode/source;
   - the existing recommendation input fingerprint.
2. `matcher_input`
   - canonical point-in-time snapshot of taxonomy candidates, trusted document
     labels, and confidence passed to the matcher;
   - feature values are not retained: only source, AI-inference state, and an
     explicit `value_retained: false` marker are persisted.
3. `reviewed_risk_facts`
   - stable field path, display label, presence, matcher role, source category,
     existing AI-inference marker, and existing confidence availability;
   - reviewed values are not retained and are explicitly marked
     `value_retained: false`.
   - only fields scanned by `deriveRisk()`/`matchInsurers()` are included.
4. `trusted_documents`
   - canonical document-type labels from the exact active + `scan_status = clean`
     set passed to the matcher; no storage paths, URLs, or file bodies.
5. `insurers[]`
   - rank/score/band/status and referral/review/decline state;
   - point-in-time rule snapshots with exact rule ID, appetite data, score delta
     emitted by the matcher, redacted match count/source labels, matcher-authored
     `matched_rule_terms` pairs (insurer-owned appetite term plus authoritative
     input-source label), and nullable source document/file/page/section/quote
     fields;
   - authoritative matcher effects, including distinct `hard_decline` and
     `soft_decline_referral` values; the evidence builder never infers them;
   - score reconciliation (`component_subtotal`, hard-decline adjustment,
     clamp adjustment, and final score) and confidence reconciliation;
   - dedicated, canonical required-document outcomes. Product and portfolio
     rules can both link to one outcome, but a missing document is penalised
     only once. Document availability is not called a score strength/weakness;
   - evidence-ID lists for ranking, strengths, weaknesses, cautions, referrals,
     declines, document gaps, and other evidence gaps;
   - explicit minimal `no_appetite_data` outcomes with null rank/score and no
     fabricated score, rule, review flag, or matcher note.
6. `quality`
   - deterministic gaps for missing rule documents/locators, unresolved rule
     snapshots, missing matched-input linkage, unavailable fact confidence,
     missing taxonomy matches, and insurers without appetite data.

The packet is built after `matchInsurers()` from that exact result. It never
calculates or changes a score, rank, rule ID, referral, decline, or document
trust decision.

## Privacy boundary

Before remediation, the new `evidence_json` packet copied free-form feature
text, reviewed display values, matched values, and matched-input values. That
could duplicate names, identifiers, phone numbers, banking details, addresses,
or policy references in a second JSON column.

After remediation, `evidence_json` does not copy raw free-text feature values or
reviewed display values. It retains canonical taxonomy candidates, field
presence, feature source labels, AI-inference markers, confidence provenance,
trusted document types, matcher-authored effects/counts, and appetite-rule
provenance. `matched_rule_terms` retains only insurer-owned appetite terms paired
with authoritative matcher source labels; the evidence builder neither derives
those terms from client text nor guesses missing labels. Taxonomy candidates may
reflect a reviewed classification, so they are not described as raw client free
text. Rule source excerpts remain because they are insurer appetite provenance,
not client submission text. The older `reasoning_json.matcher_input`
compatibility snapshot is unchanged in Phase 1A and is explicitly tracked for
Phase 2 privacy work.

## Release order (not performed by Phase 1A)

1. Merge the reviewed code.
2. Apply `0037_recommendation_evidence_contract.sql`.
3. Verify the nullable column and confirm historical rows remain null.
4. Stage the Worker candidate without activating it.
5. Run recommendation smoke checks and inspect persisted evidence/privacy.
6. Activate the verified Worker version.

Worker activation before the additive migration is forbidden. This document is
an order-of-operations runbook only; none of these production actions were
performed during the remediation.

## Known gaps for P1C

- Reviewed extraction facts have stable field provenance and existing
  confidence, but Atlas does not currently carry document page/quote provenance
  for those reviewed fields. Phase 1A leaves it unavailable.
- Legacy appetite rules may have no `source_document_id`, or a document ID with
  an incomplete file/page/section/quote locator. Phase 1A snapshots the nulls
  and reports deterministic quality gaps; it does not fabricate fallbacks.
- `matcher_notes` preserve legacy prose for traceability. Core effects are now
  structured, but P1C can classify any remaining prose-only diagnostic detail.
- The matcher still selects one best product rule per insurer. Per-cover-section
  scoring remains deliberately outside this phase.

## Deferred Phase 2 backlog

- Minimise or replace the free-text compatibility snapshot at
  `reasoning_json.matcher_input`.
- Include matcher and taxonomy versions in the recommendation fingerprint.
- Specify and lock appetite tie ordering independently of database row order.
- Consider opt-in/privileged evidence expansion on GET if rule excerpts need a
  narrower audience.
- Define rule deduplication semantics across product and portfolio layers.
- Replace remaining prose-only matcher diagnostics with structured codes.
- Carry reviewed-field page/quote provenance when the extraction contract can
  supply it.
- Revisit per-cover-section scoring as a separate matcher-version change.
- Preserve and expose considered-but-unselected product rules if the matcher is
  expanded beyond its current one-best-product-rule-per-insurer behavior.
- Introduce a deliberate quality-gap severity model and broader quality-gap
  redesign rather than treating every gap as equivalent.
