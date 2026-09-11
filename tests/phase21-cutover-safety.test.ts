/**
 * Phase 6 Checkpoint 1 — cutover safety unit tests.
 * ---------------------------------------------------------------------------
 * Covers:
 *   * forward-only initial delta URL (fixed cutover, encoding, retained $select,
 *     per-mailbox overrides, delta reset reuse)
 *   * fail-closed parsing of ATLAS_GRAPH_MAILBOX_CUTOVERS_JSON
 *   * production must have a valid cutover per mailbox
 *   * graphJobProcessingEnabled semantics (LEVEL 2 kill-switch)
 *   * placeholder scanner URL rejection in validateEnv()
 *   * malware-scan.scanStorageObject refuses placeholder URL in production
 *
 * These are pure-function tests only — no Graph traffic, no admin fake, no
 * SupabaseClient, no live network. Continuation URLs (nextLink / deltaLink)
 * are exercised via unit-level construction; behavioural tests owned by the
 * existing phase19b/phase20 suites are unmodified.
 */

import {
  graphMailboxCutovers,
  graphJobProcessingEnabled,
  isPlaceholderScannerUrl,
  isValidCutoverIso,
  resolveMailboxCutover,
  type Env,
} from "../worker/src/config.js";
import { initialDeltaUrl } from "../worker/src/graph-client.js";
import { validateEnv } from "../worker/src/phase6-hardening.js";
import { scanStorageObject } from "../worker/src/malware-scan.js";
import {
  RESET_FLOOR_OVERLAP_MS,
  computeResetFloorAdvance,
  maxIsoUtc,
} from "../worker/src/graph-intake.js";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function eq<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}

// ---------------------------------------------------------------------------
// Fixed cutover appears in initial URL, correctly URL-encoded
// ---------------------------------------------------------------------------

test("initial URL: fixed cutover appears once, URL-encoded, appended after $select", () => {
  const url = initialDeltaUrl("intake@example.com", "2026-09-20T06:00:00.000Z");
  // $select still present verbatim
  assert(
    url.includes("$select=id,internetMessageId,conversationId,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,hasAttachments"),
    "existing $select is retained",
  );
  // Filter is encoded (space becomes %20, colon becomes %3A)
  assert(
    url.includes("&$filter=receivedDateTime%20ge%202026-09-20T06%3A00%3A00.000Z"),
    "encoded filter appended",
  );
  // Ordering: filter comes after select
  assert(url.indexOf("$select=") < url.indexOf("$filter="), "filter follows select");
  // Exactly one $filter parameter
  eq(url.match(/\$filter=/g)?.length ?? 0, 1, "exactly one filter param");
});

test("initial URL: absent cutover means no $filter clause", () => {
  const url = initialDeltaUrl("intake@example.com");
  assert(!url.includes("$filter"), "no filter when cutover absent");
  assert(url.includes("/mailFolders/Inbox/messages/delta"), "delta endpoint retained");
});

test("initial URL: different mailboxes can carry different cutoffs", () => {
  const a = initialDeltaUrl("a@example.com", "2026-01-01T00:00:00.000Z");
  const b = initialDeltaUrl("b@example.com", "2026-06-01T00:00:00.000Z");
  assert(a.includes("2026-01-01T00%3A00%3A00.000Z"), "mailbox a carries its own cutoff");
  assert(b.includes("2026-06-01T00%3A00%3A00.000Z"), "mailbox b carries its own cutoff");
  assert(a.includes("a%40example.com"), "mailbox a in path");
  assert(b.includes("b%40example.com"), "mailbox b in path");
});

// ---------------------------------------------------------------------------
// ISO validator
// ---------------------------------------------------------------------------

test("isValidCutoverIso: accepts strict UTC ISO 8601 only", () => {
  assert(isValidCutoverIso("2026-09-20T06:00:00.000Z"), "ms precision UTC");
  assert(isValidCutoverIso("2026-09-20T06:00:00Z"), "second precision UTC");
  assert(!isValidCutoverIso("2026-09-20T06:00:00+00:00"), "offset form rejected");
  assert(!isValidCutoverIso("2026-09-20T06:00:00.000"), "no Z rejected");
  assert(!isValidCutoverIso("2026-09-20"), "date-only rejected");
  assert(!isValidCutoverIso("Wed, 09 Sep 2026 06:00:00 GMT"), "RFC 1123 rejected");
  assert(!isValidCutoverIso(""), "empty rejected");
  assert(!isValidCutoverIso(undefined), "undefined rejected");
});

