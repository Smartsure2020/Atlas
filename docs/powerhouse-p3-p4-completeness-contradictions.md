# Powerhouse Batch B — deterministic completeness and contradiction detection

Branch `powerhouse/p3-p4-completeness-contradictions`, started from `main` @ `1d56fbb`
(Batch 2, production accepted). Baseline map of what existed:
[powerhouse-p3-p4-forensic-baseline.md](powerhouse-p3-p4-forensic-baseline.md).

Atlas remains **decision support**. The deterministic matcher remains the only thing
that scores, ranks, declines or refers. Nothing in this batch uses an LLM, and nothing
in it changes a score, a rank, a flag, a confidence or a required-document penalty.

Atlas moves from *"here is the recommendation and how reliable its evidence is"* to
*"here is exactly what information is still missing, and here are the recorded values
that disagree."*

## 1. What changed, and what deliberately did not

| Area | Result |
| --- | --- |
| Insurer score, band, rank, flags, document effects, confidence, notes | **Unchanged.** Proven by the frozen-v1 differential (0 unexpected differences), the 500-fixture pinned hash, twin-run comparisons (cases 29, 35) and a unit test that adds ten reported items plus a contradiction and compares every authoritative field. |
| Matcher version | **Not bumped** (`2026-10-section-evaluation-v2`). Matcher semantics did not change. |
| Evidence schema | `recommendation-evidence-v2` → **`recommendation-evidence-v3`** (§7). v1, v2 and NULL rows stay readable and are never rewritten or reconstructed. |
| Quality model | `recommendation-quality-v2` → **`recommendation-quality-v3`** (§6). The v2 table is frozen and wrapped, not edited. |
| New models | `recommendation-completeness-v1`, `recommendation-contradictions-v1`. |
| Fingerprint | Gains both model versions and a SHA-256 digest of the compared recorded values (§8). |
| UI | Evidence Mode: *What Atlas still needs* and *Conflicts to review*. Missing Information tab: *What Atlas detected* (§10). |
| Access | Unchanged. Nothing is exposed to brokers or the public (§13). |
| Migrations | **None.** `evidence_json` is untyped jsonb; the existing missing-information table is reused (§15). |
| Graph / pipeline | Unchanged: Graph off, document pipeline `legacy`. |

## 2. The central finding — read this first

The forensic baseline established that **Atlas stores one value per canonical field
per extraction.** Re-reviews overwrite `reviewed_json`; the hybrid merger's rejected
duplicate values are never persisted; shadow comparisons store counts only. The model's
own `status: "conflicting"` and `conflicts[]` carry prose, not two comparable values, and
no review action can clear them. So on today's data model:

* **Exactly one contradiction is defensible**: the submission's **intake broker email**
  versus the **reviewed extraction's broker email**. It is a personal identifier, the
  matcher does not consume it, and the repository already compares emails with
  `trim().toLowerCase()` everywhere (`config.ts`, `user-directory.ts`, `oauth.ts`,
  `dev-sign-in.ts`). Its severity is therefore **advisory**.
* The engine, contract, normalisers, clustering, severity policy, quality linkage, UI
  and fingerprinting are generic and fully tested against injected registries for
  boolean, date, number, identifier, closed-enum and matcher-consumed fields — but
  **no production field other than broker email is registered**, because registering
  one without a second independent source would be inventing one.
* Every other candidate was examined and left out for a stated reason (baseline §G):
  extracted-vs-reviewed is superseded by the explicit review mechanism; names and
  addresses have no established deterministic normaliser; `quote_terms` describe a
  different subject than `current_cover`; a "claims history available" boolean against
  a document on file would need an invented semantic mapping.

This is the honest answer to *"if Atlas does NOT retain two independently comparable
values for a field, it cannot claim a contradiction."* It is reported again under
Known limitations.

## 3. Phase 3 — completeness

Module `worker/src/completeness.ts`. **Augment, do not rebuild**: it restates what the
matcher output and persisted evidence already establish and gives each finding one
shared identity.

### 3.1 What counts as "required"

Only an existing authoritative source can make something required. The packet states
this itself (`completeness.requirement_basis`):

