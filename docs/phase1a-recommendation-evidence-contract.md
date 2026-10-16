# Phase 1A — deterministic recommendation evidence contract

## Forensic baseline

Starting point: `main` at `e232b70`, with a clean working tree. Production was
not read or mutated by this change.

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
   - canonical point-in-time snapshot of the exact product/risk candidates,
     features, trusted document labels, and confidence passed to the matcher.
3. `reviewed_risk_facts`
   - stable field path, display label/value, matcher role, source category,
     existing AI-inference marker, and existing confidence availability.
   - only fields scanned by `deriveRisk()`/`matchInsurers()` are included.
4. `trusted_documents`
   - canonical document-type labels from the exact active + `scan_status = clean`
     set passed to the matcher; no storage paths, URLs, or file bodies.
5. `insurers[]`
   - rank/score/band/status and referral/review/decline state;
   - point-in-time rule snapshots with exact rule ID, appetite data, score delta
     emitted by the matcher, matched values/input labels, and nullable source
     document/file/page/section/quote fields;
   - rule-linked required-document present/missing evidence;
   - evidence-ID lists for ranking, strengths, weaknesses, cautions, referrals,
     declines, document gaps, and other evidence gaps;
   - explicit `no_appetite_data` outcomes.
6. `quality`
   - deterministic gaps for missing rule documents/locators, unresolved rule
     snapshots, missing matched-input linkage, unavailable fact confidence,
     missing taxonomy matches, and insurers without appetite data.

The packet is built after `matchInsurers()` from that exact result. It never
calculates or changes a score, rank, rule ID, referral, decline, or document
trust decision.

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