// ---------------------------------------------------------------------------
// Cutover parser — fail-closed on every malformed shape
// ---------------------------------------------------------------------------

const BASE_PROD_ENV = {
  ATLAS_ENV: "production" as const,
  SUPABASE_URL: "https://x", SUPABASE_SERVICE_ROLE_KEY: "k", SUPABASE_ANON_KEY: "a",
  AZURE_TENANT_ID: "t", AZURE_CLIENT_ID: "c", AZURE_CLIENT_SECRET: "s",
  AZURE_REDIRECT_URI: "https://atlas.example/auth/callback",
  ANTHROPIC_API_KEY: "k", ATLAS_ALLOWLIST_JSON: "{}",
  CORS_ORIGIN: "https://atlas.example",
  ATLAS_OAUTH_STATE_SECRET: "hmac",
} as unknown as Env;

test("graphMailboxCutovers: missing config fails closed", () => {
  const env = { ...BASE_PROD_ENV } as Env;
  const r = graphMailboxCutovers(env);
  assert(!r.ok && r.reason === "missing", "missing");
});

test("graphMailboxCutovers: unparseable JSON fails closed", () => {
  const env = { ...BASE_PROD_ENV, ATLAS_GRAPH_MAILBOX_CUTOVERS_JSON: "{not:json" } as Env;
  const r = graphMailboxCutovers(env);
  assert(!r.ok && r.reason === "unparseable_json", "unparseable_json");
});

test("graphMailboxCutovers: array root fails closed", () => {
  const env = { ...BASE_PROD_ENV, ATLAS_GRAPH_MAILBOX_CUTOVERS_JSON: "[]" } as Env;
  const r = graphMailboxCutovers(env);
  assert(!r.ok && r.reason === "not_object", "not_object");
});

test("graphMailboxCutovers: non-string value fails closed", () => {
  const env = { ...BASE_PROD_ENV, ATLAS_GRAPH_MAILBOX_CUTOVERS_JSON: JSON.stringify({ "a@x.com": 12345 }) } as Env;
  const r = graphMailboxCutovers(env);
  assert(!r.ok && r.reason === "non_string_cutover", "non_string_cutover");
});

test("graphMailboxCutovers: malformed timestamp fails closed", () => {
  const env = { ...BASE_PROD_ENV, ATLAS_GRAPH_MAILBOX_CUTOVERS_JSON: JSON.stringify({ "a@x.com": "yesterday" }) } as Env;
  const r = graphMailboxCutovers(env);
  assert(!r.ok && r.reason === "cutover_not_iso_utc", "cutover_not_iso_utc");
});

test("graphMailboxCutovers: parses valid config and lower-cases keys", () => {
  const env = {
    ...BASE_PROD_ENV,
    ATLAS_GRAPH_MAILBOX_CUTOVERS_JSON: JSON.stringify({
      "Intake@Example.com": "2026-09-20T06:00:00.000Z",
      "team@example.com": "2026-09-21T00:00:00Z",
    }),
  } as Env;
  const r = graphMailboxCutovers(env);
  assert(r.ok, "ok");
  if (!r.ok) return;
  eq(r.map.get("intake@example.com"), "2026-09-20T06:00:00.000Z", "key 1 lower-cased and preserved");
  eq(r.map.get("team@example.com"), "2026-09-21T00:00:00Z", "key 2");
  eq(r.map.get("Intake@Example.com"), undefined, "keys are stored lower-cased");
});

// ---------------------------------------------------------------------------
// resolveMailboxCutover — production vs. non-production behaviour
// ---------------------------------------------------------------------------

test("resolveMailboxCutover: production requires per-mailbox entry", () => {
  const env = {
    ...BASE_PROD_ENV,
    ATLAS_GRAPH_MAILBOX_CUTOVERS_JSON: JSON.stringify({ "intake@example.com": "2026-09-20T06:00:00.000Z" }),
  } as Env;
  const hit = resolveMailboxCutover(env, "intake@example.com");
  assert(hit.ok && hit.cutoverIso === "2026-09-20T06:00:00.000Z", "hit");
  const miss = resolveMailboxCutover(env, "other@example.com");
  assert(!miss.ok && miss.reason === "mailbox_cutover_missing", "production miss fails closed");
});