| Subject | Authority | Where it comes from |
| --- | --- | --- |
| Documents | An insurer's appetite rule (`required_documents`) | The matcher's canonical required-document outcome; presence is its trusted active + exact-clean test. An unrelated clean document never satisfies it. |
| Sections | The cover sections the submission **declared** | `requested_sections`; implied products when none were declared (Batch 2). Nothing is invented. |
| Facts | The reviewed extraction's own `missing_information[]` | The only fact-level record Atlas keeps. |
| Anything else | **None.** `universal_requirements = "none_defined"` | A vehicle registration, an ID number, a turnover figure: not required unless an authority above says so. |

"Documents" means the requirements the matcher **actually applied** to an insurer — its
scored product rule plus its portfolio rules (the set that already costs confidence).
A required-document set on a rule the matcher considered but did not select stays on that
rule's `considered_rules` entry (Batch 2); it is not turned into a completeness item.

A matcher input *role* (a field feeds the matcher) is deliberately **not** treated as a
requirement: the matcher runs without any of those fields and already reports the
consequence (`taxonomy_match_missing`).

### 3.2 Item contract

```
item_id            cmp:<code>:<insurer|->:<section|->:<doc key | reference | ->
code               required_document_missing | requested_sections_not_declared |
                   requested_section_not_evaluated | section_rule_ambiguous |
                   multiple_products_without_declared_sections |
                   implied_product_rule_ambiguous | insurer_appetite_data_missing |
                   insurer_rule_match_missing | extraction_reported_information_missing
scope              submission | insurer | section | document | fact
status             missing | not_evaluated | ambiguous
materiality        material | nonblocking
affects            recommendation | insurer | section | rule | not_determined
insurer_ids[] section_keys[] rule_ids[] field_path? label? document_type? document_key?
trust_basis        active_exact_clean | null           (documents)
required_by[]      { authority, insurer_id?, rule_id?, rule_scope?, section_key?,
                     reference?, priority?, present? }  WHO / WHAT requires it
source             required_document_outcome | section_evaluation | … 
quality_gap_ids[]  the quality gaps that describe the same problem (filled by v3)
resolution_state   "open" — a packet never claims later handling
```

It answers *what* (code, label, document_type, field_path), *why / who* (`required_by`
authorities), *where from* (`source`, rule ids and — through them — the rule snapshot's
provenance already in the packet), and *what it affects* (`affects`, `insurer_ids`,
`section_keys`, `rule_ids`).

### 3.3 State and materiality

Vocabulary: `complete | incomplete_nonblocking | incomplete_material`. There is **no
blocker** — a completeness gap is never a decline and never a block. Materiality mirrors
the existing quality classification so reliance and completeness cannot disagree (an
invariant test asserts every material item is backed by a material-or-worse gap):

| Item | Material when | Otherwise |
| --- | --- | --- |
| `required_document_missing` | at least one insurer that lacks it has **none** of its required documents evidenced (`required_documents_unevidenced`) | nonblocking |
| `requested_section_not_evaluated` | the insurer is viable | nonblocking once ruled out |
| `section_rule_ambiguous`, `implied_product_rule_ambiguous` | always (tied rules disagree) | — |
| `multiple_products_without_declared_sections` | the insurer is viable | nonblocking once ruled out |
| `insurer_rule_match_missing` | always (provisional ranking) | — |
| `insurer_appetite_data_missing`, `requested_sections_not_declared`, `extraction_reported_information_missing` | never | nonblocking |

State is computed per insurer (from that insurer's own items) and for the case (worst of
all). A required document is **one item across insurers**, keyed by the matcher's
`documentKey`; it keeps every requiring rule, its scope (`product` / `portfolio`) and
each insurer's presence, and its materiality is the worst across insurers while each
insurer keeps its own state.

### 3.4 Privacy of fact items

The extraction's `field` and `reason_required` are model-written free text and are
**never persisted**. A record becomes an item with a schema path/label only when its
text names a known extraction field exactly (or a bare key that is unique in the schema);
otherwise only its position (`missing_information[2]`) and priority are kept. At most 50
are persisted; the overflow is a count.

