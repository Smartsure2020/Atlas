# Atlas Hybrid Document Pipeline

Redirects Atlas away from always-Sonnet toward a routed pipeline that keeps
large-model processing as the *exception*, not the default. The legacy path
remains authoritative until `ATLAS_DOCUMENT_PIPELINE_MODE` is flipped.

## Architecture (what actually runs)

```
Upload
  → document validation and hashing                 (existing)
  → LocalPdfParser (unpdf / pdf.js)                 (parser-local-pdf.ts)
  → deterministic quality classification            (parser-local-pdf.ts)
  → AzureDocumentIntelligenceParser when needed     (parser-azure.ts)
  → Haiku 4.5 normalisation on TEXT (not raw PDF)   (hybrid-llm.ts)
  → existing extraction-schema validation           (extraction.ts)
  → deterministic escalation signals                (pipeline-router.ts)
  → bounded Sonnet resolution for uncertain fields  (hybrid-llm.ts)
  → canonical Atlas extraction persistence          (existing schema)
  → existing deterministic matcher                  (matcher.ts)
```

## Mode behaviour (as tested in phase12-shadow-nonblocking.test.ts)

### legacy (default in `wrangler.toml`)

- Only `runLegacyExtraction` runs. Behaviour and API response are byte-for-byte the same as before this work.
- Prompt caching (`cache_control` on the extraction system prompt) reduces cost without changing behaviour.
- Telemetry rows are emitted with `pipeline_mode = "legacy"`.

### shadow

- **Authoritative:** `runLegacyExtraction`. The user response is identical to legacy mode.
- Each job's deterministic input fingerprint is hashed (FNV-1a) into `[0, 99]` and compared against `ATLAS_SHADOW_SAMPLE_PERCENT`. Same fingerprint → same decision → **retries never run a second shadow.**
- **Queue-backed (Phase 13):** when sampled, the HTTP handler awaits only a small `ATLAS_SHADOW_QUEUE.send(msg)` call and returns the legacy response. All document processing (PDF parse, Azure poll up to 60 s, Haiku normalisation, optional Sonnet resolution) runs in the Cloudflare Queue **consumer** (`export default { queue(...) }`). HTTP `ctx.waitUntil()` is no longer used for shadow document work — it is capped at ~30 s and would cancel Azure polling mid-run.
- The consumer runs the hybrid orchestrator with `legacyFallbackAllowed: false` — **hybrid failures inside a shadow can NEVER re-invoke the full Sonnet extraction.** A shadow failure records a `finalStatus: "shadow"` metric with `fallbackReason` and acknowledges (or retries transient errors).
- Duplicate delivery is safe: `atlas_pipeline_shadow_comparisons` has a unique index on `(input_fingerprint, pipeline_version)`; `atlas_shadow_reservations` prevents *concurrent* duplicate provider calls; and duplicate deliveries after completion no-op.
- Timing instrumentation is recorded in `atlas_pipeline_shadow_comparisons.metadata` and the pipeline metric:
  - `shadow_queue_delay_ms` — time between the response leaving and the consumer starting.
  - `shadow_processing_ms` — pure consumer processing duration.
  - Legacy duration lives in `legacy_total_ms` on the same row.
- **If the Queue binding is missing** or `send()` throws, shadow is **SKIPPED** — Atlas never falls back to `ctx.waitUntil` for document processing. A privacy-safe `shadow_enqueue_skipped` / `shadow_enqueue_failed` metric records the reason.

#### Queue message schema (identifiers only)

```ts
interface ShadowQueueMessage {
  v: 1;
  submissionId: string;         // uuid
  legacyExtractionId: string;   // uuid — authoritative row
  legacyJobId: string;          // uuid
  inputFingerprint: string;     // <=128 chars
  pipelineVersion: string;      // <=40 chars
  organisationId?: string | null;
  enqueuedAt: number;           // ms epoch
  legacyTotals: { totalMs: number; inputTokens: number; outputTokens: number };
}
```

