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
| Fingerprint | Gains the completeness and contradiction model versions; no production intake-value input remains because the live registry has no comparison that consumes it (§8). |
| UI | Evidence Mode: *What Atlas still needs* and *Conflicts to review*. Missing Information tab: *What Atlas detected* (§10). |
| Access | Evidence remains staff-only. A new staff-only detected-item endpoint derives the narrow broker-readable workflow row server-side (§11, §13). |
| Migrations | **None.** `evidence_json` is untyped jsonb; the existing missing-information table is reused (§15). |
| Graph / pipeline | Unchanged: Graph off, document pipeline `legacy`. |

## 2. The central finding — read this first

The forensic baseline established that **Atlas stores one value per canonical field
per extraction.** Re-reviews overwrite `reviewed_json`; the hybrid merger's rejected
duplicate values are never persisted; shadow comparisons store counts only. The model's
own `status: "conflicting"` and `conflicts[]` carry prose, not two comparable values, and
no review action can clear them. So on today's data model:

* **Production contradiction classes currently registered: NONE.** The intake
  `atlas_submissions.broker_email` is the authenticated creator/login address, while
  `reviewed_json.broker.email` is the intermediary or administrator address extracted
  from documents. They are not the same semantic fact and are not compared.
* The engine, contract, normalisers, clustering, severity policy, quality linkage and UI
  remain generic and are fully tested against injected registries for boolean, date,
  number, identifier, closed-enum and matcher-consumed fields.
* Every other candidate was examined and left out for a stated reason (baseline §G):
  extracted-vs-reviewed is superseded by the explicit review mechanism; names and
  addresses have no established deterministic normaliser; `quote_terms` describe a
  different subject than `current_cover`; a "claims history available" boolean against
  a document on file would need an invented semantic mapping.

Atlas currently does not retain two independently comparable structured values for the
same semantic fact. **Contradiction engine is active and deterministic, but no production
source pair currently satisfies the independent-source semantic-equivalence contract.**
Future coverage requires legitimate upstream second-source retention, such as
per-document structured extraction or prior reviewed states, subject to privacy and
retention decisions.

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
text resolves exactly to a known extraction field (or a bare key unique in the schema).
Its identity and requirement reference then use that canonical path, duplicates collapse,
and the item disappears once the current reviewed field has a meaningful value. Unknown
prose remains a positional, non-trackable observation; it is never promoted into an
underwriting requirement. At most 50 records are persisted; the overflow is a count.

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
contradiction_id   ctr:<12 hex of SHA-256 over model + field + sorted source identities/pointers>
code               conflicting_recorded_values
field_key, field_path?, label, scope=submission
status / resolution_state   "unresolved"
severity           material | advisory
severity_basis     matcher_consumed_field | field_not_consumed_by_matcher
comparison_basis   { kind, normalization, normalization_steps[] }
affects_matcher_input, matcher_roles[]      (derived from the single FACT_FIELDS table)
value_groups[]     ≥ 2: { value_label: A|B|C|…, value_display, source_count, sources[] }
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
| email | `email_trim_lowercase` | text; NFC; remove U+200B/U+200C/U+200D/U+2060/U+FEFF; trim; remove trailing sentence punctuation; lower-case; one `@` between a local part and a dotted domain, no spaces / `<>` / commas / semicolons | display-name forms, lists, malformed |
| date | `date_iso_calendar` | text; trim; `YYYY-MM-DD`; a real calendar date, year ≥ 1000 | `01/05/2026` (ambiguous), datetimes, `2026-02-29` |
| number | `number_plain_decimal` | finite number or `[+-]digits[.digits]`; drop `+`, leading and trailing zeros; `-0` = `0`; compared as **text** | currency, thousands separators, exponents |

"1" and "I", "0" and "O" are never merged; there is no tolerance and no similarity
threshold (a one-letter difference in an email is a contradiction — case 33).

### 4.4 Value representation and privacy

Raw values are **transient**: normalised, sorted in memory, and discarded. Persisted:

* `value_label`: deterministic ordinal `A`, `B`, `C`, … assigned from that transient
  normalised-value ordering; the normalised value itself is not persisted to establish it;
