/**
 * Phase 23 — Background runner CPU isolation (hotfix).
 * ---------------------------------------------------------------------------
 * Production incident: the every-minute cron ran job processing, cleanup
 * detection, approved cleanup, signal monitoring and alert escalation
 * CONCURRENTLY inside one Cloudflare invocation. Every invocation died with
 * "Exceeded CPU Limit" before the malware scanner was reached.
 *
 * These tests drive the REAL scheduler (worker/src/background-schedule.ts) —
 * the pure cadence helper and the sequencer that phase4-background.ts hands
 * its stage thunks to. phase4-background.ts itself cannot be loaded under the
 * Node test harness (it pulls in every job handler), so the wiring is pinned
 * with source-structure assertions, the same technique other phases use for
 * worker/src/index.ts.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BACKGROUND_STAGE_ORDER,
  MAINTENANCE_CADENCE,
  dueStages,
  isStageDue,
  logStageFailure,
  runBackgroundStages,
  toScheduledAt,
  type BackgroundStageName,
  type MaintenanceStageName,
  type StageRunners,
} from "../worker/src/background-schedule.js";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) { tests.push({ name, fn }); }
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
function eq<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}
function deepEq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg}: expected ${e}, got ${a}`);
}

const MAINTENANCE: MaintenanceStageName[] = ["signal_monitoring", "alert_escalation", "approved_cleanup", "cleanup_detection"];
const ALL: BackgroundStageName[] = [...BACKGROUND_STAGE_ORDER];

/** A cron tick at HH:mm UTC on a fixed date. */
function at(minute: number, hour = 10): Date {
  return new Date(Date.UTC(2026, 9, 15, hour, minute, 0));
}

const tick = () => new Promise<void>((r) => setImmediate(r));

/**
 * Instrumented stage runners. Every runner awaits a couple of macrotasks so
 * that genuine overlap is observable (an eagerly-started sibling WOULD start
 * while this one is suspended). Tracks the live concurrency high-water mark.
 */
function tracer(opts: {
  jobsGate?: Promise<void>;
  throwIn?: Partial<Record<BackgroundStageName, "reject" | "sync">>;
} = {}) {
  const events: string[] = [];
  let active = 0;
  let maxActive = 0;
  const make = (stage: BackgroundStageName): (() => unknown) => {
    const mode = opts.throwIn?.[stage];
    if (mode === "sync") {
      return () => {
        events.push(`${stage}:start`);
        events.push(`${stage}:end`);
        throw new Error(`${stage} sync boom`);
      };
    }
    return async () => {
      events.push(`${stage}:start`);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        if (stage === "job_processing" && opts.jobsGate) await opts.jobsGate;
        await tick();
        await tick();
        if (mode === "reject") throw new Error(`${stage} boom`);
      } finally {
        active--;
        events.push(`${stage}:end`);
      }
    };
  };
  const runners = Object.fromEntries(ALL.map((s) => [s, make(s)])) as StageRunners;
  return { runners, events, maxActive: () => maxActive };
}

function quietOptions() {
  const failures: Array<{ stage: BackgroundStageName; error: unknown }> = [];
  return { failures, onFailure: (stage: BackgroundStageName, error: unknown) => { failures.push({ stage, error }); } };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  return { promise, release };
}

// ---------------------------------------------------------------------------
// Cadence (pure helper)
// ---------------------------------------------------------------------------

test("cadence: job_processing is due on every minute of the hour", () => {
  for (let m = 0; m < 60; m++) assert(isStageDue("job_processing", at(m)), `job_processing due at :${m}`);
});

test("cadence: table is well-formed (period divides 60, offset inside period)", () => {
  for (const stage of MAINTENANCE) {
    const c = MAINTENANCE_CADENCE[stage];
    eq(60 % c.everyMinutes, 0, `${stage} period must divide 60`);
    assert(c.offsetMinute >= 0 && c.offsetMinute < c.everyMinutes, `${stage} offset within its period`);
  }
});

test("cadence: signal_monitoring and alert_escalation obey the >=5 minute floor (288 runs/day, never closer than 5 min)", () => {
  for (const stage of ["signal_monitoring", "alert_escalation"] as const) {
    const runs: number[] = [];
    for (let i = 0; i < 1440; i++) {
      if (isStageDue(stage, new Date(Date.UTC(2026, 9, 15, 0, 0, 0) + i * 60_000))) runs.push(i);
    }
    eq(runs.length, 288, `${stage} runs/day`);
    for (let i = 1; i < runs.length; i++) assert(runs[i] - runs[i - 1] >= 5, `${stage} gap >=5 min (got ${runs[i] - runs[i - 1]})`);
  }
});