The producer validates this shape BEFORE `send()` and the consumer validates AFTER `receive()` (`validateShadowMessage`). Any unexpected key — PDF bytes, extracted text, client details, addresses — causes the consumer to record a permanent failure and ack, without invoking any provider.

#### Retry and dead-letter policy

Wrangler consumer config: `max_batch_size = 5`, `max_batch_timeout = 5`, `max_retries = 4`, `dead_letter_queue = "atlas-shadow-pipeline-dlq"`.

Failures are classified in `shadow-queue.ts` via `classifyFailure`:

| Class | Examples | Behaviour |
| --- | --- | --- |
| Transient | `azure_rate_limited`, `azure_server_error`, `azure_network_failure`, `anthropic_rate_limited`, `anthropic_server_error`, `haiku_call_failed`, `storage_unavailable`, `database_transient` | `msg.retry()` — the queue redelivers with backoff up to `max_retries`. If still failing, the message lands in the DLQ. |
| Permanent | `document_missing`, `invalid_identifiers`, `cross_tenant_mismatch`, `encrypted`, `unsupported`, `azure_auth_failed`, `schema_incompatible`, `invalid_configuration` | Records `shadow_failure_class: "permanent"` metric, sets reservation to `failed_permanent`, and `msg.ack()`s — no retry storm. |

#### Idempotency

The consumer is idempotent on `(input_fingerprint, pipeline_version)`. Two layers cooperate:

1. **`atlas_shadow_reservations`** (migration 0021) has a UNIQUE index on the pair. On receipt, the consumer inserts a `processing` row; a concurrent duplicate delivery collides with `23505` and short-circuits to `already_processing`. When done the row flips to `completed` (or `failed_permanent`). Transient failures reset to `queued` so retry can re-reserve. Stale `processing` rows older than 15 minutes are taken over.
2. **`atlas_pipeline_shadow_comparisons`** has a UNIQUE index on the same pair. Inserts use `onConflict: "input_fingerprint,pipeline_version", ignoreDuplicates: true`.

A pipeline-version bump creates a fresh reservation key, so the same fingerprint can be re-shadowed under a newer pipeline version.

#### How to inspect shadow queue state

- `atlas_shadow_reservations` (manager+): current status per fingerprint/version. `select status, count(*) group by status`.
- `atlas_pipeline_metrics` (manager+): filter by `pipeline_mode = 'shadow'`; `fallback_reason` starting with `permanent:` / `transient:` categorises consumer failures.
- Cloudflare Dashboard → Workers & Pages → Queues → `atlas-shadow-pipeline*` shows backlog + DLQ depth. `wrangler queues consumer status atlas-shadow-pipeline` from the CLI.
- Dead-letter queue: `wrangler queues consumer list atlas-shadow-pipeline-dlq` (attach a temporary consumer to inspect failed messages).

### hybrid

- **Authoritative:** `runHybridExtraction`. The response shape is unchanged from legacy: `{ ok, extraction_id, overall_confidence }` (plus `fallback: "legacy_emergency"` when applicable).
- Sequence:
  1. Download all active PDFs.
  2. `LocalPdfParser` (unpdf/pdf.js) on each; deterministic quality classification.
  3. Whole-batch route decision (worst quality wins).
  4. If `ocr_required` / `layout_required` and Azure is configured → `AzureDocumentIntelligenceParser`.
  5. Assemble a page-delimited **text** corpus (broker email + per-document pages + tables).
  6. `runHaikuNormalisation` — Haiku 4.5 with the existing Atlas extraction system prompt, `cache_control: ephemeral` on the stable prefix.
  7. `validateAndNormalizeExtraction` (existing).
  8. `detectEscalationSignals` — deterministic (missing critical fields, low provider confidence, invalid dates, unknown taxonomy, schema validation errors).
  9. If escalation required (max 1 attempt): `runSonnetBoundedResolution` receives ONLY the affected field names + evidence pages. Only the requested keys can be merged.
  10. Re-validate; persist as canonical Atlas extraction with `pipeline_route`, `escalated_fields`, `fallback_model` recorded on `version_metadata`.