* `value_display`: the typed canonical value for boolean / date / number; for an `enum`
  **only** when the registry declares a `closed_vocabulary` containing it (an "enum" that
  is really free text is withheld); for a personal identifier a **mask**
  (`a•••@•••.za`: first character of the local part and the TLD; identifiers keep the
  first character and last two).

No value digest is persisted, returned by `GET /recommendation`, displayed as a `ref`, or
logged. Engine-only fingerprint tests may compute a full SHA-256 over injected,
normalised observations, but that digest never enters a contradiction value group.

Not persisted anywhere: raw text, full addresses, domains, file names, snippets, URLs,
storage paths, tokens or contradiction value digests.

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

`handleRunRecommendation` keeps its existing active-insurer, reviewed-extraction,
trusted-document and rule reads. The broker-email intake query and its dedicated failure
path were removed because no valid production comparison consumes them. The production
observation set is empty and the registry is empty: Evidence v3 truthfully emits no
comparison attempt, no contradiction, no fabricated agreement and no empty-registry
warning. Engine tests inject observations and a registry directly into the pure engine.

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

New gap codes (recommendation-level, so they never alter score or rank):

| Code | Severity | When |
| --- | --- | --- |
| `extraction_reported_information_missing` | advisory | one per reported item |
| `conflicting_recorded_values` | material when the field is consumed by the matcher, else advisory — **never a blocker** | one per contradiction |
| `comparison_unavailable` | advisory | one per registered comparison that cannot run; links by `quality_gap_id`, carries `source_unavailable` or `unparseable_value`, and never implies disagreement |

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

New **required** inputs of `buildRecommendationFingerprint` are
`completenessModelVersion` and `contradictionModelVersion`; `evidenceSchemaVersion` and
`qualityModelVersion` carry the v3 values. The former production
`contradictionInputsDigest` input was removed with the invalid intake comparison. The
fingerprint still covers every semantic input capable of changing persisted v3 output:
matcher/taxonomy/evidence/quality/model versions, reviewed and extraction state, trusted
documents, active rules and the active insurer inventory. The pure engine retains a full
SHA-256 observation fingerprint for injected engine tests and future legitimate pairs;
it is not a production broker-email query/input and is never persisted or logged.

The 32-bit FNV checksum itself is unchanged (known debt, out of scope).
`MATCHER_VERSION` is not bumped.

## 9. Hardening the engine against false positives

Property tests (1,000 randomised formatting mutations of one identifier; every
single-character change of an address; shuffles of source order; duplicate documents;
null vs absent; malformed values) and the mutation probes in §16.

## 10. UI

### Evidence Mode (`RecommendationPanel`, under the quality panel)

* **What Atlas still needs**: state and counts; *What Atlas counts as required*; then
  *Across the whole recommendation*, *Required documents* (one row per logical document
  with its insurers and a "Why Atlas says this is required" disclosure listing every
  requiring rule), and *By insurer* (worst first; complete insurers named, not listed).
  Wording keeps the rule: "Nothing is blocked or declined by this."
* **Conflicts to review**: "Atlas found conflicting recorded values", each value group
  (masked / typed), the sources and where they recorded it, whether the
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
the latest recommendation and performs a lightweight display join to tracked items.
Detected documents use the matcher's canonical document key in the frontend. Other
frontend rows still use exact type + displayed title: a Derive raw fact key can therefore
look untracked until "Track this" is clicked; the server then returns `duplicate: true`
without inserting. The one exception is a title that several schema paths share (`Name`,
`Risk address`, `Required documents`): a tracked row carries only its title, so it cannot
prove which path it was tracked for, and the join never treats it as a match. Such a line
always reads as untracked, so a tracked or closed sibling can neither mark the other as
tracked nor remove its "Track this" button. The client only withholds the match; it
never maps a title to a path, and a parity test against the worker registry fails if a new
schema field starts sharing a label. The server, not this presentation join, is authoritative. "Track this"
sends only the
`detected_item_id` to `POST /api/submissions/:id/missing-info/detected`. The server loads
that submission's latest recommendation, requires Evidence v3, finds the item, applies a
narrow allow-list, and derives type/title/description/source/owner from safe contract
fields. Client-supplied content and extra properties are rejected. The existing generic
manual-add endpoint remains unchanged.