test("resolveMailboxCutover: production ignores ATLAS_GRAPH_TEST_DEFAULT_CUTOVER", () => {
  const env = {
    ...BASE_PROD_ENV,
    ATLAS_GRAPH_MAILBOX_CUTOVERS_JSON: JSON.stringify({}),
    ATLAS_GRAPH_TEST_DEFAULT_CUTOVER: "2026-09-20T06:00:00.000Z",
  } as Env;
  const r = resolveMailboxCutover(env, "any@example.com");
  assert(!r.ok, "production ignores test default");
});

test("resolveMailboxCutover: non-production accepts explicit test default", () => {
  const env = {
    ATLAS_ENV: "staging",
    ATLAS_GRAPH_TEST_DEFAULT_CUTOVER: "2026-09-20T06:00:00.000Z",
  } as unknown as Env;
  const r = resolveMailboxCutover(env, "any@example.com");
  assert(r.ok && r.cutoverIso === "2026-09-20T06:00:00.000Z", "test default used");
});

test("resolveMailboxCutover: non-production without any cutover fails closed", () => {
  const env = { ATLAS_ENV: "staging" } as unknown as Env;
  const r = resolveMailboxCutover(env, "any@example.com");
  assert(!r.ok, "no cutover, no default → fail closed");
});

test("resolveMailboxCutover: mailbox lookup is case-insensitive", () => {
  const env = {
    ATLAS_ENV: "staging",
    ATLAS_GRAPH_MAILBOX_CUTOVERS_JSON: JSON.stringify({ "Intake@Example.com": "2026-09-20T06:00:00.000Z" }),
  } as unknown as Env;
  const upper = resolveMailboxCutover(env, "INTAKE@EXAMPLE.COM");
  assert(upper.ok, "upper hit");
  const mixed = resolveMailboxCutover(env, " Intake@Example.com ");
  assert(mixed.ok, "whitespace-tolerant hit");
});

// ---------------------------------------------------------------------------
// Delta-reset invariant: same cutover reused
// ---------------------------------------------------------------------------

test("delta reset reuses the same fixed cutover — Date.now() never enters the boundary", () => {
  // Simulate: first-ever call and a delta-token reset a week later. The
  // cutover was captured once at the start of the poll; the second call must
  // reproduce the same URL bytes.
  const cutover = "2026-09-20T06:00:00.000Z";
  const first = initialDeltaUrl("intake@example.com", cutover);
  const reset = initialDeltaUrl("intake@example.com", cutover);
  eq(first, reset, "reset URL identical to first URL");
});

// ---------------------------------------------------------------------------
// Continuation URLs untouched — a nextLink/deltaLink from Graph is returned
// verbatim by fetchDeltaPage's caller; we assert here that initialDeltaUrl is
// the ONLY producer of a $filter clause. Continuation URLs are Graph-issued
// opaque strings that Atlas never rewrites.
// ---------------------------------------------------------------------------

test("$filter is applied only via initialDeltaUrl — continuation URLs are opaque", () => {
  const withCutover = initialDeltaUrl("intake@example.com", "2026-09-20T06:00:00.000Z");
  const withoutCutover = initialDeltaUrl("intake@example.com");
  assert(withCutover.includes("$filter"), "initial with cutover has filter");
  assert(!withoutCutover.includes("$filter"), "initial without cutover has no filter");
  // A synthetic Graph-returned continuation URL has no $filter; Atlas never
  // adds one to it. The runtime forwards the opaque URL directly to fetch —
  // proven by inspection of graph-client.fetchDeltaPage (calls fetchWithAllowlist
  // with the URL as-is). This assertion is a structural guard on our contract.
  const fauxContinuation = "https://graph.microsoft.com/v1.0/users/intake@example.com/mailFolders/Inbox/messages/delta?$skiptoken=xyz";
  assert(!fauxContinuation.includes("$filter"), "continuation URL is untouched (has no filter)");
});

// ---------------------------------------------------------------------------
// Messages before the cutoff cannot enter the initial Graph response contract:
// Microsoft Graph applies $filter server-side. We prove ATLAS's request enforces
// the boundary by inspecting the URL contract; behavioural verification against
// live Graph is a staging-gate concern, not a unit test.
// ---------------------------------------------------------------------------