test("cadence: cleanup_detection and approved_cleanup run exactly once per hour (24/day), never on consecutive minutes", () => {
  for (const stage of ["cleanup_detection", "approved_cleanup"] as const) {
    const runs: number[] = [];
    for (let i = 0; i < 1440; i++) {
      if (isStageDue(stage, new Date(Date.UTC(2026, 9, 15, 0, 0, 0) + i * 60_000))) runs.push(i);
    }
    eq(runs.length, 24, `${stage} runs/day (NOT 1440)`);
    for (let i = 1; i < runs.length; i++) eq(runs[i] - runs[i - 1], 60, `${stage} hourly gap`);
  }
});

test("cadence: default cadence puts at most ONE maintenance stage on any invocation", () => {
  for (let m = 0; m < 60; m++) {
    const due = dueStages(at(m));
    eq(due[0], "job_processing", `job_processing first at :${m}`);
    assert(due.length <= 2, `at :${m} expected job + at most one maintenance stage, got ${due.join(",")}`);
  }
});

test("cadence: the exact production schedule is :01/:06/... monitor, :03/:08/... escalation, :17 detection, :47 approved cleanup", () => {
  deepEq(dueStages(at(1)), ["job_processing", "signal_monitoring"], ":01");
  deepEq(dueStages(at(3)), ["job_processing", "alert_escalation"], ":03");
  deepEq(dueStages(at(17)), ["job_processing", "cleanup_detection"], ":17");
  deepEq(dueStages(at(47)), ["job_processing", "approved_cleanup"], ":47");
  deepEq(dueStages(at(0)), ["job_processing"], ":00 is jobs only");
  deepEq(dueStages(at(2)), ["job_processing"], ":02 is jobs only");
  deepEq(dueStages(at(6)), ["job_processing", "signal_monitoring"], ":06");
});

test("cadence: deterministic and stateless — depends only on the UTC minute, not on hour/date/seconds or call history", () => {
  const first = dueStages(at(17, 3)).join();
  // Interleave unrelated calls, different hours, different dates, odd seconds.
  dueStages(at(1));
  dueStages(at(3));
  eq(dueStages(at(17, 22)).join(), first, "same minute, different hour");
  eq(dueStages(new Date(Date.UTC(2031, 0, 2, 5, 17, 59, 999))).join(), first, "same minute, different date/seconds");
  eq(dueStages(at(17, 3)).join(), first, "repeat call");
});

test("cadence: invalid Date never schedules maintenance but job processing stays due", () => {
  const bad = new Date(Number.NaN);
  assert(isStageDue("job_processing", bad), "job_processing due on invalid date");
  for (const stage of MAINTENANCE) assert(!isStageDue(stage, bad), `${stage} not due on invalid date`);
});

test("toScheduledAt: accepts Date/number, falls back for missing or non-finite values", () => {
  const fallback = () => new Date(Date.UTC(2000, 0, 1));
  eq(toScheduledAt(at(17).getTime(), fallback).getTime(), at(17).getTime(), "number");
  eq(toScheduledAt(at(17), fallback).getTime(), at(17).getTime(), "Date");
  eq(toScheduledAt(undefined, fallback).getTime(), fallback().getTime(), "undefined");
  eq(toScheduledAt(null, fallback).getTime(), fallback().getTime(), "null");
  eq(toScheduledAt(Number.NaN, fallback).getTime(), fallback().getTime(), "NaN");
  eq(toScheduledAt(Number.POSITIVE_INFINITY, fallback).getTime(), fallback().getTime(), "Infinity");
  eq(toScheduledAt(new Date(Number.NaN), fallback).getTime(), fallback().getTime(), "invalid Date");
});

// ---------------------------------------------------------------------------
// A. Job processing is invoked before any maintenance stage starts
// ---------------------------------------------------------------------------

test("A: job_processing starts first and finishes before ANY maintenance stage starts (every minute of the hour)", async () => {
  for (let m = 0; m < 60; m++) {
    const t = tracer();
    const q = quietOptions();
    await runBackgroundStages(t.runners, at(m), q);
    eq(t.events[0], "job_processing:start", `:${m} first event`);
    const jobEnd = t.events.indexOf("job_processing:end");
    assert(jobEnd >= 0, `:${m} job_processing finished`);
    t.events.forEach((e, i) => {
      if (e.endsWith(":start") && !e.startsWith("job_processing")) {
        assert(i > jobEnd, `:${m} ${e} must start after job_processing:end`);
      }
    });
  }
});

