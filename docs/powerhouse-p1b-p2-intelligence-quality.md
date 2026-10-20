# Powerhouse Batch 2 — Evidence Mode, intelligence quality, provenance

Branch `powerhouse/p1b-p2-intelligence-quality`, started from `main` @ `34441a0`.
Baseline map of what existed: [powerhouse-p1b-p2-forensic-baseline.md](powerhouse-p1b-p2-forensic-baseline.md).

Atlas remains **decision support**. The deterministic matcher stays the only
thing that scores, ranks, declines or refers. Nothing in this batch uses an LLM
for evidence, quality or provenance, and nothing here changes a score.

## 1. What changed, and what deliberately did not

| Area | Result |
| --- | --- |
| Insurer score, band, rank basis, flags, document effects, confidence, notes | **Unchanged.** Same scoring code path. One-section submissions are byte-identical to v1 (500-fixture differential keeps its pinned hash). |
| Multi-section scoring | **Not changed.** Section outcomes are evaluated and shown, never aggregated. See §3 — this needs a business decision. |
| Input ordering | New. Rows are put in canonical order before matching; equal-score insurers have a defined order. |
| Matcher version | `2026-07-token-matching-v1` → `2026-10-section-evaluation-v2`. The bump records the new output contract and the now-defined tie order; **scoring semantics are identical**. |
| Evidence schema | `recommendation-evidence-v1` → `recommendation-evidence-v2` (§4). v1 rows stay readable. |
| Recommendation fingerprint | Now includes matcher, taxonomy and evidence-schema versions (§6). |
| `reasoning_json.matcher_input` | New rows no longer store client free text (§8). Historical rows untouched. |
| UI | Evidence Mode on the recommendation panel (§10). |
| Acceptance | One-command deterministic benchmark, `npm run test:powerhouse-acceptance` (§11). |
| Access | Unchanged. `GET /recommendation` still requires `roleCanViewUnderwritingIntelligence`; brokers remain denied. |
| Migrations | None. `evidence_json` is untyped jsonb. |

## 2. Matcher v2

### 2.1 Deterministic order (2.6)

* `canonicalAppetiteOrder` sorts rows by insurer id, canonical product-line key,
  canonical risk-type key, then rule id, using UTF-16 code-unit comparison (never
  `localeCompare`). It carries **no underwriting meaning**; it only removes
  dependence on PostgreSQL row order. The endpoint also adds
  `ORDER BY insurer_id, id` to the appetite load (belt and braces).
* Equal-scoring insurers are ordered after `ruled_out` and score by insurer name,
  then insurer id.
* Rule tie (equal taxonomy quality): the first rule in canonical order wins. This
  is a **policy-neutral identity tie-break**, not a judgement that one rule is
  better. When tied rules disagree, the evidence says so (`selection.tied_rules_disagree`)
  and the quality gate raises it (`scored_rule_selection_tie`).
* Proven by a 200-shuffle property test, a handler-level byte-identical test, and
  tie fixtures.
* **Every possible difference from v1 is one of exactly two intentional classes**
  (anything else fails the differential): `order_only` — equal-score insurers
  appear in the defined name/id order instead of arrival order (v1 listed
  portfolio-only insurers after product-rule insurers; the ranking shape,
  `(ruled_out, score)` down the list, is proven identical); and `tie_rule` — when
  several rules tie on taxonomy quality, the canonical-first rule is scored
  instead of "whichever row the database returned first". For a given database
  state v1's choice was arbitrary, so a re-run can differ from an old result
  **only** where such a tie exists; when the tied rules disagree the quality gate
  now says so.

### 2.2 Section intelligence (2.1, 2.4)

For each insurer the matcher now also returns, read-only:

* `selection` — which single product rule the score is based on, why
  (`only_candidate`, `highest_taxonomy_quality`, `tie_broken_by_canonical_order`),
  the tied rule ids, and how many matching rules were not listed.
* `section_evaluations` — one per **requested cover section** (de-duplicated by
  canonical key): applicable rule ids, the selected rule, the selection basis,
  whether tied rules disagree, a worst-first `outcome`
  (`hard_decline > soft_decline_referral > referral > caution > preferred > standard`,
  or `no_applicable_rule`), and `reflected_in_insurer_outcome`.
