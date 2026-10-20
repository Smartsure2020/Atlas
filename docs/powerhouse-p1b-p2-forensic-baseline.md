# Powerhouse Batch 2 — Checkpoint A: forensic intelligence baseline

Recorded against `main` @ `34441a0` (Phase 1A merged, migrated, deployed).
Matcher `2026-07-token-matching-v1`, taxonomy `2026-07-token-aliases-v1`,
evidence `recommendation-evidence-v1`.

Nothing in this document describes a change. It is the map of what production
Atlas does today, recorded **before** any Batch 2 edit. The machine-checked
counterpart is `tests/powerhouse/baseline-v1.test.ts` plus its golden
`tests/powerhouse/fixtures/baseline-multi-section.v1.golden.json`, which was
generated from the unmodified matcher and must never be regenerated from new
code.

Line references are to the baseline commit.

---

## 1. `matchInsurers(risk, allAppetite)` inputs

`worker/src/matcher.ts:397`

| Input | Shape | Where it comes from |
| --- | --- | --- |
| `risk.product_candidates` | `string[]` | `deriveRisk()` (`recommendation-endpoints.ts:158`): split `product_line`, split `risk_type`, split `cover_sections`, split `secondary_risk_types`, then `primary_risk_type`, in that order. **Cover sections, product line and risk type are mixed in one list.** |
| `risk.section_candidates` | `string[]` | split `current_cover.cover_sections` only |
| `risk.risk_candidates` | `string[]` | split `risk_type`, split `business_sector`, split `secondary_risk_types`, `primary_risk_type`, `complexity_level` |
| `risk.features` | `RiskFeature[]` `{text, source, ai_inferred}` | ten reviewed fields, each labelled with a source; `red_flags[].issue` are `ai_inferred: true` |
| `risk.available_documents` | `string[]` | `loadAvailableDocumentTypes()`: `atlas_documents` where `status = 'active'` **and** `scan_status = 'clean'` (document-trust boundary, Phase 24). A failed query is HTTP 503, never "no documents". |
| `risk.overall_confidence` / `_available` | number / boolean | `resolveConfidenceProvenance()` (reviewed → extracted → column → 0.7 legacy) |
| `allAppetite` | `AppetiteRow[]` | `atlas_insurer_appetite where is_active = true`, **no `ORDER BY`** (`recommendation-endpoints.ts:349`). `matchInsurers` additionally skips `!is_active`. |

## 2. How product rules are selected

Per insurer, rows split into **product rules** (anything that is not both
`product_line = "*"` and `risk_type = "*"`) and **portfolio rules** (both `*`)
(`isPortfolio`, `matcher.ts:336`).

For every product rule, `taxonomyQualityWithCandidates` (`matcher.ts:241`)
answers a yes/no for "does ANY product candidate relate to the rule's
`product_line`" and "does ANY risk candidate relate to the rule's `risk_type`":

| quality | meaning |
| --- | --- |
| 3 | product line **and** risk type related |
| 2 | product line only |
| 1 | risk type only |
| -1 | neither |