### 3.5 Fact completeness is intentionally thin

There is no universal fact requirement in Atlas, so fact-level completeness is limited to
what the extraction reported. If the business wants more (§17), it is a rule table, not
code inference.

## 4. Phase 4 — contradiction detection

Module `worker/src/contradictions.ts`.

### 4.1 Principles (each enforced by a test)

* Deterministic and conservative: a contradiction is two or more values that are
  **different after a documented normalisation**, recorded by **independent sources**,
  for a field **explicitly registered** as comparable.
* **No source precedence** (`source_precedence: "none_applied"`). Reviewed does not beat
  intake, newer does not beat older, confidence does not win. The analysis contains no
  "chosen / winner / correct" field and swapping which source holds which value changes
  only attribution.
* Absent, `null`, blank and whitespace are **nothing recorded**, never a disagreement.
  An unparseable value, or a source that could not be read, is **comparison
  unavailable** — never a contradiction.
* Agreement is not evidence and is never scored.
* **One logical cluster per field**: A A B B is one contradiction with two value
  groups of two sources, not four pairs.
* A contradiction is not a decline, fraud or misrepresentation. Severity is never
  `blocker` (that would need a counterfactual matcher run proving the field drives a
  hard decline; not done, see §17).

### 4.2 Contract

```
contradiction_id   ctr:<field_key>:<12 hex of SHA-256 over the sorted value digests>
code               conflicting_recorded_values
field_key, field_path?, label, scope=submission
status / resolution_state   "unresolved"
severity           material | advisory
severity_basis     matcher_consumed_field | field_not_consumed_by_matcher
comparison_basis   { kind, normalization, normalization_steps[] }
affects_matcher_input, matcher_roles[]      (derived from the single FACT_FIELDS table)
value_groups[]     ≥ 2: { value_digest, value_display, source_count, sources[] }
sources[]          { source_id, source_label, pointer, field_status, confidence }
quality_gap_id     back-reference
```

The suggested `left` / `right` became `value_groups[]` precisely to avoid pairwise
explosion. `pointer` is an id-level locator (table + column, or extraction id + field
path + a validated document UUID + page) — never a file name, snippet, URL or path.
`analysis.comparisons[]` records, for every registered field that had a recorded value,
which sources were compared and the outcome (`agree | conflict | single_source |
comparison_unavailable`), so the packet answers *what Atlas saw*.

### 4.3 Supported comparison kinds and normalisation

| Kind | Normaliser | Steps (in order) | Refused (→ comparison unavailable) |
| --- | --- | --- | --- |
| enum | `enum_trim_collapse_casefold` | require text; trim; collapse whitespace runs; lower-case | non-text, > 200 chars |
| boolean | `boolean_yes_no` | accept boolean, `1/0`, `true/false/yes/no/y/n` (trim, lower-case) → `"true" / "false"` | anything else |
| identifier | `identifier_strip_separators_uppercase` | text or number; remove whitespace and `- _ . / \`; upper-case; 1–64 chars of `A-Z0-9` | any other character (`#`, accents…), empty, too long |
| email | `email_trim_lowercase` | text; trim; lower-case; one `@` between a local part and a dotted domain, no spaces / `<>` / commas / semicolons | display-name forms, lists, malformed |
| date | `date_iso_calendar` | text; trim; `YYYY-MM-DD`; a real calendar date, year ≥ 1000 | `01/05/2026` (ambiguous), datetimes, `2026-02-29` |
| number | `number_plain_decimal` | finite number or `[+-]digits[.digits]`; drop `+`, leading and trailing zeros; `-0` = `0`; compared as **text** | currency, thousands separators, exponents |

"1" and "I", "0" and "O" are never merged; there is no tolerance and no similarity
threshold (a one-letter difference in an email is a contradiction — case 33).

### 4.4 Value representation and privacy

Raw values are **transient**: normalised, digested, discarded. Persisted:

* a **domain-separated SHA-256 prefix** (16 hex) per value group — identity only;
* `value_display`: the typed canonical value for boolean / date / number; for an `enum`
  **only** when the registry declares a `closed_vocabulary` containing it (an "enum" that
  is really free text is withheld); for a personal identifier a **mask**
  (`a•••@•••.za`: first character of the local part and the TLD; identifiers keep the
  first character and last two). Two values that mask the same are told apart by their
  digest reference.

A digest of a low-entropy value (an email address, a boolean) can be guessed by someone
who can already read the packet and has a candidate list. It is persisted for **identity
and reproducibility, not secrecy**; the control is the existing access rule (§13), which
is why only a 64-bit prefix is stored and why nothing is ever logged.

Not persisted anywhere: raw text, full addresses, domains, file names, snippets, URLs,
storage paths, tokens. Nothing is logged: the only log line on this path is
`intake_record_unavailable` with a code and a submission id.

### 4.5 Source precedence and resolution

Atlas applies none (§4.1). The one existing precedence — a saved human review supersedes
the model's original extraction — is **respected by never reporting extracted-vs-reviewed
as a contradiction.**

Resolution: the engine always emits `unresolved` (a contradiction that still exists is
unresolved by definition). It clears when a later recommendation no longer finds the
values in conflict (e.g. the record was corrected); the earlier packet still states it
existed, and the `extraction_reviewed` audit row records *which fields* were changed.
Contradictions are **deliberately not trackable in the Missing Information table**:
tracked items are readable by the submission's broker and appear in request drafts, so an
internal conflict note would leak. A persistent "reviewed / waived" record would need
relational state — §15.

## 5. Where the sources come from (data flow)

`handleRunRecommendation` reads, before the cache decision:

1. the active insurer inventory (existing, fail-closed);
2. **the intake record: `select("broker_email")` from `atlas_submissions`** — the pasted
   email body is never selected. This read is **not fail-closed**: it feeds a reliance
   signal, never a score. An unreadable record becomes `source_unavailable` in the
   analysis and a distinct value in the fingerprint; a missing row is `not_found`.

`collectObservations` turns those and the reviewed extraction into observations;
`fingerprintObservations` digests them for the cache key; the same observations are then
handed to the pure builder. No second read, no raw value past this boundary.

## 6. Quality model v3

`recommendation-quality-v3.ts` **wraps** the frozen v2 table (`assessQuality`) and adds
only linkage and two codes. Nothing is double counted: a completeness item that the v2
table already classified *points at* its gap(s) by stable id (and the gap points back);
a gap is created only for what had none.

| Completeness code | Existing v2 gap(s) it links to |
| --- | --- |
| `required_document_missing` | `required_document_missing`, `required_documents_unevidenced` |
| `requested_sections_not_declared` | same code |
| `requested_section_not_evaluated` | same code |
| `section_rule_ambiguous` / `implied_product_rule_ambiguous` | `section_rule_conflict` / `implied_product_rule_conflict` |
| `multiple_products_without_declared_sections` | same code |
| `insurer_appetite_data_missing` | same code |
| `insurer_rule_match_missing` | `taxonomy_match_missing` |