test("A: with every stage forced due, jobs run first and the rest follow in documented order", async () => {
  const t = tracer();
  const q = quietOptions();
  const summary = await runBackgroundStages(t.runners, at(0), { ...q, isDue: () => true });
  deepEq(t.events, [
    "job_processing:start", "job_processing:end",
    "signal_monitoring:start", "signal_monitoring:end",
    "alert_escalation:start", "alert_escalation:end",
    "approved_cleanup:start", "approved_cleanup:end",
    "cleanup_detection:start", "cleanup_detection:end",
  ], "strict sequential order");
  deepEq(summary.attempted, ALL, "attempted");
  eq(summary.failed.length, 0, "no failures");
});

// ---------------------------------------------------------------------------
// B. Heavy maintenance is not launched concurrently with processQueuedJobs
// ---------------------------------------------------------------------------

test("B: while job_processing is still pending, NO maintenance stage has started (cleanup minute :17)", async () => {
  const gate = deferred();
  const t = tracer({ jobsGate: gate.promise });
  const q = quietOptions();
  const run = runBackgroundStages(t.runners, at(17), q);
  for (let i = 0; i < 10; i++) await tick();
  deepEq(t.events, ["job_processing:start"], "only job_processing has started while it is pending");
  gate.release();
  await run;
  deepEq(t.events, [
    "job_processing:start", "job_processing:end",
    "cleanup_detection:start", "cleanup_detection:end",
  ], "maintenance began only after jobs settled");
});

test("B: no two stages ever overlap, even when every stage is forced due", async () => {
  const t = tracer();
  await runBackgroundStages(t.runners, at(0), { ...quietOptions(), isDue: () => true });
  eq(t.maxActive(), 1, "live concurrency high-water mark");
});

test("B: runners are lazy — a stage that is not due is never even invoked", async () => {
  const t = tracer();
  const summary = await runBackgroundStages(t.runners, at(0), quietOptions());
  deepEq(t.events, ["job_processing:start", "job_processing:end"], ":00 invokes only job_processing");
  deepEq(summary.skipped, MAINTENANCE.slice().sort((a, b) => ALL.indexOf(a) - ALL.indexOf(b)), "all maintenance skipped");
});

test("B (harness sanity): the OLD eager Promise.allSettled shape IS detected as concurrent by this tracer", async () => {
  const t = tracer();
  // Reproduce the pre-fix pattern: every stage promise created up front.
  const eager = ALL.map((s) => (t.runners[s] as () => Promise<unknown>)());
  await Promise.allSettled(eager);
  assert(t.maxActive() > 1, "eager pattern overlaps stages");
  const jobEnd = t.events.indexOf("job_processing:end");
  const earlyMaintenanceStart = t.events.findIndex((e, i) => i < jobEnd && e.endsWith(":start") && !e.startsWith("job_processing"));
  assert(earlyMaintenanceStart >= 0, "eager pattern starts maintenance before job_processing finishes");
});

// ---------------------------------------------------------------------------
// C / D. Cadence through the real sequencer over a simulated day of cron ticks
// ---------------------------------------------------------------------------

test("C/D: 1440 cron ticks through the sequencer — jobs every tick, monitor/escalation 288x, cleanup detection/approved cleanup 24x", async () => {
  const counts: Record<string, number> = {};
  const runners = Object.fromEntries(ALL.map((s) => [s, async () => { counts[s] = (counts[s] ?? 0) + 1; }])) as StageRunners;
  const q = quietOptions();
  const start = Date.UTC(2026, 9, 15, 0, 0, 0);
  for (let i = 0; i < 1440; i++) await runBackgroundStages(runners, new Date(start + i * 60_000), q);
  eq(counts.job_processing, 1440, "job_processing every invocation");
  eq(counts.signal_monitoring, 288, "signal_monitoring every 5 min");
  eq(counts.alert_escalation, 288, "alert_escalation every 5 min");
  eq(counts.cleanup_detection, 24, "cleanup_detection hourly (not per-minute)");
  eq(counts.approved_cleanup, 24, "approved_cleanup hourly (not per-minute)");
  eq(q.failures.length, 0, "no failures");
});

// ---------------------------------------------------------------------------
// E. Failure isolation
// ---------------------------------------------------------------------------

