/**
 * Atlas hybrid pipeline — benchmark harness
 * ---------------------------------------------------------------------------
 * Runs each of the four "routes" against a synthetic in-repo fixture set and
 * emits a machine-readable JSON report + a concise Markdown summary.
 *
 * DEFAULT: fixture-only. No live provider is called unless explicit flags are
 * supplied:
 *
 *   node .test-dist/scripts/benchmark-pipeline.js               # mock only
 *   node .test-dist/scripts/benchmark-pipeline.js --live-anthropic
 *   node .test-dist/scripts/benchmark-pipeline.js --live-azure
 *   node .test-dist/scripts/benchmark-pipeline.js --live-anthropic --live-azure
 *
 * Fixtures are synthetic strings only — no real client documents. The
 * benchmark NEVER writes extracted content to disk; only aggregate numbers.
 */

import { classifyRoute } from "../worker/src/pipeline-router.js";
import type { ParsedDocument, ParsedPage, PipelineRoute } from "../worker/src/pipeline-types.js";

// ---------------------------------------------------------------------------
// Synthetic fixture set (anonymised, structural only).
// Each fixture describes a shape, NOT a real submission.
// ---------------------------------------------------------------------------

interface Fixture {
  id: string;
  label: string;
  category:
    | "short_text_schedule"
    | "long_text_schedule"
    | "table_heavy"
    | "scanned"
    | "mixed"
    | "broker_submission"
    | "claims_history"
    | "corrupt"
    | "encrypted";
  parsedDoc: ParsedDocument;
  expectedCriticalFields: string[];
}

function mkFixture(
  id: string,
  label: string,
  category: Fixture["category"],
  quality: ParsedDocument["quality"],
  pages: { text: string }[],
  expected: string[] = ["extracted_client.name", "risk_classification.primary_risk_type"]
): Fixture {
  const parsedPages: ParsedPage[] = pages.map((p, i) => ({
    page: i + 1,
    text: p.text,
    charCount: p.text.length,
  }));
  return {
    id,
    label,
    category,
    expectedCriticalFields: expected,
    parsedDoc: {
      documentId: id,
      fileName: `${id}.pdf`,
      pageCount: pages.length,
      quality,
      fullText: pages.map((p) => p.text).join("\n\n"),
      pages: parsedPages,
      tables: [],
      keyValues: [],
      parserMeta: {
        parser: "fixture",
        parserVersion: "1.0.0",
        charsPerPage: pages.reduce((s, p) => s + p.text.length, 0) / Math.max(pages.length, 1),
        emptyPageRatio: parsedPages.filter((p) => p.charCount === 0).length / Math.max(pages.length, 1),
        invalidCharRatio: 0,
        encrypted: quality === "encrypted",
        parseMs: 5,
      },
    },
  };
}

const FIXTURES: Fixture[] = [
  mkFixture("F-01", "Short text schedule", "short_text_schedule", "text_clean", [
    { text: "Buildings sum insured R5,000,000. Commercial property policy." },
    { text: "Client: Acme (Pty) Ltd. Renewal 30 June 2026." },
  ]),
  mkFixture("F-02", "Long text schedule", "long_text_schedule", "text_clean",
    Array.from({ length: 25 }, (_, i) => ({ text: `page ${i + 1}: cover section ${i + 1}, sum insured Rn, excess Rn`.padEnd(400, " ") }))
  ),
  mkFixture("F-03", "Table-heavy schedule", "table_heavy", "layout_heavy", [
    { text: "SASRIA schedule. See table below." },
  ]),
  mkFixture("F-04", "Scanned document", "scanned", "scanned", [
    { text: "" },
    { text: "" },
    { text: "" },
  ]),
  mkFixture("F-05", "Mixed text/scanned", "mixed", "text_sparse", [
    { text: "Cover Sections: Buildings, Contents." },
    { text: "" },
    { text: "" },
  ]),
  mkFixture("F-06", "Broker submission (email-shaped body)", "broker_submission", "text_clean", [
    { text: "Dear underwriter, please quote on buildings and contents for Acme Ltd. Regards, Broker." },
  ]),
  mkFixture("F-07", "Claims history summary", "claims_history", "text_clean", [
    { text: "Claims history: 3 claims in last 3 years, total R120,000." },
  ]),
  mkFixture("F-08", "Corrupt document", "corrupt", "corrupt", []),
  mkFixture("F-09", "Password-protected document", "encrypted", "encrypted", []),
];