Only requests a broker can act on are trackable (documents, undeclared cover sections, a
schema-named fact). Internal limitations — a section no rule covers, rule ties, insurers
without data — are listed but never tracked, because tracked items are readable by the
broker and feed request drafts. Free-text facts are left to the existing *Derive from
analysis* flow, which already carries their text under existing access control.
Conflicts are pointed at, never listed or tracked here. The panel receives evidence only
for non-brokers. Track and *Derive from analysis* call one server-side logical matcher
before inserting. Structured facts normally use their exact canonical path. For the six
paths whose bare key/label is shared (`extracted_client.name`, `broker.name`, both
`risk_address` paths and both `required_documents` paths), the known candidate path
authorises only exact registry aliases that resolve uniquely back to that same path. A
full canonical path remains proof; a shared bare key or generated label does not. Atlas
never maps an ambiguous stored title globally to one path, even when only one peer is in
the current recommendation. Full-path Derive rows can therefore interoperate, while bare
or label-only ambiguous Derive rows can remain separate rather than be guessed.

Rule-sourced `document` rows are canonical required-document requirements and use
`documentKey(title)`. The same document required by several rules or sections is one
broker requirement because it is supplied once. Production-era structured Derive rows
written with `source=quote_review` remain compatible only when their former exact
section/type/title/description tuple matches a current structured rule requirement; source
is deliberately not part of that legacy tuple. Track uses the current structured review
requirement to prove this bridge. A merely similar finding or manual row is not consumed.
Quote-review findings, manual documents and other non-canonical rows otherwise keep the
exact tuple, so two findings with the same section title are not silently merged.

Track also has provenance stronger than human-facing text. Completeness item IDs are
deterministic from canonical fact paths or document keys. After validating the current
latest v3 item, Track queries recommendation **IDs only**, scoped to the same submission,
newest first and bounded to the next 100 historical recommendations. The current/latest
recommendation is excluded from that query and its deterministic ID is checked separately.
No historical `evidence_json` is loaded. Track recomputes the deterministic IDs for the
stable item and reuses an existing matching row. The submission predicate is applied
before the limit; recommendations from another submission cannot crowd the origin out of
the window.

Derive applies the same ID-only, same-submission, newest-first proof when a structured
candidate yields a stable completeness item ID and relevant existing rows make provenance
necessary. Unlike Track, Derive includes the current/latest recommendation in its 100-row
window, so its historical reach is one recommendation shorter: origin 99 back is included;
origin 100 back is not. With no existing rows, Derive skips this support query. A failed
provenance lookup fails closed in both entry points, and a failed quote-review or section
lookup for Track's legacy-document bridge also fails closed; none of these failures may
fall through to an insert. This keeps each member of an ambiguous pair attached to its own
earlier Track row without title inference.

The bound primarily affects the six ambiguous structured paths whose human title cannot
prove identity. Beyond the provenance window they may create a safe duplicate. Canonical
documents and unambiguous structured facts continue to deduplicate through normal logical
identity beyond the cap. The design does not promise unlimited historical deduplication.
Every real status
(`open`, `requested`, `received`, `waived`, `not_required`) counts as already tracked and
is returned unchanged. Equivalent legacy rows are selected deterministically by oldest
`created_at`, then lowest `id`; a failed lookup fails closed and performs no insert.
Track's deterministic UUID, scoped to submission + current recommendation + detected
item, remains the concurrent same-recommendation insert backstop. No migration is needed.

## 12. Auditability

A v3 packet records: the model versions (`completeness.model`, `contradictions.model`,
`quality.model`), what Atlas saw (`comparisons[]`), which sources were compared, the
normaliser and its steps for every contradiction, why each item has its materiality
(code + table in §3.3; `severity_basis`), and the requirement authorities. Everything is
reproducible from the persisted inputs plus the versioned code; there is no clock, no
randomness and no network in either module.

## 13. Access control