- **Emergency legacy fallback** is invoked only when the orchestrator returns `suggestLegacyFallback: true` AND `ATLAS_LEGACY_FALLBACK_DISABLED != "true"`. Triggers: `download_failed` on all docs, `orchestrator_exception`, `haiku_call_failed`, `azure_not_configured_ocr_required`. Every fallback creates an `atlas_operational_alerts` row (severity `warning`) with `alert_type = "hybrid_pipeline_legacy_fallback"`.
- **How to confirm a PDF used the local route rather than Azure:** the row's `version_metadata.pipeline_route` = `text_fast_path` and `atlas_pipeline_metrics.provider` is `NULL`. If Azure was used, `provider` = `azure` and route = `ocr_required` / `layout_required`.

## Local PDF parser (issue 3 fully resolved)

**Canonical extractor: `unpdf` (pdf.js under the hood), pinned in `package.json` as a real dependency.** Verified compatibility with the Cloudflare Workers runtime:

- Bundle: 3.5 MB uncompressed / **784 KB gzipped** (well below the paid-plan 10 MB limit; comfortable on free plan too).
- Runtime: works with `@cloudflare/workers-types`; unpdf ships a DOMMatrix polyfill and does not require Node globals.
- `wrangler deploy --dry-run --env production` succeeds.

**Controlled fallback:** a minimal built-in BT/ET literal extractor is retained ONLY for the case where unpdf throws. When unpdf and the fallback both fail, the classifier reports `corrupt`, not `scanned` — the router escalates via the documented fallback policy.

**Proven by fixtures (phase12-pdf-fixtures.test.ts):** compressed single-page and multi-page text PDFs are extracted with real content, encrypted PDFs short-circuit, scanned/mixed/malformed PDFs route correctly, and non-PDF bytes are rejected before any parse.

## Azure lifecycle (issue 6 fully resolved)

`parser-azure.ts` implements the real async lifecycle:

- POST `:analyze` → 202 with `Operation-Location` (or 200 for immediate success).
- Poll the operation URL with a bounded interval (`pollIntervalMs`, default 1500ms) and an overall `timeoutMs` (default 60s).
- Cancellation predicate consulted between polls.
- Explicit handling for 200-immediate-success, missing `Operation-Location`, failed, canceled, 401/403 (auth), 429 (rate limit), 5xx, malformed JSON, network failures during both submit and poll.
- Provider errors redacted via `redactAzureError` (short code + status only).

Exercised by 16 mocked-fetch tests in phase12-azure-lifecycle.test.ts.

## Files added this session

| File | Purpose |
| --- | --- |
| `worker/src/pipeline-version.ts` | `PIPELINE_VERSION` constant, extracted so tests can import it without pulling the whole orchestrator graph. |
| `supabase/migrations/0020_pipeline_shadow_versioning.sql` | Adds `pipeline_version` + version metadata columns; replaces the fingerprint-only unique index with `(input_fingerprint, pipeline_version)`. |
| `tests/phase12-shadow-nonblocking.test.ts` | 7 tests: fire-and-forget contract, version-aware idempotency, sampler safety, comparison shape. |
| `tests/phase12-azure-lifecycle.test.ts` | 16 tests: full async lifecycle + every documented failure mode. |
| `tests/phase12-pdf-fixtures.test.ts` | 8 tests: real generated PDF fixtures across every documented shape. |
| `tests/phase13-shadow-queue.test.ts` (new, Phase 13) | 16 tests covering the queue producer + consumer contracts (see list above) — no PII in messages, idempotency (single + concurrent), transient/permanent classification, authoritative-state isolation, timing separation, and version-bump reprocessing. |

## Files modified this session