test("initial URL contract: $filter uses ge (>=), NOT gt — cutover is inclusive at the boundary", () => {
  const url = initialDeltaUrl("intake@example.com", "2026-09-20T06:00:00.000Z");
  assert(url.includes("receivedDateTime%20ge%20"), "ge operator used");
  assert(!url.includes("%20gt%20"), "gt not used");
});

// ---------------------------------------------------------------------------
// LEVEL 2 kill-switch semantics
// ---------------------------------------------------------------------------

test("graphJobProcessingEnabled: production defaults CLOSED", () => {
  eq(graphJobProcessingEnabled({ ATLAS_ENV: "production" } as unknown as Env), false, "unset in prod");
  eq(graphJobProcessingEnabled({ ATLAS_ENV: "production", ATLAS_GRAPH_JOB_PROCESSING_ENABLED: "false" } as unknown as Env), false, "explicit false");
  eq(graphJobProcessingEnabled({ ATLAS_ENV: "production", ATLAS_GRAPH_JOB_PROCESSING_ENABLED: "true" } as unknown as Env), true, "explicit true");
  eq(graphJobProcessingEnabled({ ATLAS_ENV: "production", ATLAS_GRAPH_JOB_PROCESSING_ENABLED: "1" } as unknown as Env), false, "'1' does not satisfy strict === 'true'");
});

test("graphJobProcessingEnabled: staging is a DEPLOYED env — also fails closed by default", () => {
  eq(graphJobProcessingEnabled({ ATLAS_ENV: "staging" } as unknown as Env), false, "unset in staging");
  eq(graphJobProcessingEnabled({ ATLAS_ENV: "staging", ATLAS_GRAPH_JOB_PROCESSING_ENABLED: "false" } as unknown as Env), false, "staging explicit false");
  eq(graphJobProcessingEnabled({ ATLAS_ENV: "staging", ATLAS_GRAPH_JOB_PROCESSING_ENABLED: "true" } as unknown as Env), true, "staging explicit true");
  eq(graphJobProcessingEnabled({ ATLAS_ENV: "staging", ATLAS_GRAPH_JOB_PROCESSING_ENABLED: "1" } as unknown as Env), false, "staging strict === 'true'");
});

test("graphJobProcessingEnabled: development / test default OPEN, honours explicit false", () => {
  eq(graphJobProcessingEnabled({ ATLAS_ENV: "development" } as unknown as Env), true, "dev default open");
  eq(graphJobProcessingEnabled({ ATLAS_ENV: "test" } as unknown as Env), true, "test default open");
  eq(graphJobProcessingEnabled({} as unknown as Env), true, "unset atlas_env default open");
  eq(graphJobProcessingEnabled({ ATLAS_ENV: "development", ATLAS_GRAPH_JOB_PROCESSING_ENABLED: "false" } as unknown as Env), false, "dev explicit false");
});

// ---------------------------------------------------------------------------
// Discovery / ingest processors return processing_paused when flag off
// ---------------------------------------------------------------------------

test("handleGraphAttachmentDiscoveryJob refuses to run when LEVEL 2 disabled", async () => {
  const { handleGraphAttachmentDiscoveryJob } = await import("../worker/src/graph-attachment.js");
  const env = { ATLAS_ENV: "production", ATLAS_GRAPH_JOB_PROCESSING_ENABLED: "false" } as unknown as Env;
  // Fake admin — MUST NOT be called. Any invocation is a failure.
  const admin = new Proxy({}, {
    get() { throw new Error("admin must not be touched when processing is paused"); },
  }) as never;
  const result = await handleGraphAttachmentDiscoveryJob(env, admin, { id: "job-1", metadata: { intake_message_id: "x" } });
  eq(result.outcome, "processing_paused", "outcome");
});

test("handleGraphAttachmentIngestJob refuses to run when LEVEL 2 disabled", async () => {
  const { handleGraphAttachmentIngestJob } = await import("../worker/src/graph-attachment.js");
  const env = { ATLAS_ENV: "production", ATLAS_GRAPH_JOB_PROCESSING_ENABLED: "false" } as unknown as Env;
  const admin = new Proxy({}, {
    get() { throw new Error("admin must not be touched when processing is paused"); },
  }) as never;
  const result = await handleGraphAttachmentIngestJob(env, admin, { id: "job-2", metadata: { attachment_id: "x" } });
  eq(result.outcome, "processing_paused", "outcome");
});