`GET /recommendation` still requires `roleCanViewUnderwritingIntelligence`;
brokers are denied and the loader never fetches the recommendation for them. Completeness
and contradiction data live only in `evidence_json`, so they inherit that control. The
contradiction `value_display` is **less** sensitive than the existing evidence excerpts
(masked or typed; no raw text), so nothing is silently broadened. One pre-existing
observation, not changed here: `GET /missing-info` is guarded by submission access only
(a broker can read items on their own submission) — which is why internal limitations and
conflicts are never written to that table. The detected-item POST has both router and
handler role guards; broker requests are rejected before recommendation evidence is read.

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
| 28 | Empty production registry | endpoint | no comparison attempt, contradiction or fabricated agreement |
| 29 | Empty production registry | endpoint | no invalid broker-email conflict; authoritative output unchanged |
| 30 | Boolean contradiction | **engine** | no second boolean source exists |
| 31 | Date contradiction | **engine** | no second date source exists; `01/05/2026` is refused, not guessed |
| 32 | Empty production registry | endpoint | production does not compare the two broker-email meanings; injected engine proves identifier formatting equality |
| 33 | Empty production registry | endpoint | production does not compare the two broker-email meanings; injected engine proves genuine mismatch |
| 34 | Matcher-consumed field | **engine** | material gap, linked both ways, state `caution`, never a blocker |
| 35 | Empty production registry | endpoint | no comparison is fabricated; injected engine proves advisory non-matcher behaviour and unchanged authority fields |
| 36 | Three sources, two agree | **engine** | one cluster; A A B B is one contradiction |
| 37 | Historical v2 | historical | no completeness / contradictions / links; v2 quality model; GET verbatim |
| 38 | Historical v1 | historical | same |
| 39 | NULL evidence | historical | stays NULL |
| 40 | Privacy sentinels | endpoint + injected engine | no raw/normalised value, login/intermediary email or value digest in persisted rows/evidence/audit/job writes |

Cases 28, 29, 32, 33, 35 and 40 retain real endpoint coverage for the empty production
architecture. Their comparison behaviours are additionally proved with a real engine
fixture and explicitly injected registry. Cases 30, 31, 34 and 36 are also engine-level.
Cases 37–39 are historical compatibility. No case fabricates a production second source.

## 15. Migration

**None created.** `evidence_json` carries both analyses; the existing
`atlas_missing_info_items` carries tracking. Its existing fields are interpreted through
the shared document/schema/exact identity matcher for cross-entry-point and cross-
recommendation joins, while Track's UUID primary key provides its same-recommendation
concurrency boundary. Persistent contradiction review/waiver/resolution is a future
workflow and governance decision; no table, migration or endpoint for it was created in
this remediation.

## 16. Verification record

Run on the final head (nothing pushed, migrated or deployed).

| Check | Result |
| --- | --- |
| Backend, every script in `npm test` | complete chain exit 0, 0 failures |
| `npm run test:powerhouse-acceptance` (cases, UI-snapshot drift, v1 golden, matcher v2, quality gate, evidence v2, digest, contradictions, completeness, detected tracking, missing-info interoperability, persistence, remediation, differential, Phase 1A differential) | pass; acceptance 37/37, snapshots 37/37, contradictions 31/31, completeness 30/30, tracking 22/22, interoperability 26/26, persistence 36/36 |
| Matcher differential vs the frozen production v1 matcher (3,000 fixtures per corpus) | **0 unexpected authoritative differences**; 0 category violations; 0 order-invariance failures |
| Phase 1A 500-fixture differential | unchanged pinned hash `b14d9927…a36` |
| Phase 1A evidence (32) / handler (3) / Phase 24 clean-only trust (47) | pass |
| Evidence-v2 immutability corpus | pass; shared v2 semantics unchanged |
| Mutation probes (`npm run test:powerhouse-mutations`) | **79/79 killed**, including provenance submission scope before the limit, Track/Derive provenance failure, legacy-bridge support-query failure, multi-prior search, Derive-only source projection, completeness/Track item-ID formulas and recommendation-scoped deterministic UUIDs, plus all prior guards |
| Frontend vitest | 894 tests in 40 files, 0 failures (was 783) |
| Frontend `tsc -b` + production build | pass |
| Worker `tsc --noEmit` | pass |
| `wrangler deploy --dry-run --env production` (local bundle; nothing uploaded) | pass; bindings unchanged, pipeline `legacy`, no Graph variables |
| `git diff --check` | clean |