| File | Change |
| --- | --- |
| `worker/src/index.ts` | Threads `ExecutionContext` from `fetch` through `route` into `handleExtract`. |
| `worker/src/extract-endpoint.ts` | `handleExtract` accepts `ExtractExecutionContext` (still threaded for the hybrid path). `runLegacyAuthoritativeWithHybridShadow` returns the response synchronously and — when sampled — awaits a single small `ATLAS_SHADOW_QUEUE.send(msg)` op (Phase 13). Enqueue failures NEVER alter the authoritative response; missing binding SKIPS shadow (no `waitUntil` fallback). |
| `worker/src/shadow-queue.ts` (new, Phase 13) | Message schema (identifier-only), pre-send + post-receive validation, `enqueueShadowMessage` producer, `handleShadowQueueBatch` consumer, reservation-based idempotency, transient/permanent failure classifier. |
| `worker/src/index.ts` | Adds `queue()` entry to the default export wired to `handleShadowQueueBatch`. |
| `worker/wrangler.toml` | Adds `[[queues.producers]]` + `[[queues.consumers]]` with DLQ for both top-level and `env.production`. Production defaults keep `ATLAS_DOCUMENT_PIPELINE_MODE = "legacy"` and `ATLAS_SHADOW_SAMPLE_PERCENT = "0"`. |
| `supabase/migrations/0021_shadow_reservations.sql` (new, Phase 13) | Reservation ledger with UNIQUE `(input_fingerprint, pipeline_version)`; states `queued`/`processing`/`completed`/`failed_permanent`; manager-only RLS. |
| `worker/src/parser-local-pdf.ts` | Uses `unpdf` as a normal top-level import (was runtime-computed dynamic import). Built-in extractor is now the controlled fallback, only invoked when unpdf throws. |
| `worker/src/parser-azure.ts` | Explicit handling for immediate 200, 401/403, 429, 5xx, malformed body, network failure. New `pollIntervalMs` and `isCancelled` config for testability + cancellation. |
| `worker/src/hybrid-shadow.ts` | Persistence requires `pipelineVersion` + records `parserVersion`, `normalisationModel`, `azureModel`, `shadowQueueDelayMs`. Uses `(input_fingerprint, pipeline_version)` conflict key. |
| `worker/src/hybrid-orchestrator.ts` | Re-exports `PIPELINE_VERSION` from `pipeline-version.ts`. |
| `worker/package.json` | Adds `unpdf` as a real dependency. |
| `package.json` | Adds `unpdf` as a dependency + `@types/node` as devDependency; wires 3 new test scripts. |
| `tsconfig.test.json` | Adds `"types": ["node"]` for `Buffer`/`zlib` in the PDF fixture builder. |
| `scripts/benchmark-pipeline.ts` | Implements `--live-anthropic --confirm-paid` (real Haiku call, no fixture content ever leaked). `--live-azure` now fails loudly rather than silently no-oping. |
| Various `tests/*.ts` | Removed redundant `declare const process` lines (now provided by @types/node). |

## Environment / feature flags

Unchanged from the previous session, but restated so this is the single source of truth.

| Var | Default | Meaning |
| --- | --- | --- |
| `ATLAS_DOCUMENT_PIPELINE_MODE` | `legacy` | `legacy` \| `shadow` \| `hybrid`. |
| `ATLAS_DOCUMENT_PROVIDER` | `azure` | Managed OCR provider selector. |
| `ATLAS_SHADOW_SAMPLE_PERCENT` | `0` | 0–100. Deterministic by fingerprint. |
| `ATLAS_LEGACY_FALLBACK_DISABLED` | `false` | `true` disables emergency fallback in hybrid mode. |
| `ATLAS_HYBRID_MAX_TEXT_FASTPATH_PAGES` | `40` | Fast-path page cap. |
| `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` | *(secret)* | e.g. `https://<res>.cognitiveservices.azure.com`. |
| `AZURE_DOCUMENT_INTELLIGENCE_KEY` | *(secret)* | Subscription key. |
| `AZURE_DOCUMENT_INTELLIGENCE_MODEL` | `prebuilt-layout` | Or `prebuilt-read` / custom model id. |
| `AZURE_DOCUMENT_INTELLIGENCE_API_VERSION` | `2024-11-30` | GA API version. |
| `ATLAS_SHADOW_QUEUE` | *(binding, not a var)* | Cloudflare Queue producer binding for the shadow pipeline. See "Queue provisioning". |