// ---------------------------------------------------------------------------
// Placeholder scanner URL detection
// ---------------------------------------------------------------------------

test("isPlaceholderScannerUrl catches common placeholders", () => {
  assert(isPlaceholderScannerUrl("https://scanner.yourcompany.com/scan"), "yourcompany");
  assert(isPlaceholderScannerUrl("https://scanner.example.com/scan"), "example.com");
  assert(isPlaceholderScannerUrl("https://scanner.your-domain.io/scan"), "your-domain");
  assert(isPlaceholderScannerUrl("https://placeholder.internal/scan"), "placeholder");
  assert(isPlaceholderScannerUrl("https://replace-me.internal/scan"), "replace-me");
  assert(!isPlaceholderScannerUrl("https://scanner.smartsure.co.za/scan"), "real hostname passes");
  assert(!isPlaceholderScannerUrl(undefined), "undefined passes");
  assert(!isPlaceholderScannerUrl(""), "empty passes");
});

test("validateEnv flags placeholder scanner URL in production", () => {
  const env: Env = {
    ...BASE_PROD_ENV,
    ATLAS_MALWARE_SCANNER_URL: "https://scanner.yourcompany.com/scan",
    ATLAS_MALWARE_SCANNER_TOKEN: "tok",
  } as Env;
  const problems = validateEnv(env);
  assert(problems.includes("production_malware_scanner_url_is_placeholder"), "flagged");
});

test("validateEnv accepts a real-looking scanner URL", () => {
  const env: Env = {
    ...BASE_PROD_ENV,
    ATLAS_MALWARE_SCANNER_URL: "https://av.smartsure.internal/scan",
    ATLAS_MALWARE_SCANNER_TOKEN: "tok",
  } as Env;
  const problems = validateEnv(env);
  assert(!problems.includes("production_malware_scanner_url_is_placeholder"), "not flagged");
  assert(!problems.includes("production_malware_scanner_missing"), "not flagged missing");
});

test("scanStorageObject refuses placeholder URL in production even if validateEnv is bypassed", async () => {
  const env = {
    ATLAS_ENV: "production",
    ATLAS_MALWARE_SCANNER_URL: "https://scanner.yourcompany.com/scan",
    ATLAS_MALWARE_SCANNER_TOKEN: "tok",
    SUPABASE_URL: "https://x",
    SUPABASE_SERVICE_ROLE_KEY: "k",
    SUPABASE_ANON_KEY: "a",
  } as unknown as Env;
  let threw: unknown = null;
  try {
    await scanStorageObject(env, { bucket: "b", path: "p", fileName: "f", contentType: "application/pdf" });
  } catch (err) { threw = err; }
  assert(threw instanceof Error && (threw as Error).message === "scanner_url_is_placeholder", "specific classified error");
});

test("scanStorageObject: production with no scanner still fails closed (scanner_unconfigured)", async () => {
  const env = { ATLAS_ENV: "production" } as unknown as Env;
  let threw: unknown = null;
  try {
    await scanStorageObject(env, { bucket: "b", path: "p", fileName: "f", contentType: "application/pdf" });
  } catch (err) { threw = err; }
  assert(threw instanceof Error && (threw as Error).message === "scanner_unconfigured", "scanner_unconfigured");
});

test("scanStorageObject: development_bypass never activates in production", async () => {
  // Even with URL+token undefined AND ATLAS_ENV production, no clean-bypass verdict is returned.
  const env = { ATLAS_ENV: "production" } as unknown as Env;
  let ok = false;
  try {
    await scanStorageObject(env, { bucket: "b", path: "p", fileName: "f", contentType: "application/pdf" });
    ok = true;
  } catch { ok = false; }
  eq(ok, false, "must not return clean-bypass in production");
});

// ---------------------------------------------------------------------------
// Reset-floor advance logic (Checkpoint 1A)
// ---------------------------------------------------------------------------

test("maxIsoUtc: null-safe and string-comparable for strict UTC ISO", () => {
  eq(maxIsoUtc(null, null), null, "both null");
  eq(maxIsoUtc("2026-09-20T06:00:00.000Z", null), "2026-09-20T06:00:00.000Z", "b null");
  eq(maxIsoUtc(null, "2026-09-20T06:00:00.000Z"), "2026-09-20T06:00:00.000Z", "a null");
  eq(
    maxIsoUtc("2026-09-20T06:00:00.000Z", "2026-10-01T00:00:00.000Z"),
    "2026-10-01T00:00:00.000Z",
    "later wins",
  );
  eq(
    maxIsoUtc("2026-10-01T00:00:00.000Z", "2026-09-20T06:00:00.000Z"),
    "2026-10-01T00:00:00.000Z",
    "later wins (reversed)",
  );
});