Reproduce the probes with `npm run test:powerhouse-mutations` (a surviving probe fails the
command) and the cost table with `npm run benchmark:powerhouse-batch-b`.

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
6. **Which legitimate second sources may be retained:** per-document structured values
   or prior reviewed states require an explicit purpose, access and retention decision
   before any production registry entry is enabled.
7. Still open from Batch 2: multi-section aggregation, the rule-tie policy, who may see
   rule source excerpts.
8. **Recommendation freshness at tracking time:** the endpoint validates against the
   latest persisted recommendation. Whether it must also prove that recommendation is
   newer than the latest review/extraction/document change is a separate workflow policy;
   no freshness contract is added in this remediation.

## 18. Known limitations

* Zero production comparison pairs (§2). The model does not retain two independent,
  semantically equivalent values, so production contradictions cannot be detected until
  a legitimate second source is retained.
* `status: "conflicting"` / `conflicts[]` written by the extraction model are not shown as
  contradictions: they are a model verdict, Atlas keeps neither value, and no review
  action can clear them (the review UI edits `value` only). The existing *Conflicting*
  confidence band still shows them.
* Completeness cannot say whether a reported fact changes the outcome (`not_determined`).
* Document consolidation is by the matcher's `documentKey`, which ignores case,
  separators and spacing but nothing else; the matcher's own per-insurer de-duplication is
  by lower-cased exact string (an existing behaviour, not changed), so `risk_survey` and
  `risk survey` in one insurer's rules are two matcher outcomes and one completeness item.
* The fingerprint remains a 32-bit checksum.
* Reviewed-fact page / quote provenance does not exist upstream (unchanged).
* Existing duplicate missing-information rows are not merged or deleted. When they exist,
  Track returns the oldest row, breaking equal timestamps by the lowest id.
* The six ambiguous fact paths cannot be recovered from an old row containing only a
  shared label or bare key. Shared text is never proof, even if only one path is present
  now. Full canonical paths and deterministic Atlas Track IDs solve provable directions
  without inventing a global mapping.
* A missing-information row stores a document title, not a separate canonical document
  identity. Two genuinely different document requirements with the same persisted
  canonical title therefore cannot be distinguished without a schema change.
* One canonical required document spanning several sections is stored once. The current
  row can retain only its first section association; retaining every section/rule
  association would require a schema change. Legacy Derive document rows whose old
  metadata does not prove whether they were rule-required or finding-derived remain
  conservative exact-tuple rows.
* The frontend tracked-state join is intentionally narrower than the server matcher for
  facts, and broader for displayed document titles. It may temporarily display a
  Derive-created raw fact as untracked (or a same-title generic document as tracked), but
  the server remains authoritative and will not perform an unproven merge; an irreducibly
  ambiguous legacy row may remain separate.
* The table has no persisted canonical logical key or uniqueness constraint. Two truly
  concurrent *Derive from analysis* requests can therefore both pass the read-before-
  insert check; eliminating that theoretical race requires a migration. Track retains its
  deterministic-ID backstop for concurrent repeats of the same detected item.
* Historical provenance is intentionally bounded. Track searches the next 100 prior
  same-submission recommendation IDs; Derive's 100 IDs include latest/current. Ambiguous
  Track rows outside the applicable window can remain separate rather than trigger an
  unbounded evidence scan. Equal `created_at` values have no additional recommendation-ID
  tie-breaker (Low); the cap remains the accepted bounded design.
* Track's legacy document bridge depends on the current quote review still containing the
  matching structured document and section. If it no longer does, a safe duplicate is
  acceptable. The exact legacy tuple deliberately excludes `source`.
* Derive's read-before-insert scan remains quadratic in the number of candidates (Low).
* A deliberately repeated request after `waived` or `not_required` still reuses the
  existing row. A reopen/new-request policy is a separate workflow decision.