New gap codes (both recommendation-level, so they colour the overall state but never an
individual insurer's):

| Code | Severity | When |
| --- | --- | --- |
| `extraction_reported_information_missing` | advisory | one per reported item |
| `conflicting_recorded_values` | material when the field is consumed by the matcher, else advisory — **never a blocker** | one per contradiction |

Every gap now carries `completeness_item_ids[]` and `contradiction_id`. v3 gaps for the
v2 codes are identical, in the same order, to what the v2 builder produces for the same
input (asserted). The gate still controls **presentation and reliance only**.

## 7. Evidence schema decision: **v3**

`recommendation-evidence-v2` is live. v3 is required, not an additive v2 tweak, because it
changes what a reader may conclude from `quality` (new codes, links, a new model stamp)
and adds two analyses a v2 reader must not assume were run. v3 is a strict superset: both
builders start from one `EvidenceBaseV2`, so every shared field is produced by a single
implementation (asserted field by field). A historical v2 row is never rewritten,
reconstructed or shown as though the analyses ran; the frontend is a discriminated union
(`v1 | v2 | v3`) with a structural guard per version, and a v3 label does not rescue a
v2-shaped packet.

## 8. Fingerprint and versioning

New **required** inputs of `buildRecommendationFingerprint`:
`completenessModelVersion`, `contradictionModelVersion`, `contradictionInputsDigest`;
`evidenceSchemaVersion` and `qualityModelVersion` now carry the v3 values. The digest is
a SHA-256 over every registered observation's field, source and **normalised** outcome
(or why it is unparseable), its pointer, field status and confidence, and unreadable
sources — so a cosmetic edit (case, whitespace) does not force a recompute but a real
edit to the intake address does, which `reviewed_at` could never have caught. "Not
found", "unreadable" and "available" are three different inputs. Reviewed state,
trusted documents, active rules and the insurer inventory were already covered.

The 32-bit FNV checksum itself is unchanged (known debt, out of scope); the new digest
is cryptographic and feeds it as a string. `MATCHER_VERSION` is not bumped.

## 9. Hardening the engine against false positives

Property tests (1,000 randomised formatting mutations of one identifier; every
single-character change of an address; shuffles of source order; duplicate documents;
null vs absent; malformed values) and the 26 mutation probes in §16.

## 10. UI

### Evidence Mode (`RecommendationPanel`, under the quality panel)

* **What Atlas still needs**: state and counts; *What Atlas counts as required*; then
  *Across the whole recommendation*, *Required documents* (one row per logical document
  with its insurers and a "Why Atlas says this is required" disclosure listing every
  requiring rule), and *By insurer* (worst first; complete insurers named, not listed).
  Wording keeps the rule: "Nothing is blocked or declined by this."
* **Conflicts to review**: "Atlas found conflicting recorded values", each value group
  (masked / typed + reference), the sources and where they recorded it, whether the
  matcher uses the field, "Unresolved", and a *How Atlas compared them* disclosure.
  Never "false information", "fraud", "misrepresentation"; never which value is right.
  When nothing could be compared it says so rather than claiming consistency.
* Diagnostics (managers/admins, collapsed) gain the completeness and contradiction model
  versions. Ordinary users see no `cmp:` / `ctr:` / `gap:` identifiers.

### Historical behaviour

| Stored evidence | Both new panels say |
| --- | --- |
| v1 | "Completeness and contradiction analysis was not captured for this historical recommendation." |
| v2 | "This recommendation predates deterministic completeness and contradiction analysis." |
| NULL | the existing historical notice; no new panel |
| unsupported / malformed | the existing notices; no new panel |

## 11. Missing Information integration — one source of truth

The tab is still the one place a person acts. It now shows **What Atlas detected** from
the latest recommendation and *joins* it to the tracked items: documents match on the
matcher's canonical document key (so `Risk survey`, `risk-survey` and a derived
`RISK SURVEY` are one item; a frontend copy of the key is checked against the worker's
in a test), other items on type + a deterministic title. "Track this" creates an
**ordinary** item through the existing endpoint. A tracked item shows its own status; a
closed one reads as closed.

Only requests a broker can act on are trackable (documents, undeclared cover sections, a
schema-named fact). Internal limitations — a section no rule covers, rule ties, insurers
without data — are listed but never tracked, because tracked items are readable by the
broker and feed request drafts. Free-text facts are left to the existing *Derive from
analysis* flow, which already carries their text under existing access control.
Conflicts are pointed at, never listed or tracked here. The panel receives evidence only
for non-brokers.

## 12. Auditability

A v3 packet records: the model versions (`completeness.model`, `contradictions.model`,
`quality.model`), what Atlas saw (`comparisons[]`), which sources were compared, the
normaliser and its steps for every contradiction, why each item has its materiality
(code + table in §3.3; `severity_basis`), and the requirement authorities. Everything is
reproducible from the persisted inputs plus the versioned code; there is no clock, no
randomness and no network in either module.

## 13. Access control

Unchanged. `GET /recommendation` still requires `roleCanViewUnderwritingIntelligence`;
brokers are denied and the loader never fetches the recommendation for them. Completeness
and contradiction data live only in `evidence_json`, so they inherit that control. The
contradiction `value_display` is **less** sensitive than the existing evidence excerpts
(masked or typed; no raw text), so nothing is silently broadened. One pre-existing
observation, not changed here: `GET /missing-info` is guarded by submission access only
(a broker can read items on their own submission) — which is why internal limitations and
conflicts are never written to that table.