## Benchmark harness

```bash
# Default: fixture-only, mock-labelled timings.
npm run benchmark:pipeline

# Real Haiku (paid): explicit two-flag opt-in.
ANTHROPIC_API_KEY=... npm run benchmark:pipeline -- --live-anthropic --confirm-paid

# Live Azure: not wired inside the harness — use shadow mode against synthetic
# fixtures to get real Azure numbers with the full orchestrator on the path.
```

`--live-anthropic` without `--confirm-paid` refuses. Missing API key refuses. `--live-azure` fails loudly with a message pointing to shadow mode. Nothing is ever written to disk by default.

## How to inspect metrics

- `atlas_pipeline_metrics` (RLS: manager+) — per-job route, timings, tokens, escalation flag.
- `atlas_pipeline_shadow_comparisons` (RLS: manager+) — per-(fingerprint, pipeline_version) legacy vs hybrid counts.
- `atlas_operational_alerts` where `alert_type = 'hybrid_pipeline_legacy_fallback'` — fallback frequency.

## Rollout readiness (verified)

| Target | Ready? |
| --- | --- |
| Legacy production | ✅ Behaviour unchanged. Telemetry + caching are additive. Production stays on `ATLAS_DOCUMENT_PIPELINE_MODE = "legacy"` with `ATLAS_SHADOW_SAMPLE_PERCENT = "0"`. |
| **Shadow pilot** | ✅ Shadow document processing runs in the Cloudflare Queue consumer (not `waitUntil`), cannot invoke legacy twice, is idempotent per `(input_fingerprint, pipeline_version)`, prevents concurrent duplicate provider calls via `atlas_shadow_reservations`, and classifies transient vs permanent failures. Enable by (1) creating the queue and DLQ (below), (2) `wrangler deploy` so the binding is live, (3) setting `ATLAS_SHADOW_SAMPLE_PERCENT` to a small value. |
| Hybrid production | 🟡 Requires shadow-pilot evidence: (a) critical-field match rate ≥ agreed threshold, (b) escalation rate acceptable, (c) legacy fallback rare, (d) human reviewer sign-off on a batch of hybrid extractions. |

## Queue provisioning (run once per environment)

Cloudflare resources are NOT created by `wrangler deploy` — provision them first:

```bash
# Development / preview
wrangler queues create atlas-shadow-pipeline
wrangler queues create atlas-shadow-pipeline-dlq

# Production
wrangler queues create atlas-shadow-pipeline-production
wrangler queues create atlas-shadow-pipeline-production-dlq
```

Then deploy the Worker (which now includes the `[[queues.producers]]` and `[[queues.consumers]]` bindings):

```bash
wrangler deploy                    # development / top-level env
wrangler deploy --env production   # production
```

Verify the binding is live:

```bash
wrangler queues list
wrangler queues consumer list atlas-shadow-pipeline
```

## Rollback

- **Fast rollback (keep queue infra):** set `ATLAS_SHADOW_SAMPLE_PERCENT = "0"` and redeploy. No new messages are enqueued; in-flight consumer work drains normally. Legacy remains authoritative throughout.
- **Full rollback:** set `ATLAS_DOCUMENT_PIPELINE_MODE = "legacy"` (already the production default) and redeploy. Historical data in `atlas_pipeline_metrics`, `atlas_pipeline_shadow_comparisons`, and `atlas_shadow_reservations` is preserved for post-mortem analysis.
- **Retire the queue** (only if the shadow programme is being abandoned): pause the consumer (`wrangler queues consumer pause atlas-shadow-pipeline`), drain the DLQ, then `wrangler queues delete ...`. Do this only after the sample percent is zero and the Worker has been redeployed without the binding.

## Remaining external steps

- **Azure resource creation** — Document Intelligence resource + endpoint/key.
- **Real fixtures** — anonymised representative fixtures if you want to expand the benchmark corpus beyond synthetic shapes.
- **(Optional) per-insurer custom Azure models** — set `AZURE_DOCUMENT_INTELLIGENCE_MODEL` accordingly.