test("E: job_processing REJECTION is reported, does not throw, and the due maintenance stage is still attempted after it", async () => {
  const t = tracer({ throwIn: { job_processing: "reject" } });
  const q = quietOptions();
  const summary = await runBackgroundStages(t.runners, at(17), q);
  deepEq(summary.attempted, ["job_processing", "cleanup_detection"], "attempted");
  deepEq(summary.failed, ["job_processing"], "failed");
  eq(q.failures.length, 1, "one failure reported");
  eq(q.failures[0].stage, "job_processing", "failure attributed to job_processing");
  // CPU-priority contract still holds: maintenance only after the failed job stage settled.
  assert(t.events.indexOf("cleanup_detection:start") > t.events.indexOf("job_processing:end"), "maintenance starts after job_processing settled");
});

test("E: job_processing SYNCHRONOUS throw is isolated the same way", async () => {
  const t = tracer({ throwIn: { job_processing: "sync" } });
  const q = quietOptions();
  const summary = await runBackgroundStages(t.runners, at(3), q);
  deepEq(summary.attempted, ["job_processing", "alert_escalation"], "attempted");
  deepEq(summary.failed, ["job_processing"], "failed");
  assert(t.events.includes("alert_escalation:end"), "escalation ran to completion");
});

test("E: a failing maintenance stage does not block a later due stage (all forced due)", async () => {
  const t = tracer({ throwIn: { approved_cleanup: "reject" } });
  const q = quietOptions();
  const summary = await runBackgroundStages(t.runners, at(0), { ...q, isDue: () => true });
  deepEq(summary.attempted, ALL, "every stage attempted");
  deepEq(summary.failed, ["approved_cleanup"], "only approved_cleanup failed");
  assert(t.events.includes("cleanup_detection:end"), "cleanup_detection still ran after the failure");
});

test("E: the runner never throws, even if every stage fails and the failure reporter itself throws", async () => {
  const t = tracer({
    throwIn: {
      job_processing: "reject", signal_monitoring: "sync", alert_escalation: "reject",
      approved_cleanup: "sync", cleanup_detection: "reject",
    },
  });
  const summary = await runBackgroundStages(t.runners, at(0), {
    isDue: () => true,
    onFailure: () => { throw new Error("reporter exploded"); },
  });
  deepEq(summary.failed, ALL, "all five recorded as failed");
});

test("E: default failure log is safe — stage + error class + truncated message, never the raw error/stack", () => {
  const original = console.error;
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => { calls.push(args); };
  try {
    logStageFailure("cleanup_detection", new TypeError("x".repeat(500)));
    logStageFailure("job_processing", "plain string thrown");
    logStageFailure("alert_escalation", null);
  } finally {
    console.error = original;
  }
  eq(calls.length, 3, "three log lines");
  for (const args of calls) {
    eq(args[0], "atlas_background_stage_failed", "stable event name");
    eq(args.length, 2, "event name + one structured payload (no raw error argument)");
    const payload = args[1] as Record<string, unknown>;
    assert(!("stack" in payload) && !("error" in payload) && !("reason" in payload), "no raw error/stack in payload");
  }
  const first = calls[0][1] as { stage: string; error_name: string; error_message: string };
  eq(first.stage, "cleanup_detection", "stage");
  eq(first.error_name, "TypeError", "error class");
  eq(first.error_message.length, 120, "message truncated to 120 chars");
  eq((calls[1][1] as { error_name: string }).error_name, "UnknownError", "non-Error throw");
  eq((calls[2][1] as { error_name: string }).error_name, "UnknownError", "null throw");
});

// ---------------------------------------------------------------------------
// Wiring + safety invariants (source-structure; see header comment)
// ---------------------------------------------------------------------------

const BACKGROUND_SRC = readFileSync(resolve(process.cwd(), "worker/src/phase4-background.ts"), "utf8");
const INDEX_SRC = readFileSync(resolve(process.cwd(), "worker/src/index.ts"), "utf8");
const WRANGLER = readFileSync(resolve(process.cwd(), "worker/wrangler.toml"), "utf8");

function runnerBody(): string {
  const start = BACKGROUND_SRC.indexOf("export async function runBackgroundMaintenance");
  assert(start >= 0, "runBackgroundMaintenance exists");
  return BACKGROUND_SRC.slice(start);
}