## 14. Deterministic acceptance benchmark

`npm run test:powerhouse-acceptance` (also in `npm test`). Cases 1–21 are untouched; their
expected files changed **additively only** (the `evidence_schema` value plus new
completeness / contradiction fields — a script compared them against `HEAD` and found 0
non-additive differences).

| # | Case | Level | What it pins |
| --- | --- | --- | --- |
| 22 | Complete single-section | pipeline | `complete`, no items, no comparison, quality unchanged |
| 23 | Explicit required fact missing | pipeline | schema path + label only on an exact match; free text never persisted; advisory gaps |
| 24 | Required document, rule provenance | pipeline | ONE canonical document across 3 spellings / 2 insurers / 3 rules; scopes and presence kept; material (Beta) vs nonblocking (Alpha) |
| 25 | One insurer complete, another incomplete | pipeline | `complete` / `incomplete_material` / `incomplete_nonblocking` side by side |
| 26 | Section with no applicable rule | pipeline | material for a viable insurer, nonblocking once ruled out |
| 27 | Several products, no declared sections | pipeline | case-level limitation + insurer items; nothing invented |
| 28 | Sources agree | pipeline | compared, no contradiction |
| 29 | Sources disagree | pipeline | one cluster, masked values, advisory, unresolved; **twin-run: identical authoritative output** |
| 30 | Boolean contradiction | **engine** | no second boolean source exists |
| 31 | Date contradiction | **engine** | no second date source exists; `01/05/2026` is refused, not guessed |
| 32 | Formatting normalises equal | pipeline | whitespace + case => `agree` (engine: `ABC 123` = `abc-123`) |
| 33 | Genuine identifier mismatch | pipeline | one-letter difference contradicts; no fuzzy tolerance |
| 34 | Matcher-consumed field | **engine** | material gap, linked both ways, state `caution`, never a blocker |
| 35 | Non-matcher field | pipeline | **twin-run**: score / rank / flags / confidence / documents identical; quality unchanged |
| 36 | Three sources, two agree | **engine** | one cluster; A A B B is one contradiction |
| 37 | Historical v2 | historical | no completeness / contradictions / links; v2 quality model; GET verbatim |
| 38 | Historical v1 | historical | same |
| 39 | NULL evidence | historical | stays NULL |
| 40 | Privacy sentinels | pipeline | no raw / normalised sentinel anywhere; masked displays only |

Cases 30, 31, 34 and 36 are **not** pipeline cases and are labelled as such: building
them through the endpoint would require inventing a second recorded source, which the
brief forbids. They are proven against an explicitly injected registry in
`tests/powerhouse/contradictions.test.ts`; no production registry entry is added for them.
Cases 28, 29, 32 and 33 are four distinct scenarios on the one real comparison.

## 15. Migration

**None created.** `evidence_json` carries both analyses; the existing
`atlas_missing_info_items` carries tracking. A persistent *reviewed / waived* decision on
a contradiction would need new relational state. If the business wants it, this is the
proposal for review — **not created or applied**:

* **Why JSON is insufficient:** `evidence_json` is immutable per recommendation row; a
  review decision is made later, by a person, about a contradiction that spans reruns.
* **Table:** `atlas_contradiction_reviews(id, submission_id → atlas_submissions on delete
  cascade, contradiction_id text, field_key text, value_digests text[], decision enum
  ('acknowledged','corrected','waived'), note text not null, decided_by uuid, decided_at,
  recommendation_id → atlas_recommendations on delete set null)`, unique
  `(submission_id, contradiction_id)` so a *changed* disagreement (different digests,
  different id) is a new, unreviewed one.
* **RLS:** select/insert for roles with `roleCanViewUnderwritingIntelligence` on submissions
  they can access; **no broker policy**; no update/delete (append-only history).
* **Retention / privacy:** digests and the free-text `note` only — no values; note length
  capped and excluded from logs; follows the submission's retention.
