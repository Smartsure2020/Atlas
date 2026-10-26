# Powerhouse Batch B — Checkpoint A: forensic baseline (Phase 3 + Phase 4)

Recorded against `main` @ `1d56fbb` (Batch 2 production-accepted). This is a historical
pre-change checkpoint. The remediation review later invalidated its broker-email
semantic-equivalence conclusion; the corrected production decision is recorded in the
Batch B implementation document. Matcher
`2026-10-section-evaluation-v2`, taxonomy `2026-07-token-aliases-v1`, evidence
`recommendation-evidence-v2`, quality `recommendation-quality-v2`, document pipeline
`legacy`, Graph off.

Nothing here describes a change. It is the map of what Atlas does today, written
**before** any Batch B edit. Operating principle for the batch: **augment, do not
rebuild.**

---

## A. What Atlas currently means by "missing information"

Atlas has **six unrelated notions**, produced in different places, with different
vocabularies and no shared identity:

| # | Notion | Producer | Persisted? | Level |
| --- | --- | --- | --- | --- |
| 1 | **Extraction-reported missing information** — `missing_information[]` = `{field, reason_required, priority}` | The extraction LLM (`extraction.ts` prompt, validated by `validateAndNormalizeExtraction`); mirrored to `atlas_extractions.missing_fields_json`; part of `reviewed_json` | Yes (`extracted_json`, `reviewed_json`, `missing_fields_json`) | submission |
| 2 | **Field status** `not_found / unclear / conflicting / low_confidence_extracted` on every extracted field | Extraction LLM; `defaultField()` scaffolds `not_found` for **every** field the model did not return | Yes (inside the JSON) | field |
| 3 | **Required documents** — `required_documents[]` on an appetite rule, evaluated per insurer into `required_document_evidence` (`present`, `appetite_ids`, `scopes`, `confidence_adjustment`) | `matcher.ts` (`hasRequiredDoc`, one outcome per canonical document, product + portfolio rules merged) | Yes, in `evidence_json.insurers[].required_documents` and `reasoning_json` rows | insurer / rule |
| 4 | **Unmatched sections / product candidates** | `matcher.ts` `unmatchedFromRisk` — **only computed when no product rule was used**; exact canonical-key equality (stricter than the selector) | Yes (`unmatched_*` columns, evidence) | insurer |
| 5 | **Quality gaps** (`insurer_appetite_data_missing`, `requested_section_not_evaluated`, `required_document_missing`, `required_documents_unevidenced`, `no_trusted_documents`, `requested_sections_not_declared`, `multiple_products_without_declared_sections`, …) | `recommendation-quality.ts` | Yes, `evidence_json.quality` (v2) | recommendation / insurer / section / rule |
| 6 | **Tracked missing-information items** — the operational workspace | `atlas_missing_info_items` (migration 0010); created by "Derive from analysis" (`missingInfoFromQuoteReview`) or by hand | Yes, relational | submission (optionally quote review / section / rule) |

Notion 6 is the only one with a **workflow** (open → requested → received / waived /
not_required, owner, due date, notes, audit rows). Notions 1–5 describe *detection*;
notion 6 *tracks the human response*. Nothing links 6 to 1–5 except free-text titles.

Also relevant but **not** "missing information": `overall_confidence_available`,
`reviewed_fact_confidence_unavailable` (a *rating* is absent, not the fact), and
`quote-review.ts` findings (`Sum insured or cover limit is missing or unclear`,
`missing_documents` per quoted section) which are quote-review outcomes, not
recommendation completeness.

## B. Level of each notion

| Notion | submission | insurer | rule | document | section | workflow |
| --- | --- | --- | --- | --- | --- | --- |
| extraction `missing_information[]` | ● | | | | | feeds #6 |
| field status | | | | | | (UI band + counts only) |
| required documents | | ● (merged across product + portfolio rules) | ● (`appetite_ids`) | ● | | feeds #6 only via quote review |
| unmatched sections/products | | ● | | | ● (names only) | |
| quality gaps | ● | ● | ● | ● (per canonical doc) | ● | |
| tracked items | ● | | ◐ `required_by_rule_id` | ◐ `item_type = document` | ◐ `section_key` | ● |

No notion carries an **insurer id** on the workflow side, and none carries a
**field path** except quality gaps (`field_path`) and the evidence facts.

## C. Persisted or recomputed?

* Notions 1, 2: persisted in the extraction JSON. `reviewed_json` is **overwritten in
  place** on every re-review (`handleReview`); `extracted_json` is never overwritten.
  Each extraction **run** inserts a new `atlas_extractions` row; the recommendation
  pipeline uses the latest row ("latest wins" — an existing explicit mechanism).
* Notion 3: recomputed on every recommendation run, persisted point-in-time in
  `evidence_json` (v1/v2) and `reasoning_json`.