test("wiring: runBackgroundMaintenance hands lazy thunks to runBackgroundStages and never uses Promise.all/allSettled", () => {
  const body = runnerBody();
  assert(body.includes("runBackgroundStages("), "uses the sequencer");
  assert(!/Promise\.(all|allSettled|race|any)\s*\(/.test(body), "no concurrent combinator in the runner");
  assert(/job_processing:\s*\(\)\s*=>\s*processQueuedJobs\(env\)/.test(body), "job_processing thunk");
  assert(/signal_monitoring:\s*\(\)\s*=>\s*monitorSignals\(env,\s*adminClient\(env\)\)/.test(body), "signal_monitoring thunk");
  assert(/alert_escalation:\s*\(\)\s*=>\s*escalateAlerts\(env,\s*adminClient\(env\)\)/.test(body), "alert_escalation thunk");
  assert(/approved_cleanup:\s*\(\)\s*=>\s*processApprovedCleanup\(env,\s*adminClient\(env\)\)/.test(body), "approved_cleanup thunk");
  assert(/cleanup_detection:\s*\(\)\s*=>\s*detectCleanupCandidates\(env,\s*adminClient\(env\)\)/.test(body), "cleanup_detection thunk");
});

test("wiring: each stage function is referenced only by its declaration and its lazy thunk (no eager call sites)", () => {
  for (const fn of ["processQueuedJobs", "monitorSignals", "escalateAlerts", "processApprovedCleanup", "detectCleanupCandidates"]) {
    const occurrences = (BACKGROUND_SRC.match(new RegExp(`\\b${fn}\\(`, "g")) ?? []).length;
    eq(occurrences, 2, `${fn}( occurrences (declaration + thunk)`);
  }
});

test("wiring: scheduled() passes event.scheduledTime to the runner and leaves the Graph intake waitUntil untouched", () => {
  assert(/runBackgroundMaintenance\(env,\s*event\.scheduledTime\)/.test(INDEX_SRC), "scheduledTime forwarded");
  assert(/ctx\.waitUntil\(runGraphIntakeCycleForEnv\(env\)/.test(INDEX_SRC), "Graph intake scheduling unchanged");
});

test("safety: processApprovedCleanup still refuses to delete in production unless ATLAS_CLEANUP_APPROVED === 'true' (before any DB/storage work)", () => {
  const start = BACKGROUND_SRC.indexOf("async function processApprovedCleanup");
  assert(start >= 0, "processApprovedCleanup exists");
  const body = BACKGROUND_SRC.slice(start);
  const gate = body.indexOf('if (env.ATLAS_ENV === "production" && env.ATLAS_CLEANUP_APPROVED !== "true") return;');
  assert(gate >= 0, "production approval gate present");
  const firstQuery = body.indexOf('.from("atlas_cleanup_candidates")');
  const firstDelete = body.indexOf(".remove(");
  assert(firstQuery > 0 && firstDelete > 0, "candidate query and storage delete located");
  assert(gate < firstQuery && gate < firstDelete, "gate precedes the candidate query and every storage delete");
  assert(body.includes('.eq("status", "approved")'), "only manager-approved candidates are processed");
});

test("safety: cleanup reference revalidation and active-document protection are intact", () => {
  for (const marker of [
    "findActiveStorageReference(",
    "cleanup_reference_check_failed",
    "storage_path_now_referenced",
    "active_document_protected",
    "Reference lookup failed; deletion refused for safety.",
  ]) {
    assert(BACKGROUND_SRC.includes(marker), `phase4-background.ts still contains ${marker}`);
  }
});

test("safety: stuck-job recovery semantics unchanged (20-minute default, stuck_timeout preserved)", () => {
  assert(BACKGROUND_SRC.includes('env.ATLAS_STUCK_JOB_MINUTES ?? "20"'), "20-minute code default");
  assert(BACKGROUND_SRC.includes('error_code: "stuck_timeout"'), "stuck_timeout still recorded");
  assert(/ATLAS_STUCK_JOB_MINUTES = "20"/.test(WRANGLER), "wrangler production threshold still 20");
});

test("safety: cron expression and production cleanup flag are unchanged in wrangler.toml", () => {
  const crons = WRANGLER.match(/crons = \[[^\]]*\]/g) ?? [];
  eq(crons.length, 2, "two cron declarations (default + production)");
  for (const c of crons) eq(c, 'crons = ["* * * * *"]', "cron expression unchanged");
  const approved = WRANGLER.match(/ATLAS_CLEANUP_APPROVED = "[^"]*"/g) ?? [];
  assert(approved.length >= 2 && approved.every((a) => a === 'ATLAS_CLEANUP_APPROVED = "false"'), 'ATLAS_CLEANUP_APPROVED stays "false"');
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
console.log(`\n${tests.length - failures}/${tests.length} passed`);
if (failures > 0) process.exitCode = 1;