Relatedness is `taxonomyKeysRelated` on canonical keys (equality, or one key's
underscore-token set contained in the other's).

The loop keeps `quality > bestQuality` (strict), so **the first rule encountered
wins every tie** (`matcher.ts:438`). A rule is *used* only when quality ≥ 1
(`matcher.ts:450`); otherwise the insurer takes the "insufficient rule match"
path (band `insufficient_rule_match`, base 0, `manual_review_required`).

> **Known limitation (proven by the baseline fixture): one best product rule per
> insurer.** The selector is not per cover section: a candidate list containing
> `Commercial motor` and `Goods in transit` is matched against the whole rule
> set at once, one rule survives, and every other rule for the other section is
> never read. See §16.

## 3. How portfolio rules are applied

All portfolio rules of the insurer are applied **in row order**, after the
product path (`matcher.ts:566`), additively and without deduplication across
product/portfolio layers. For each portfolio rule, in this order:

1. `declined_risks` — document-derived hit ⇒ hard decline, **loop breaks**
   (later portfolio rules are not evaluated); AI-only hit ⇒ soft decline.
2. `caution_risks` — `-10` per hit.
3. `referral_triggers` — `-8` per hit, sets `referral_required`.

The portfolio rule's own `appetite_level` and `preferred_risks` are **never
read**. Portfolio `required_documents` are merged into the insurer's required
documents (§9).

## 4. Score component ordering (used-rule path)

1. Base by `appetite_level`: preferred 100, standard 70, caution 40, declined 0.
2. `declined_risks` scan on the used rule
   - document-derived hit ⇒ **ruled out immediately** (returns here; preferred/
     caution/referral/portfolio/documents are never evaluated);
   - AI-only hit ⇒ `-10` per hit, `referral_required`, continue.
3. `appetite_level === "declined"` ⇒ ruled out ("Insurer's appetite for this
   line/type is declined").
4. `preferred_risks` — `+5` per hit, capped at `+20`.
5. `caution_risks` — `-10` per hit.
6. `referral_triggers` — `-8` per hit, `referral_required`.
7. Portfolio loop (§3). A portfolio hard decline ruled out the insurer.
8. Required documents / confidence (§9) — **never touch the score**.
9. Clamp (§5).

## 5. Clamp behaviour

`score = max(0, min(100, componentSubtotal))` after every component
(`matcher.ts:703`). `score_reconciliation` records `component_subtotal`,
`clamp_adjustment`, and for hard declines `hard_decline_adjustment =
-component_subtotal` with final score 0. Example from the baseline fixture:
Alpha = 100 base + 5 preferred = 105 → clamped to 100.

## 6. Confidence adjustments

- unavailable provider rating ⇒ numeric 0, `confidence_available = false`;
  a valid number ⇒ itself; no flag and no valid number ⇒ legacy 0.7 (available).
- missing required document ⇒ `-0.10` each, total capped at `-0.30`
  (`DOC_GAP_CONFIDENCE_*`).
- manual-review insurer (no used rule) ⇒ `min(confidence, 0.35)`.
- ruled-out insurer ⇒ confidence 0, `confidence_available = false`.

## 7. Hard declines vs soft-decline referrals

| Trigger | Effect | `ruled_out` | Score |
| --- | --- | --- | --- |
| used rule `declined_risks` hit in a **document-derived** feature | `hard_decline` | yes | 0 |
| used rule `appetite_level = declined` | `hard_decline` (base entry) | yes | 0 |
| portfolio `declined_risks` hit, document-derived | `hard_decline` | yes | 0 |
| `declined_risks` hit **only** in `ai_inferred` features (red flags) | `soft_decline_referral` | **no** | `-10` per hit, `referral_required = true` |

The AI-inferred path never rules an insurer out by itself.

## 8. Referrals and senior review

`referral_required` ⇐ any referral trigger hit or soft decline. `senior_review`
⇐ used rule present AND `score ≤ 50` AND `referral_required`
(`CAUTION_BAND_MAX`). The endpoint persists `referral_required`,
`senior_review_required = top.senior || top.manual_review` on the top insurer
only and moves the submission status from the top result.

## 9. Required-document effects

Required documents come from the used product rule and **every** portfolio rule,
deduplicated case-insensitively by exact string (`matcher.ts:635`). Presence is
`hasRequiredDoc`: normalised, bidirectional `includes`. Effects: confidence
only (§6), `missing_required_documents`, and per-document
`required_document_evidence` with the contributing rule IDs and scopes (one
canonical outcome, one penalty, even if product and portfolio both require it).
For ruled-out insurers the document block is skipped (`required_document_evidence
= []`, `missing_required_documents = []`).

## 10. Unmatched sections and product candidates

Computed **only** when `manualReviewRequired` (no used rule)
(`matcher.ts:708`). They compare `section_candidates ?? product_candidates`
against the insurer's product-rule `product_line`s by exact canonical-key
**equality**, a different (stricter) test than the selector's relatedness.
**When a rule was used, `unmatched_sections` is always `[]`**, whatever the
other requested sections are. `nearby_rule_matches` is bounded to 6.

## 11. No-data insurers

`matchInsurers` never populates `no_data_for` (always `[]`). The endpoint adds
`insurersWithoutActiveRules(atlas_insurers where active, appetite)`
(`recommendation-endpoints.ts:422`). Evidence v1 represents them as explicit
`no_appetite_data` outcomes with null rank/score. A portfolio-only insurer is
**not** no-data: it is scored `insufficient_rule_match`.

## 12. Tie ordering

- **Rule ties:** first row wins (§2). Row order is `atlas_insurer_appetite`
  heap order — not specified by the query.
- **Insurer ties:** `scored.sort` is stable, ordered `ruled_out` last then score
  descending (`matcher.ts:768`); equal scores keep `Map` insertion order =
  first-appearance order of the insurer in the unordered row list
  (product-rule insurers first, then portfolio-only insurers). Ruled-out
  insurers (all score 0) are ordered the same way.
- `top` is the first non-ruled-out insurer; the rest are `secondary_options_json`.

Proven by baseline tests 5 and 6: reversing the row list reorders equal-score
insurers and flips Gamma from viable to ruled out with byte-identical input.

## 13. Recommendation fingerprint

`buildRecommendationFingerprint` (`phase7-core.ts:66`) hashes
`{type, submission_id, extraction_id, reviewed_at, active_rule_ids (id:updated_at,
sorted), available_documents (sorted, unique)}` with a 32-bit FNV-1a.

**Excluded:** `MATCHER_VERSION`, `TAXONOMY_VERSION`, evidence schema version,
explanation mode, and the set of active insurers (which drives `no_data_for`).
A deploy that changes matcher or taxonomy behaviour therefore leaves every
cached fingerprint valid, and `beginJob` answers `unchanged_completed` without
recomputing. (Baseline test 8.)

## 14. Versions

| Version | Value | Persisted in |
| --- | --- | --- |
| matcher | `2026-07-token-matching-v1` | `reasoning_json.matcher_version`, `evidence_json.provenance.matcher_version` |
| taxonomy | `2026-07-token-aliases-v1` | `reasoning_json.taxonomy_version`, `version_metadata.taxonomy`, evidence provenance |
| evidence schema | `recommendation-evidence-v1` | `evidence_json.schema_version` |

## 15. Consumers

### `reasoning_json.matcher_input`

Written at `recommendation-endpoints.ts:573` as the raw `deriveRisk()` output,
i.e. with `features[].text` carrying client free text (occupation/business
description, **risk address**, entity type, endorsements, exclusions, red-flag
issues, classification fields).

| Consumer | Reads `matcher_input`? |
| --- | --- |
| Worker runtime (`recommendation-endpoints`, `quote-review-endpoints`, `phase4-background`, `insurer-endpoints`) | No. `phase4-background` reads `reasoning_json->>overall_confidence_available` only. |
| Frontend (`src/**`) | No. `Recommendation.reasoning_json` declares no `matcher_input`. |
| Email drafting (`email-endpoints.ts:216`) | Indirectly: legacy-Sonnet mode `JSON.stringify`s the **whole** `reasoning_json` into a prompt, so raw client text is re-sent to the model. The template path reads no `matcher_input`; the same prompt already carries the full reviewed extraction, so nothing is lost without it. |
| Tests | `tests/phase24-clean-only-document-trust.test.ts:930` reads `available_documents`. |

There is **no runtime consumer of raw feature text.** Because
`atlas_extractions.reviewed_json` is overwritten in place on every re-review
(`submission-endpoints.ts:165`), `reasoning_json.matcher_input` is today the only
point-in-time copy of the raw features of a run — the privacy cost and the
reconstruction value are the same bytes. See Batch 2 §2.7 for the decision.

### `evidence_json`

- Written: `recommendation-endpoints.ts:591`. Built after matching, never feeds
  back into scoring.
- Read: `handleGetRecommendation` (`:663`, explicit `select`, returned verbatim).
  Access: `GET /api/submissions/:id/recommendation` requires
  `roleCanViewUnderwritingIntelligence` (admin, manager, consultant,
  underwriter, readonly); brokers are denied. Batch 2 does not widen this.
- Frontend: typed in `src/lib/recommendations.ts` (`RecommendationEvidence`).
  **No component renders it today.**

### Recommendation GET consumers (frontend)

`SubmissionDetail` loads it (`getRecommendation`, skipped for brokers) and passes
it to `RecommendationPanel`, `QuoteReviewPanel` (reads `reasoning_json.top`),
`lib/decision-workbench.ts`, `lib/workflow.ts`, the decision form's insurer
choice list. Email endpoints and background monitors read the row server-side.

### Current recommendation UI components

`src/pages/RecommendationPanel.tsx`: `RecommendationSummary` (counts, flags),
`InsurerBlock` (reasoning, `groupFindings` reasons, a "Matched rules and
scoring detail" disclosure that prints `scoring_notes` prose and each matched
rule's source), `ComparisonMatrix` (six rows), the "Insurers Atlas could not
consider" notice. Derivation helpers live in `src/lib/decision-workbench.ts`.
It renders from `reasoning_json` / `secondary_options_json` /
`not_recommended_json` and **does not read `evidence_json`**.

## 16. The proof: "one best product rule per insurer"

Fixture `tests/powerhouse/fixtures/baseline-multi-section.json`. Submission
requests **Commercial motor** and **Goods in transit**; features include
`transport fleet`, `high value cargo`, `cross border haulage`.

| Insurer | Rules | v1 result |
| --- | --- | --- |
| Alpha | motor *preferred* (q3) + Goods in transit *declined* (q2) | **#1, preferred, score 100, not ruled out.** The declined Goods in transit rule appears nowhere: not in `matched_rules`, notes, `unmatched_sections` (empty), or evidence. |
| Beta | motor *standard* (q3) + Goods in transit *caution*, caution term `high value cargo`, referral trigger `cross border` (q2) | **standard, 70, no referral.** The caution and referral terms hit submitted features but are never evaluated or reported. |
| Gamma | motor *preferred* (q3) + Goods in transit *declined* (q3) | **Tie.** Rows as listed: preferred 100. Rows reversed: **ruled out, score 0.** Same input, opposite answer. |

Evidence v1 for the same run: `quality.status = "complete"`, with no rule ID for
any Goods in transit rule. Phase 1A proved what the matcher *did*; it could not
reveal what the matcher *did not look at*.

## 17. Findings that drive Batch 2

1. Section outcomes are not exposed at all (no per-section rule set, no
   considered-but-unselected rules).
2. A hard decline in a requested section can be invisible.
3. Rule and insurer tie-breaking depend on unspecified row order.
4. The fingerprint ignores matcher/taxonomy versions.
5. `reasoning_json.matcher_input` duplicates raw client text with no runtime
   reader.
6. The evidence quality gate is binary and calls the Alpha/Beta/Gamma run
   "complete".
7. No UI renders `evidence_json`.
8. Found, out of scope: the fingerprint is a 32-bit hash and does not include
   the active-insurer list, so adding an insurer with no rules does not
   invalidate a cached recommendation.