* **Shape:** one additive migration, one `POST /api/submissions/:id/contradictions/:cid/review`
  endpoint, and a read join in `handleGetRecommendation` for staff only.

## 16. Verification record

Filled from the final run (see the final report). Mutation probes are reproducible with
`npm run test:powerhouse-mutations` (26 probes, including the 14 named in the brief; a
surviving probe fails the command). Performance with `npm run benchmark:powerhouse-batch-b`.

### Performance (synthetic, Node, median of 5)

| Insurers × rules × sections | Matcher | v2 build | v3 build | Δ | Completeness | Contradictions | v2 → v3 packet |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10 × 8 × 3 | 25.8 ms | 1.8 ms | 5.8 ms | 4.0 ms | 0.6 ms | 0.5 ms | 138 → 205 KB |
| 50 × 12 × 5 | 181.6 ms | 12.7 ms | 14.0 ms | 1.3 ms | 1.9 ms | 0.3 ms | 896 → 991 KB |
| 200 × 12 × 8 | 820.6 ms | 54.7 ms | 73.4 ms | 18.6 ms | 8.7 ms | 0.5 ms | 4.27 → 4.54 MB |
| 400 × 16 × 8 | 2225.6 ms | 138.1 ms | 164.1 ms | 26.0 ms | 11.0 ms | 0.3 ms | 9.82 → 10.59 MB |

The new layers cost about 1% of the matcher and grow linearly with facts + sources +
relevant rules (documents are indexed by canonical key; sections by (insurer, section);
the per-insurer roll-up is a single indexed pass). **Production risk flagged, pre-existing
and not caused by this batch:** the matcher itself is the dominant CPU cost on very large
matrices, and the evidence packet is already ~10 MB at 400 insurers × 16 rules; v3 adds
~8%. Real matrices are far smaller; if they grow, the `rule_evidence` /
`considered_rules` duplication is the lever, not completeness.

## 17. Business and compliance decisions genuinely required

1. **Which facts are required?** Atlas defines none. If the business wants some
   (e.g. a registration or ID number for a given product), it needs an owned rule table
   (field, product scope, authority), not code inference.
2. **Names, addresses, occupations**: enabling contradictions needs an agreed
   normalisation (legal suffixes, trading-as, initials, address standardisation) and a
   tolerance policy. Until then they are not compared.
3. **Can a contradiction ever be a blocker?** It would need a counterfactual matcher run
   (does either value trigger a hard decline?) and a decision that this should change
   reliance wording. Not implemented; severity is `material | advisory` only.
4. **Review / waiver of a contradiction**: do you want a persistent record (§15)?
5. **Should an `incomplete_material` recommendation ever require sign-off?** Today it only
   informs, as with the Batch 2 quality gate.
6. **Whether to retain the broker-email comparison**: it is advisory and the intake value
   for broker submissions is the authenticated login email, so a mismatch with the
   document's address is common and often benign.
7. Still open from Batch 2: multi-section aggregation, the rule-tie policy, who may see
   rule source excerpts.

## 18. Known limitations

* One production contradiction (§2). The model does not retain per-document values, so
  most disagreements cannot be detected until it does.
* `status: "conflicting"` / `conflicts[]` written by the extraction model are not shown as
  contradictions: they are a model verdict, Atlas keeps neither value, and no review
  action can clear them (the review UI edits `value` only). The existing *Conflicting*
  confidence band still shows them.
* Completeness cannot say whether a reported fact changes the outcome (`not_determined`).
* Document consolidation is by the matcher's `documentKey`, which ignores case,
  separators and spacing but nothing else; the matcher's own per-insurer de-duplication is
  by lower-cased exact string (an existing behaviour, not changed), so `risk_survey` and
  `risk survey` in one insurer's rules are two matcher outcomes and one completeness item.
* A broker-tracked document can still be duplicated by the later *Derive from analysis*
  (its dedupe key includes the description); the Missing Information tab recognises both.
* The fingerprint remains a 32-bit checksum.
* Reviewed-fact page / quote provenance does not exist upstream (unchanged).
