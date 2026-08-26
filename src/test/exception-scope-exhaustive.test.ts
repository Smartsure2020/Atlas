/**
 * ExceptionScope exhaustive-handling regression.
 * ----------------------------------------------------------------------------
 * When a new member is added to the ExceptionScope union, every renderer
 * must be updated in lockstep. `exceptionScopeSuffix` is the single
 * choke point that guarantees this via a `never` guard on the default
 * case; this test iterates every scope value and asserts it produces a
 * non-empty, distinguishable suffix.
 */

import { describe, expect, it } from "vitest";
import { exceptionScopeSuffix, type ExceptionScope } from "../lib/oversight";

const ALL_SCOPES: ExceptionScope[] = ["period", "recent", "period_capped"];

describe("exceptionScopeSuffix", () => {
  it.each(ALL_SCOPES)("returns a non-empty label for %s", (scope) => {
    const label = exceptionScopeSuffix(scope, "Last 30 days");
    expect(label).toBeTruthy();
    expect(label.length).toBeGreaterThan(0);
  });

  it("distinguishes period from period_capped", () => {
    const p = exceptionScopeSuffix("period", "Last 30 days");
    const c = exceptionScopeSuffix("period_capped", "Last 30 days");
    expect(p).not.toBe(c);
  });

  it("period_capped explicitly names the cap", () => {
    const c = exceptionScopeSuffix("period_capped", "Last 30 days");
    expect(c.toLowerCase()).toContain("capped");
  });

  it("recent does not mention the period label", () => {
    const r = exceptionScopeSuffix("recent", "This week");
    expect(r.toLowerCase()).not.toContain("this week");
  });
});