* `considered_rules` — the relevant rules the selector saw, with taxonomy quality,
  the sections they apply to, whether they set the score, why they did not
  (`lower_taxonomy_quality`, `lost_tie_canonical_order`), and the **conditions**
  each produced (`hard_decline`, `soft_decline_referral`, `referral`, `caution`,
  `preferred`) with the insurer-owned term and the authoritative feature-source
  label.

Conditions come from the **same** term scan (`findMatches`) the scorer uses; there
is no second scoring engine. `soft_decline_referral` (AI-inferred only) is kept
distinct from `hard_decline` at every level.

**Bound (2.4):** a rule is listed only if it relates to a submitted product
(taxonomy quality ≥ 2), is applicable to a requested section, or tied for best.
Risk-type-only matches that lost are *counted* (`omitted_risk_only_rule_count`),
not listed. There is no numeric cap — the bound is semantic relevance.

`section_evaluations` and `considered_rules` live in `evidence_json` only. The
compatibility columns (`reasoning_json.top`, `secondary_options_json`,
`not_recommended_json`) keep their historical shape.

## 3. Multi-section scoring and cross-section decline (2.2, 2.3) — STOPPED

> **Decision: not implemented. Surfaced as a quality blocker and documented as a
> business decision.**

The matcher scores one best product rule per insurer plus all portfolio rules. To
change that, Atlas would need an answer to each of these, and **nothing in the
existing matcher, rules schema, or documentation answers any of them**:

1. If one requested section is **declined** and another is **preferred**, is the
   insurer ruled out (all-or-nothing placement), or viable for the sections it
   will write (partial placement)?
2. How do section scores combine: average, minimum, weighted, or portfolio base
   plus per-section deltas? Weighted by what?
3. Do portfolio-level adjustments (`-10` caution, `-8` referral) apply once or
   once per section?
4. Does a referral in *any* requested section set the insurer-level
   `referral_required` flag and affect senior-review routing?
5. For one-section submissions the answer is fixed by parity with v1; for
   multi-section it is open.