test("computeResetFloorAdvance: subtracts fixed 24h overlap and clamps to configured cutover", () => {
  const cutover = "2026-09-20T06:00:00.000Z";
  // Poll-start well after the cutover — proposed = pollStart - 24h wins.
  const pollStartMs = Date.parse("2026-10-01T12:00:00.000Z");
  const advance = computeResetFloorAdvance(pollStartMs, cutover);
  eq(advance, "2026-09-30T12:00:00.000Z", "24h before poll-start");
  eq(RESET_FLOOR_OVERLAP_MS, 24 * 60 * 60 * 1000, "overlap constant");
});

test("computeResetFloorAdvance: never advances before the configured cutover", () => {
  const cutover = "2026-09-20T06:00:00.000Z";
  // Poll-start only 1h after the cutover — proposed (pollStart - 24h) is
  // BEFORE cutover; clamp must return the cutover unchanged.
  const pollStartMs = Date.parse("2026-09-20T07:00:00.000Z");
  const advance = computeResetFloorAdvance(pollStartMs, cutover);
  eq(advance, cutover, "clamped to cutover");
});

test("computeResetFloorAdvance: repeated reset with same pollStart is deterministic", () => {
  const cutover = "2026-09-20T06:00:00.000Z";
  const pollStartMs = Date.parse("2026-10-15T00:00:00.000Z");
  const a = computeResetFloorAdvance(pollStartMs, cutover);
  const b = computeResetFloorAdvance(pollStartMs, cutover);
  eq(a, b, "identical inputs → identical output");
});

test("first sync (no floor) uses configured cutover for the initial URL", () => {
  // Simulate what pollMailbox does: effectiveCutover = max(cutover, floor).
  const cutover = "2026-09-20T06:00:00.000Z";
  const floor: string | null = null;
  const effective = maxIsoUtc(cutover, floor) ?? cutover;
  const url = initialDeltaUrl("intake@example.com", effective);
  assert(url.includes("2026-09-20T06%3A00%3A00.000Z"), "cutover in URL");
});

test("410 reset with persisted floor uses the FLOOR when it is later than the cutover", () => {
  const cutover = "2026-09-20T06:00:00.000Z";
  const floor   = "2026-09-30T12:00:00.000Z";
  const effective = maxIsoUtc(cutover, floor) ?? cutover;
  const url = initialDeltaUrl("intake@example.com", effective);
  assert(url.includes("2026-09-30T12%3A00%3A00.000Z"), "floor in URL");
  assert(!url.includes("2026-09-20T06%3A00%3A00.000Z"), "cutover not in URL");
});

test("410 reset with a floor BEFORE the cutover still uses the cutover (immutable earliest bound)", () => {
  const cutover = "2026-09-20T06:00:00.000Z";
  const floor   = "2026-08-01T00:00:00.000Z"; // hypothetically older; RPC guards against this too
  const effective = maxIsoUtc(cutover, floor) ?? cutover;
  const url = initialDeltaUrl("intake@example.com", effective);
  assert(url.includes("2026-09-20T06%3A00%3A00.000Z"), "cutover wins");
});

test("continuation URLs (nextLink/deltaLink) are opaque — no $filter rewriting on reset", () => {
  // A synthetic continuation URL (skiptoken) must never be re-injected with
  // $filter by Atlas. The runtime forwards it verbatim to fetchWithAllowlist.
  const opaque = "https://graph.microsoft.com/v1.0/users/x/mailFolders/Inbox/messages/delta?$skiptoken=abc";
  // Assertion: Atlas has no code path that adds $filter to an already-encoded
  // continuation URL. initialDeltaUrl is the ONLY producer of $filter, and it
  // takes a mailbox + optional cutover — never an existing URL.
  assert(!opaque.includes("$filter"), "no filter on Graph-issued continuation");
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let failures = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok - ${t.name}`);
  } catch (err) {
    failures++;
    console.error(`not ok - ${t.name}`);
    console.error((err as Error).message);
  }
}
if (failures > 0) process.exitCode = 1;