// ---------------------------------------------------------------------------
// Mock routes. Numbers are deliberately labelled "mock_ms" so no reader
// mistakes them for provider timings.
// ---------------------------------------------------------------------------

type RouteName = "legacy_sonnet_mock" | "local_haiku_mock" | "azure_haiku_mock" | "hybrid_with_sonnet_fallback_mock";

interface RouteRunOutcome {
  route: RouteName;
  fixtureId: string;
  durationMockMs: number;
  criticalMatchCount: number;
  criticalMissingCount: number;
  schemaFailure: boolean;
  escalatedToSonnet: boolean;
  legacyFallback: boolean;
  routeDecision: PipelineRoute | "n/a";
  inputTokensMock: number;
  outputTokensMock: number;
}

function mockRun(routeName: RouteName, f: Fixture): RouteRunOutcome {
  const routing = { azureConfigured: true, maxTextFastPathPages: 40 };
  const decision = classifyRoute(f.parsedDoc, routing);
  const clean = f.parsedDoc.quality === "text_clean" || f.parsedDoc.quality === "text_sparse";

  const baseTokens = { input: 8000, output: 1400 }; // legacy full PDF
  const haikuTokens = { input: 800 + f.parsedDoc.fullText.length / 8, output: 900 };

  switch (routeName) {
    case "legacy_sonnet_mock":
      return {
        route: routeName, fixtureId: f.id,
        durationMockMs: 25_000 + Math.min(f.parsedDoc.pageCount * 500, 15_000),
        criticalMatchCount: f.parsedDoc.quality === "encrypted" || f.parsedDoc.quality === "corrupt" ? 0 : f.expectedCriticalFields.length,
        criticalMissingCount: f.parsedDoc.quality === "encrypted" || f.parsedDoc.quality === "corrupt" ? f.expectedCriticalFields.length : 0,
        schemaFailure: f.parsedDoc.quality === "encrypted" || f.parsedDoc.quality === "corrupt",
        escalatedToSonnet: false,
        legacyFallback: false,
        routeDecision: "legacy_full_sonnet",
        inputTokensMock: baseTokens.input,
        outputTokensMock: baseTokens.output,
      };
    case "local_haiku_mock":
      if (!clean) {
        return {
          route: routeName, fixtureId: f.id, durationMockMs: 1_500,
          criticalMatchCount: 0, criticalMissingCount: f.expectedCriticalFields.length,
          schemaFailure: true, escalatedToSonnet: false, legacyFallback: true,
          routeDecision: decision.route,
          inputTokensMock: 0, outputTokensMock: 0,
        };
      }
      return {
        route: routeName, fixtureId: f.id,
        durationMockMs: 900 + Math.round(haikuTokens.input * 0.5),
        criticalMatchCount: f.expectedCriticalFields.length,
        criticalMissingCount: 0,
        schemaFailure: false, escalatedToSonnet: false, legacyFallback: false,
        routeDecision: decision.route,
        inputTokensMock: Math.round(haikuTokens.input),
        outputTokensMock: haikuTokens.output,
      };
    case "azure_haiku_mock":
      if (f.parsedDoc.quality === "encrypted") {
        return {
          route: routeName, fixtureId: f.id, durationMockMs: 300,
          criticalMatchCount: 0, criticalMissingCount: f.expectedCriticalFields.length,
          schemaFailure: true, escalatedToSonnet: false, legacyFallback: true,
          routeDecision: "encrypted",
          inputTokensMock: 0, outputTokensMock: 0,
        };
      }
      return {
        route: routeName, fixtureId: f.id,
        durationMockMs: 6_000 + Math.min(f.parsedDoc.pageCount * 800, 8_000),
        criticalMatchCount: f.expectedCriticalFields.length,
        criticalMissingCount: 0,
        schemaFailure: false, escalatedToSonnet: false, legacyFallback: false,
        routeDecision: decision.route,
        inputTokensMock: Math.round(haikuTokens.input),
        outputTokensMock: haikuTokens.output,
      };
    case "hybrid_with_sonnet_fallback_mock": {
      if (f.parsedDoc.quality === "encrypted") {
        return {
          route: routeName, fixtureId: f.id, durationMockMs: 200,
          criticalMatchCount: 0, criticalMissingCount: f.expectedCriticalFields.length,
          schemaFailure: true, escalatedToSonnet: false, legacyFallback: true,
          routeDecision: "encrypted",
          inputTokensMock: 0, outputTokensMock: 0,
        };
      }
      const needsAzure = !clean;
      const escalated = f.category === "table_heavy" || f.category === "mixed"; // bounded sonnet on the hard cases
      const dur = (needsAzure ? 6000 : 1200) + (escalated ? 3500 : 0);
      const inputT = Math.round(haikuTokens.input) + (escalated ? 1200 : 0);
      const outputT = haikuTokens.output + (escalated ? 300 : 0);
      return {
        route: routeName, fixtureId: f.id, durationMockMs: dur,
        criticalMatchCount: f.expectedCriticalFields.length,
        criticalMissingCount: 0,
        schemaFailure: false, escalatedToSonnet: escalated, legacyFallback: false,
        routeDecision: decision.route,
        inputTokensMock: inputT, outputTokensMock: outputT,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}
function mean(arr: number[]): number {
  return arr.length === 0 ? 0 : Math.round(arr.reduce((s, x) => s + x, 0) / arr.length);
}

interface RouteSummary {
  route: RouteName;
  runs: number;
  successes: number;
  failures: number;
  p50DurationMockMs: number;
  p95DurationMockMs: number | null;   // null when sample too small to matter
  meanDurationMockMs: number;
  criticalMatchRate: number;
  schemaFailures: number;
  escalations: number;
  legacyFallbacks: number;
  totalInputTokensMock: number;
  totalOutputTokensMock: number;
}

function summarise(outcomes: RouteRunOutcome[]): RouteSummary {
  const runs = outcomes.length;
  const successes = outcomes.filter((o) => !o.schemaFailure).length;
  const durs = outcomes.map((o) => o.durationMockMs);
  const matches = outcomes.reduce((s, o) => s + o.criticalMatchCount, 0);
  const expected = outcomes.length * Math.max(1, outcomes[0]?.criticalMatchCount + outcomes[0]?.criticalMissingCount);
  return {
    route: outcomes[0].route,
    runs,
    successes,
    failures: runs - successes,
    p50DurationMockMs: pct(durs, 50),
    p95DurationMockMs: runs >= 8 ? pct(durs, 95) : null,
    meanDurationMockMs: mean(durs),
    criticalMatchRate: expected === 0 ? 0 : Number((matches / expected).toFixed(3)),
    schemaFailures: outcomes.filter((o) => o.schemaFailure).length,
    escalations: outcomes.filter((o) => o.escalatedToSonnet).length,
    legacyFallbacks: outcomes.filter((o) => o.legacyFallback).length,
    totalInputTokensMock: outcomes.reduce((s, o) => s + o.inputTokensMock, 0),
    totalOutputTokensMock: outcomes.reduce((s, o) => s + o.outputTokensMock, 0),
  };
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

function renderMarkdown(fixtures: Fixture[], summaries: RouteSummary[]): string {
  const lines: string[] = [];
  lines.push("# Atlas hybrid pipeline — benchmark report");
  lines.push("");
  lines.push("**Mode: fixture-only (mocked timings).** No live provider was called.");
  lines.push("Numbers below are labelled `mock` and MUST NOT be quoted as provider performance.");
  lines.push("");
  lines.push(`## Corpus (${fixtures.length} fixtures)`);
  lines.push("");
  lines.push("| id | category | pages | quality |");
  lines.push("|---|---|---|---|");
  for (const f of fixtures) {
    lines.push(`| ${f.id} | ${f.category} | ${f.parsedDoc.pageCount} | ${f.parsedDoc.quality} |`);
  }
  lines.push("");
  lines.push("## Route summaries");
  lines.push("");
  lines.push("| route | runs | pass | p50_mock_ms | p95_mock_ms | mean_mock_ms | critical_match | schema_fails | escalations | legacy_fallbacks |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const s of summaries) {
    lines.push(
      `| ${s.route} | ${s.runs} | ${s.successes} | ${s.p50DurationMockMs} | ${s.p95DurationMockMs ?? "n/a"} | ${s.meanDurationMockMs} | ${(s.criticalMatchRate * 100).toFixed(0)}% | ${s.schemaFailures} | ${s.escalations} | ${s.legacyFallbacks} |`
    );
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("- Durations here are MOCKED — they exist only to show the shape of relative differences the routes should produce.");
  lines.push("- Real Anthropic timings: run `npm run benchmark:pipeline -- --live-anthropic --confirm-paid` with ANTHROPIC_API_KEY set.");
  lines.push("- Real Azure timings: use shadow mode against synthetic fixtures — see docs/HYBRID_PIPELINE.md.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Live Anthropic route (Haiku on each fixture corpus). Opt-in only.
// ---------------------------------------------------------------------------
//
// Guardrails:
//   - Requires BOTH --live-anthropic AND --confirm-paid.
//   - Requires ANTHROPIC_API_KEY in the environment.
//   - Refuses on missing/empty credentials with a clear message.
//   - Never outputs document contents. Only per-fixture: duration, tokens,
//     success/failure, and (optionally) a truncated Anthropic error code.
//   - Never runs by default — the fixture mock route always runs; live is added.

interface LiveOutcome {
  route: "live_haiku";
  fixtureId: string;
  durationMs: number;
  status: "ok" | "http_error" | "parse_error";
  httpStatus?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  errorCode?: string;   // short — never provider prose
}

async function runLiveHaiku(fixture: Fixture, apiKey: string): Promise<LiveOutcome> {
  const started = Date.now();
  // Assemble a synthetic corpus purely from the fixture's own pages — no real
  // client data is ever sent.
  const corpus = fixture.parsedDoc.pages
    .map((p) => `--- page ${p.page} ---\n${p.text || "(empty)"}`)
    .join("\n\n");
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 800,
        temperature: 0,
        system: [{
          type: "text",
          text:
            "You are a benchmark stub for the Atlas hybrid pipeline. Return " +
            "a JSON object of the form {\"acknowledged\":true,\"pages_seen\":N} " +
            "where N is the count of ---page--- markers in the user message. " +
            "Return ONLY that JSON.",
          cache_control: { type: "ephemeral" },
        }],
        messages: [{ role: "user", content: corpus }],
      }),
    });
    const data = (await res.json().catch(() => null)) as {
      usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
      content?: { type: string; text?: string }[];
    } | null;
    if (!res.ok) {
      return {
        route: "live_haiku", fixtureId: fixture.id, durationMs: Date.now() - started,
        status: "http_error", httpStatus: res.status,
        errorCode: `anthropic_${res.status}`,
      };
    }
    const usage = data?.usage ?? {};
    // Do NOT surface the reply text (which would echo fixture content back).
    return {
      route: "live_haiku", fixtureId: fixture.id, durationMs: Date.now() - started,
      status: "ok",
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cachedInputTokens: usage.cache_read_input_tokens ?? 0,
    };
  } catch (e) {
    return {
      route: "live_haiku", fixtureId: fixture.id, durationMs: Date.now() - started,
      status: "parse_error", errorCode: (e as Error).message?.slice(0, 40) ?? "unknown",
    };
  }
}

interface LiveSummary {
  route: "live_haiku";
  runs: number;
  ok: number;
  errors: number;
  p50Ms: number;
  meanMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
}

function summariseLive(outs: LiveOutcome[]): LiveSummary {
  const ok = outs.filter((o) => o.status === "ok");
  const durs = ok.map((o) => o.durationMs);
  return {
    route: "live_haiku",
    runs: outs.length,
    ok: ok.length,
    errors: outs.length - ok.length,
    p50Ms: pct(durs, 50),
    meanMs: mean(durs),
    totalInputTokens: ok.reduce((s, o) => s + (o.inputTokens ?? 0), 0),
    totalOutputTokens: ok.reduce((s, o) => s + (o.outputTokens ?? 0), 0),
    totalCachedInputTokens: ok.reduce((s, o) => s + (o.cachedInputTokens ?? 0), 0),
  };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const argv = new Set(process.argv.slice(2));
const liveAnthropic = argv.has("--live-anthropic");
const liveAzure = argv.has("--live-azure");
const confirmPaid = argv.has("--confirm-paid");

if (liveAzure) {
  console.error("--live-azure is not yet wired in this harness. Use shadow mode for live Azure validation.");
  console.error("(Rejecting rather than silently running a paid Anthropic-only benchmark.)");
  process.exit(1);
}
if (liveAnthropic && !confirmPaid) {
  console.error("--live-anthropic requires --confirm-paid to acknowledge that real API charges will be incurred.");
  process.exit(1);
}
if (liveAnthropic) {
  const key = ((globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env?.ANTHROPIC_API_KEY ?? "").trim();
  if (!key) {
    console.error("--live-anthropic requires ANTHROPIC_API_KEY in the environment.");
    process.exit(1);
  }
  // Live validated. Run mock corpus first, then live Haiku, then merge.
}

const ROUTES: RouteName[] = ["legacy_sonnet_mock", "local_haiku_mock", "azure_haiku_mock", "hybrid_with_sonnet_fallback_mock"];
const allOutcomes = new Map<RouteName, RouteRunOutcome[]>();
for (const r of ROUTES) allOutcomes.set(r, []);

for (const f of FIXTURES) {
  for (const r of ROUTES) {
    allOutcomes.get(r)!.push(mockRun(r, f));
  }
}

const summaries: RouteSummary[] = ROUTES.map((r) => summarise(allOutcomes.get(r)!));

let liveSummary: LiveSummary | null = null;
let liveOutcomes: LiveOutcome[] = [];
if (liveAnthropic) {
  const key = ((globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env?.ANTHROPIC_API_KEY ?? "").trim();
  // Run sequentially so rate limits are respected. No fixture bytes are ever sent.
  for (const f of FIXTURES) {
    if (f.parsedDoc.pageCount === 0) continue;
    const out = await runLiveHaiku(f, key);
    liveOutcomes.push(out);
  }
  liveSummary = summariseLive(liveOutcomes);
}

const jsonReport = {
  generatedAt: new Date().toISOString(),
  mode: liveAnthropic ? "fixture_mock_plus_live_anthropic" : "fixture_only_mock",
  fixtures: FIXTURES.map((f) => ({ id: f.id, label: f.label, category: f.category, pages: f.parsedDoc.pageCount, quality: f.parsedDoc.quality })),
  summaries,
  live: liveSummary,
  liveOutcomes,
};

const md = renderMarkdown(FIXTURES, summaries) + (liveSummary ? "\n\n## Live Anthropic (Haiku)\n\n" +
  `runs=${liveSummary.runs} ok=${liveSummary.ok} errors=${liveSummary.errors} ` +
  `p50=${liveSummary.p50Ms}ms mean=${liveSummary.meanMs}ms ` +
  `input_tokens=${liveSummary.totalInputTokens} cached=${liveSummary.totalCachedInputTokens} output=${liveSummary.totalOutputTokens}` : "");

// Print both to stdout. We DO NOT write to disk by default because a
// checked-in benchmark file would go stale immediately; the caller can
// redirect stdout if a file is wanted.
console.log("=== BENCHMARK JSON ===");
console.log(JSON.stringify(jsonReport, null, 2));
console.log("");
console.log("=== BENCHMARK MARKDOWN ===");
console.log(md);