The v1 header comment records the same position ("per-cover-section scoring …
is deliberately deferred"). Inventing an answer would be an underwriting-policy
decision made in code, so this batch instead:

* implements section-level evaluation output (§2.2);
* **preserves the overall score and rank exactly** (parity proven);
* states in every v2 packet that sections are `evaluated_not_aggregated`
  (`scoring_scope`), so no reader has to guess;
* raises the limitation through the quality gate — an unreflected hard decline is
  a **blocker** (`section_hard_decline_not_reflected`), an unreflected
  referral/soft decline/caution is **material**, and any other unscored section is
  **advisory** (`section_outcome_not_scored`).

The exact decision needed from the business is listed in §12.

## 4. Evidence schema decision (2.9): **v2, not additive v1**

`recommendation-evidence-v1` is a production contract. v2 is required because it
changes the *meaning* of persisted fields:

| Change | Why it cannot be silent under v1 |
| --- | --- |
| `quality.status: complete \| gaps_present` → `quality.state: decision_ready \| caution \| incomplete` + severities | A v1 reader (or a future dashboard) would read "complete" where v2 says "incomplete". |
| Per-section evaluations next to an insurer score that ignores them | New semantics for "what the outcome covers". |
| `selection` / `considered_rules` | Changes what "no rule appears" means: v1 absence = not matched; v2 absence = genuinely not relevant. |
| Matcher version `v2` | Tie-order is defined; provenance of scoring changed. |

Compatibility:

* **No migration, no rewrite.** `evidence_json` is jsonb; old rows keep
  `recommendation-evidence-v1`.
* The v1 builder (`buildRecommendationEvidence`) is retained, unchanged and
  tested; v2 is a strict **superset** for shared fields (a test compares every v1
  insurer key with v2).
* The frontend models `RecommendationEvidence = V1 | V2` discriminated on
  `schema_version` and reads both through `normaliseEvidence()`; v1 shows its
  coarse `complete`/`gaps_present` status honestly and shows sections,
  considered rules and severities as "not captured" — it is never converted into
  a fabricated v2.
* The fingerprint includes the evidence schema version, so a schema bump
  invalidates cached jobs.

## 5. Quality gate (P1C)

Pure, deterministic, no LLM, no thresholds. Module:
`worker/src/recommendation-quality.ts`. Model version `recommendation-quality-v1`.

It controls **presentation and reliance only**. It never blocks the underwriter,
never changes a score/rank/flag, and **never turns `incomplete` into a decline**.

### 5.1 Vocabulary

| Severity | Meaning |
| --- | --- |
| `blocker` | Atlas cannot defend or rely on part of the outcome as presented (hidden hard decline, unresolvable rule, outcome that depends on an arbitrary tie, unscored top pick). |
| `material` | The outcome is usable, but a limitation changes how far it can be relied on and must be shown. |
| `advisory` | Provenance or scope detail; does not change reliance. |

| State | Rule |
| --- | --- |
| `incomplete` | ≥ 1 blocker |
| `caution` | no blocker, ≥ 1 material |
| `decision_ready` | only advisory gaps, or none |

Overall state = worst severity across **all** gaps. Each scored insurer also has
its own state computed from its own gaps only. No-data insurers carry no state.

"Decisive rule" (used by two rows below) = the scored rule, or any rule that
carries a hard decline, soft decline or referral (as an effect or a condition).

### 5.2 Classification table

| Code | Scope | Severity | Predicate | Rationale |
| --- | --- | --- | --- | --- |
| `insurer_appetite_data_missing` | insurer | advisory | insurer has no active appetite rule | Narrows what the ranking covers; does not weaken the evidence for ranked insurers. Always shown. |
| `matched_rule_snapshot_missing` | rule | **blocker** | a rule id in the matcher output or considered set is absent from the active rule set | Atlas cannot show the rule behind part of the outcome. |
| `rule_source_document_missing` | rule | **material** if rule is `ai_extracted` **and** decisive; else advisory | `source_document_id` is null | An AI-extracted rule that drives the outcome with no document cannot be traced to a guideline. A hand-entered rule has no document by design. A non-decisive rule is not what the outcome rests on. |
| `rule_source_locator_incomplete` | rule | advisory | document id present; any of file / page / section / quote missing | The document is identified; a human can locate the clause. A missing page number is **not** a blocker. |
| `matched_input_source_missing` | rule | **material** if decisive; else advisory | terms matched but no feature-source label | Cannot show what in the submission triggered a decisive rule. |
| `reviewed_fact_confidence_unavailable` | reviewed_fact | advisory | fact has no provider confidence | Inherent for AI-inferred red flags; already disclosed by the existing confidence notice. |
| `taxonomy_match_missing` | insurer | **material** | no product rule related to the submission | Existing semantics: manual review, provisional ranking. |
| `recommended_insurer_unscored` | recommendation | **blocker** | the first non-ruled-out insurer has `manual_review_required` | The recommendation itself has no deterministic basis. |
| `scored_rule_product_unmatched` | insurer | **material** | scored rule matched the risk type only (taxonomy quality 1) | The score rests on a rule for a different product line. |
| `scored_rule_selection_tie` | insurer | **blocker** if tied rules differ on hard decline; **material** if they differ only in level/other conditions; no gap if they agree | scored rule chosen by identity among equally good rules | The insurer's score/ruling depends on an arbitrary tie. |
| `requested_section_not_evaluated` | section | **material** (viable insurer) / advisory (ruled out) | no product rule relates to the requested section | The outcome says nothing about that section. |
| `section_rule_conflict` | section | **blocker** if tied rules for the section differ on hard decline; else **material** | several equally good rules for one section disagree | Section outcome depends on an arbitrary tie. |
| `section_hard_decline_not_reflected` | section | **blocker** (viable) / advisory (ruled out) | section's selected rule has a hard decline but is not the scored rule | The insurer is shown viable while declining a requested section. |
| `section_soft_decline_not_reflected` | section | **material** / advisory | AI-inferred decline in an unscored section | Distinct from a hard decline; needs human confirmation. |
| `section_referral_not_reflected` | section | **material** / advisory | referral trigger in an unscored section | The insurer-level referral flag does not show it. |
| `section_caution_not_reflected` | section | **material** / advisory | caution in an unscored section | The score does not reflect it. |
| `section_outcome_not_scored` | section | advisory | unscored section with no adverse outcome | The aggregation limitation (§3), with nothing adverse behind it. |
| `required_document_missing` | insurer | advisory | a required document is not trusted-present, insurer not ruled out | Does not change appetite fit; effect already carried by the confidence adjustment and the document checklist. One gap per canonical document. |
| `no_trusted_documents` | recommendation | **material** if any non-ruled-out insurer lists required documents; else advisory | zero active exact-clean documents | Document evidence is wholly absent and something is required. |
| `requested_sections_not_declared` | recommendation | advisory | no cover sections in the reviewed submission | Section evaluation had nothing to evaluate. |

"Ruled out" downgrades only the *not-reflected* and *not-evaluated* rows: an
insurer already ruled out cannot be made worse by a section Atlas did not score.

## 6. Fingerprint versioning (2.5)

`buildRecommendationFingerprint` now takes **required** `matcherVersion`,
`taxonomyVersion`, `evidenceSchemaVersion` and hashes them. Required (not
optional) so a future caller cannot forget. A completed job from an older matcher,
taxonomy or evidence schema no longer answers `unchanged_input`; the next run
recomputes. Historical job rows are untouched (they simply stop matching).
Regression tests exercise the real endpoint cache path.

## 7. Tie ordering (2.6)

See §2.1. Tie fixtures: Gamma (tied motor vs goods-in-transit rule) and the
equal-score insurer ordering test.

## 8. `reasoning_json.matcher_input` privacy (2.7)

### Consumer audit

| Consumer | Needs raw feature text? |
| --- | --- |
| Worker runtime (`recommendation-endpoints`, `quote-review-endpoints`, `phase4-background`, `insurer-endpoints`) | No |
| Frontend (`src/**`) | No — `Recommendation.reasoning_json` declares no `matcher_input` |
| Email templates | No |
| Email legacy-Sonnet path | Re-sent the whole `reasoning_json` into a prompt that already contains the full reviewed extraction — redundant |
| Tests | Only `available_documents` |

No required runtime consumer, so **future** rows persist the same privacy-minimised
shape as the evidence copy plus `snapshot_version: "matcher-input-minimised-v1"`.

### Before / after

| | Before | After (new rows) |
| --- | --- | --- |
| `features[].text` (occupation, risk address, entity type, endorsements, exclusions, red flags, …) | persisted verbatim | **not persisted**; `{source, ai_inferred, value_retained:false}` only |
| product / risk / section candidates | persisted | persisted (see residual) |
| trusted document labels, confidence + availability | persisted | persisted (labels sorted, de-duplicated) |

Test: seven synthetic sentinels (name, ID, phone, bank detail, street address,
policy number, arbitrary free text) placed in feature-only fields appear in **no**
persisted column, audit write, job write or submission write.

### What remains persisted, and why

* **Taxonomy candidates** (`product_candidates`, `risk_candidates`,
  `section_candidates`). They are the matcher's classification input and are what
  evidence needs to explain a ranking. They can echo reviewed classification
  fields (`business_sector`, `primary_risk_type`, `secondary_risk_types`,
  `complexity_level`, `cover_sections`). A test pins the *exact* locations where
  such text is retained (`reasoning_json.matcher_input.risk_candidates[]` and
  `evidence_json.matcher_input.risk_candidates[]`) and fails if it appears anywhere
  else.
* Insurer-owned rule terms, source excerpts and rule provenance.
* **Not retained anywhere:** raw feature values.

### Reconstruction trade-off (needs owner awareness)

`atlas_extractions.reviewed_json` is **overwritten in place** on every re-review.
Therefore the old raw `matcher_input` was the only point-in-time copy of a run's
raw features. For new rows, a run's **explanation** remains fully reconstructible
from `evidence_json` (candidates, source labels, matched terms with sources,
per-rule contributions, score and confidence reconciliation, rule snapshots), but
its **exact re-execution on the original raw text** is no longer possible from the
recommendation row alone. Historical rows are not rewritten and keep full
re-executability. The change is one function (`minimisedMatcherInputSnapshot`) if
the owner prefers the opposite trade.

## 9. Provenance (2.8)

Preserved point-in-time and surfaced where the pipeline already carries it:
`source_document_id`, filename, page, section, quote and `source` (`ai_extracted` /
`manual`) per rule — now also for **considered** rules, not only matched ones.
Nothing is fabricated: absent values stay `null` and the UI says "not recorded".

Not available upstream, therefore **left missing and reported**: field-level
page/quote provenance for *reviewed extraction facts* (the extraction contract does
not carry it), so `source_quote` is never presented as proof of a specific term —
the UI labels it "Source excerpt for this rule".

## 10. Evidence Mode UI (P1B)

Source of truth: `evidence_json` only. View model: `src/lib/recommendation-evidence.ts`
(separate from the API client). Components: `src/components/EvidenceMode.tsx`.
Integration: `RecommendationPanel` (one `IntelligenceQualityPanel` under the
summary, one "Why Atlas ranked this" button per insurer, one drawer).

**Recommendation level** — "Intelligence quality": reliance state, blocker /
material / advisory counts, the limitations that affect reliance (each names its
insurer and section), a plain statement that sections are evaluated separately
and not combined into the score, and an "Insurers without appetite data" list
("No active appetite data available" — never a score, decline or poor fit).

**Per insurer** (drawer, in this order): Ranking explanation (rank, internal score,
what strengthened / weakened it with exact points, score and confidence
reconciliation) · Rules applied (insurer-owned matched term + the authoritative
input-source label + exact contribution) · Requested sections and rules considered
(v2) · Referral and decline triggers (hard decline, possible decline needing human
confirmation, referral, caution — kept distinct) · Required documents · Trusted
evidence · Evidence gaps — what Atlas does not know · Source guideline provenance ·
Intelligence quality.

Rules the UI keeps (each has a test): display, never recompute; missing provenance
is stated ("Not recorded", dashed underline, "Provenance incomplete" badge — never
colour alone); the excerpt is labelled "Source excerpt for this rule" and not
offered as proof of a matched term; "Incomplete" is worded as a reliance signal
("Nothing is blocked or declined by this"); ordinary users see no raw JSON and no
technical IDs; managers and administrators (existing `canManage` convention) get a
collapsed "Diagnostics (internal staff)" area of labelled values; no raw document
bodies, storage paths or signed URLs exist anywhere in the data it receives.

| State | Behaviour |
| --- | --- |
| v2 | Full quality panel + drawer |
| v1 complete / gaps_present | Coarse status as recorded; "Recorded before the intelligence quality gate"; sections / considered rules / severities shown as not captured; gaps listed as "Not classified (evidence v1)" |
| `evidence_json` null / absent | "Detailed evidence was not captured for this historical recommendation."; no evidence button |
| unknown or malformed | "Evidence format not supported"; recommendation still renders |
| no-data insurer | "No active appetite data available" |
| no trusted documents | "No trusted documents were available" |

Tests: `src/test/recommendation-evidence.test.ts` (22) and
`src/test/evidence-mode.test.tsx` (31), rendered against the **real** rows the
backend produces (`tests/powerhouse/fixtures/snapshots`, drift-checked by the
Worker suite) — including axe, Escape / focus return, privacy sentinels, and the
historical cases.

## 11. Deterministic acceptance benchmark (P1D)

`npm run test:powerhouse-acceptance` (also in `npm test`), no network. It runs, in
order: the 15 cases; the frontend snapshot drift check; the v1 baseline golden;
matcher v2; quality gate; evidence v2; persistence contract; a randomised
old-vs-new differential; and the Phase 1A 500-fixture differential.

| # | Case | What it pins |
| --- | --- | --- |
| 1 | Single-section baseline | v1 parity; ranking preferred > standard > caution > ruled out; decision_ready |
| 2 | Multi-section, compatible | both sections evaluated; only the aggregation advisory |
| 3 | Multi-section, preferred + caution | caution visible, material, score unchanged |
| 4 | Multi-section, referral | unreflected referral visible and does not set the v1 flag; reflected referral costs 8 |
| 5 | Multi-section, hard decline | hidden declines are blockers; ruled-out insurer's is advisory; ranking unchanged |
| 6 | AI-inferred decline | stays `soft_decline_referral`, never hard |
| 7 | Required document missing | confidence −0.10 only, advisory |
| 8 | Document required by product + portfolio | one canonical outcome, one penalty |
| 9 | No-appetite-data insurers | explicit, null rank/score, no state |
| 10 | Incomplete provenance | missing stays missing; advisory vs material by materiality |
| 11 | Ties | name-then-id insurer order; canonical rule tie flagged as a blocker |
| 12 | Privacy sentinels | seven sentinel classes absent from every persisted column |
| 13 | Historical evidence v1 / null | read back verbatim, vocabulary not rewritten |
| 14 | No trusted documents | empty trusted set; `no_trusted_documents` material; caution |
| 15 | Trusted exact-clean document | only active + clean counts; decision_ready |

Per case (committed `*.expected.json` **plus** hand-written intent assertions that
do not come from the golden): insurer order, score, rank, rule effects,
referral/decline state, section outcomes, document outcomes, quality state,
evidence schema, privacy result. Every case is re-run with reversed and shuffled
appetite rows and must persist an identical row, and is compared with a **frozen
copy of the production v1 matcher** (`tests/powerhouse/reference`, verbatim from
`34441a0`) and classified `identical | order_only | tie_rule` — anything else
fails.

Differential (3000 randomised fixtures per corpus, single- and multi-section):
corpus A (canonical rows) — every insurer's answer equals v1; corpus B (rows
shuffled, names unrelated to ids, i.e. production's unspecified DB order) — every
difference is a named, intentional class. Counts are printed by the run.

## 12. Business decisions required (not code decisions)

1. **Multi-section aggregation** (§3, five questions). Until answered, Atlas
   shows section outcomes and flags unreflected declines/referrals/cautions but
   does not combine them.
2. **Rule-tie policy:** keep the policy-neutral identity ordering (and the
   blocker when tied rules disagree on a decline), or define a business tie-break
   (e.g. prefer the more restrictive rule).
3. **Whether an `incomplete` recommendation should ever require sign-off** (today
   it only informs and never blocks).
4. **Raw-text reconstruction vs privacy** (§8) — confirm the trade.
5. **Who may see rule source excerpts and the diagnostics area** — currently the
   existing underwriting-intelligence roles (excerpts) and `canManage` roles
   (diagnostics).

## 13. Known remaining limitations

* The recommendation fingerprint is a 32-bit hash and does not include the active
  insurer list (so adding an insurer with no rules does not invalidate a cached
  run). Found, out of scope.
* Section matching uses taxonomy relatedness on the rule's `product_line` only;
  rules keyed on `risk_type` without a related product line are risk-only matches.
* `outcome_reasons.evidence_gaps` (v1-style strings) is retained for continuity;
  `quality.gaps` is the authoritative list in v2.
* Reviewed-fact page/quote provenance is unavailable upstream.

## 14. Verification record

Run on the final branch head (nothing pushed, migrated or deployed).

| Check | Result |
| --- | --- |
| Backend, every script in `npm test` (45; compiled once, same node commands) | all exit 0, ~1025 tests, 0 failures |
| Matcher / recommendation / Phase 1A evidence + handler / Phase 24 document trust | pass |
| `npm run test:powerhouse-acceptance` | 108 tests, 0 failures; differential: zero unexpected differences |
| Phase 1A 500-fixture differential | unchanged pinned hash `b14d9927…a36` |
| Frontend vitest | 724 tests in 40 files (baseline 671 in 38; +53 new); see note |
| Frontend `tsc -b` + production build | pass |
| Worker `tsc --noEmit` | pass |
| `wrangler deploy --dry-run --env production` (local bundle; nothing uploaded) | pass, bindings unchanged, pipeline `legacy`, no Graph vars |
| `git diff --check` | clean |

Note on the frontend suite: under full-suite parallel load a few **unrelated**
tests are timing-flaky on this machine (`WorkQueue` first test, `pipeline-dashboard`
"manager defaults to All", `insurer-intelligence-workbench` "preserves the user's
tab choice"). The untouched baseline `34441a0` fails `WorkQueue` the same way under
the same load (670/671), and every one of these files passes when run on its own
on this branch (the insurer-intelligence file 6/6, WorkQueue + pipeline-dashboard
48/48). The 53 new tests passed in every run.

Old-vs-new matcher differential (3000 randomised fixtures per corpus, frozen v1
reference): scoring identical for every insurer in every fixture with canonical
rows (single-section 1501 identical + 11 order_only; multi-section 1479 identical
+ 9 order_only; 0 tie_rule); with production-like unspecified row order every
difference is `order_only` or `tie_rule` (single-section 733 / 344 / 435;
multi-section 639 / 268 / 581 — identical / order_only / tie_rule); unexpected
differences 0; live-matcher order-invariance failures 0.