* Notion 4: recomputed per run, persisted per row.
* Notion 5: recomputed per run, persisted in `evidence_json.quality` (v2 only).
* Notion 6: persisted relationally. The recommendation endpoint never reads or writes
  it.

There is **no** persisted aggregate "completeness" anywhere.

## D. What an existing missing-information item contains

`atlas_missing_info_items` columns: `id, submission_id, quote_review_id, section_key,
item_type (document|quote_term|underwriting_info|referral_info|other), title,
description, status, required_by_rule_id, source (extraction|quote_review|manual|rule),
owner, due_date, notes, created_by, timestamps, resolved_at`.

| Wanted | Present? |
| --- | --- |
| field path | **No** (title is LLM free text) |
| label | `title` (free text, may carry client wording) |
| source | yes (`source` enum; **`rule` is defined but nothing produces it**; the manual add endpoint forces `manual`) |
| insurer | **No** |
| section | `section_key` (text) |
| required-by rule | `required_by_rule_id` (one rule only; portfolio rules are not recorded) |
| resolution state | yes (`status`, `resolved_at`, notes required for waived/not_required) |
| provenance | `quote_review_id` only |

Dedupe key is `section_key | item_type | title | description` (lower-cased text), so a
tracked item cannot be linked to a detected gap by identity — only by a convention on
title.

Generation is **gated on a quote review existing** (`handleGenerateMissingInfo` →
`no_quote_review`). Before an insurer quote is reviewed, nothing derives tracked items
from the recommendation at all; the submission page falls back to showing the raw
extraction `missing_information[]` when no tracked items exist
(`SubmissionDetail.tsx` ≈ L1417).

## E. Does any code already compare facts for contradiction?

Yes, five places — none is a general contradiction engine and none retains both values:

| Where | What it does | Verdict |
| --- | --- | --- |
| LLM extraction (`status: "conflicting"`, `conflicts[]`: `{field, description, sources[]}`) | The **model** says documents disagree. Both candidate values are not retained (value is normally `null`; `description` is free text). | An LLM determination. Not Atlas's, not reproducible, not comparable. |
| `section-merger.ts` (hybrid, **off in production**) | Duplicate emissions of a dotted key: `semanticEqual` (strings trim + case-fold, otherwise JSON equality). **Auto-resolves** by section precedence and records only `{field, "disagreement across sections", sources}`. Rejected values are dropped. | An existing precedence rule — but for the off pipeline; values not persisted. |
| Matcher tie profile (`tie_differences`, `tied_rules_disagree`) | Rule-vs-rule disagreement among equally good rules. | Insurer-rule data, already in quality (`scored_rule_selection_tie`, `section_rule_conflict`, `implied_product_rule_conflict`). Not a fact contradiction. |
| `quote-review.ts` `limitFromTrigger` | Quoted sum insured vs a rule's numeric trigger. | Fact vs *rule*, not fact vs fact. |
| Dedupe keys (`documentKey`, missing-info key, `communicationDedupeKey`) | Equality for de-duplication. | Not contradiction. |

The review UI (`RiskInformationPanel`) edits **`value` only**: it never changes a
field's `status`. So a field the model marked `conflicting` stays `conflicting` after a
human types the resolved value. **Atlas cannot tell a resolved conflict marker from an
unresolved one.** The UI's "Conflicting" band says "A human needs to resolve it" and
nothing can ever clear it.

## F. Point-in-time versus latest-only

| Source | Point-in-time? |
| --- | --- |
| `extracted_json` (AI original) | immutable per extraction row |
| `reviewed_json` | **latest only** (overwritten); `reviewed_at` / `reviewed_by` of the latest save |
| Previous reviews | **not retained**; only the changed field **paths** (never values) in the `extraction_reviewed` audit row |
| Earlier extraction rows | retained, but superseded by "latest wins" |
| `atlas_submissions` intake values (`broker_email`, `broker_name`, `client_name`, `request_type`) | effectively immutable (no edit endpoint); current row only |
| `atlas_documents` (type, status, scan_status) | current row only (status moves to `expired`) |
| Appetite rules | current row + `atlas_appetite_history`; evidence snapshots the rule at run time |
| `atlas_quote_reviews.review_snapshot` | point-in-time **copy of `reviewed_json`** (and quote terms derived **from that same `reviewed_json`**) |
| `evidence_json` | immutable per recommendation row — the only point-in-time artefact of a run |

## G. Which values can actually be compared (Phase 4 source map)

Atlas stores **one value per canonical field per extraction**
(`field → {value, status, confidence, source{document_id,file_name,page,section,snippet}}`).
The legacy pipeline is a single model call over all documents; the section merger's
rejected values are never persisted; shadow comparisons store counts only
(`atlas_pipeline_shadow_comparisons`: "No PII, no raw values").

Candidate pairs examined, and why each is in or out:

| Pair | Independent retained values? | Decision |
| --- | --- | --- |
| `extracted_json[f]` vs `reviewed_json[f]` | yes, but the **review mechanism explicitly supersedes** the extraction (`reviewed_json` is "the authoritative input to the matcher") | Not a contradiction. Respected as precedence; not reported. |
| earlier extraction row vs latest | yes | Superseded by "latest wins". Not reported. |
| `quote_terms.*` vs `extracted_client.*` / `current_cover.*` | same JSON, but **different subjects** (quoted vs current policy; insurer name vs current insurer) | Not the same fact. Out. |
| `quote_terms.risk_address` vs `extracted_client.risk_address` | same subject | Address: **no established deterministic normaliser in the repo** → forbidden fuzzy comparison. Out (reported). |
| `quote_terms.insured_name` / `atlas_submissions.client_name` vs `extracted_client.name`; `broker_name` vs `broker.name` | same subject | Names: no established normaliser (legal suffixes, initials, trading-as). Out; **business decision needed** to enable. |
| `quote_terms.sections[]` duplicate keys with different sums/premiums | same JSON | Two entries with one section key can be two legitimate risks. Not provably the same fact. Out. |
| `claims_history_available` (boolean) vs a "Claims history" document on file | different kinds of evidence | Would need an invented semantic mapping (`document_type` is a free label). Out. |
| `atlas_submissions.broker_email` (intake) vs `reviewed_json.broker.email` | two retained values, but **not the same semantic fact**: creator/login address versus intermediary/administrator address in the documents | **Out after independent review.** They must not be compared. |
| extraction `status: "conflicting"` / `conflicts[]` | one value (or none) + LLM prose | Out as contradictions (an LLM verdict; unclearable). Left to the existing "Conflicting" confidence band. Reported as a limitation. |

So **no production comparison** is defensible on today's data model. The
benchmark cases that need a boolean, date, number or matcher-consumed contradiction
(30, 31, 34) cannot be built from a real second source without inventing one; they
are proven at **engine level with an injected registry** and omitted from the
pipeline-level benchmark (see the Batch B document).

## H. Matcher input roles (what a fact is "needed for")

`FACT_FIELDS` (`recommendation-evidence.ts`) already records, per reviewed field, its
matcher roles (`product_candidate`, `risk_candidate`, `feature`, `confidence`).
Nothing in the repository says a field is **required**. The matcher runs without any
of them; with no product or risk candidate every insurer lands in
`insufficient_rule_match` (already reported as `taxonomy_match_missing`, material, and
`recommended_insurer_unscored`, blocker). Therefore **no fact is created as "required"
from a matcher role alone**; fact-level completeness items are limited to what an
authoritative record already says is outstanding: the extraction's own
`missing_information[]`.

## I. Producers and consumers

| Data | Producers | Consumers |
| --- | --- | --- |
| `missing_information[]` | extraction, section merger scaffold | `email-endpoints` / `email-templates` (broker request drafts), `handleGenerateMissingInfo`, `RiskInformationPanel`, `SubmissionDetail` fallback |
| `atlas_missing_info_items` | `handleGenerateMissingInfo`, `handleAddMissingInfo` | `MissingInfoPanel`, `CommunicationsPanel`, manager stats, referral pack / request drafts, `lib/workflow.ts` (`openMissing` readiness), WorkQueue / ManagerDashboard counts |
| `required_document_evidence` | `matcher.ts` | `explanation-composer`, `evidence` (v1/v2), `decision-workbench.ts`, `RecommendationPanel`, `EvidenceMode` |
| `quality.gaps` | `recommendation-quality.ts` | `EvidenceMode` / `recommendation-evidence.ts` view model |
| `evidence_json` | `recommendation-endpoints.ts` (insert) | `handleGetRecommendation` → `RecommendationPanel` / `EvidenceMode` |
| access | `GET /recommendation` requires `roleCanViewUnderwritingIntelligence` (brokers denied). `GET /missing-info` has **no** intelligence guard — only submission access (a broker can read items on their own submission; existing behaviour, not widened here). | |

## J. Findings that drive Batch B

1. There is no deterministic, aggregated, scope-aware completeness anywhere; the six
   notions do not share identity, so a gap is described up to three times (quality gap,
   required-document outcome, tracked item) with no link.
2. Tracked items cannot be tied to a detected gap except by title; the `rule` source
   enum value is unused; generation requires a quote review.
3. Fact-level "required" is unestablished in the repository. Do not invent it.
4. Atlas does not retain two independently comparable values for the same semantic fact.
   The honest deliverable is a small
   conservative engine + registry + a precise limitation statement, not a contradiction
   feed.
5. A resolved conflict marker is indistinguishable from an unresolved one, so markers
   must not be presented as unresolved contradictions.
6. The fingerprint did not see the new analysis **model versions**. The broker-login
   intake value must not become a contradiction input. Reviewed state (`extraction_id` + `reviewed_at`, which also
   covers `missing_information[]`), trusted documents, active rules and the insurer
   inventory are already fingerprinted.
