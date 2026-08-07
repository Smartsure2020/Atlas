import {
  PHASE0_GOLDEN_SUBMISSIONS,
  type Phase0ControlOutcome,
} from "./fixtures/phase0-golden-submissions.js";


const tests: { name: string; fn: () => void }[] = [];

function test(name: string, fn: () => void) {
  tests.push({ name, fn });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

test("Phase 0 has at least ten golden submission scenarios", () => {
  assert(PHASE0_GOLDEN_SUBMISSIONS.length >= 10, "expected at least ten Phase 0 fixtures");
});

test("Phase 0 fixture ids are unique and stable", () => {
  const ids = PHASE0_GOLDEN_SUBMISSIONS.map((fixture) => fixture.id);
  assert(new Set(ids).size === ids.length, "fixture ids must be unique");
  assert(ids.every((id) => /^P0-\d{3}$/.test(id)), "fixture ids must use the P0-### format");
});

test("every fixture is inside the proposed pilot scope", () => {
  for (const fixture of PHASE0_GOLDEN_SUBMISSIONS) {
    assert(
      fixture.lineOfBusiness === "personal" || fixture.lineOfBusiness === "commercial",
      `${fixture.id} is outside personal/commercial pilot scope`
    );
    assert(fixture.scenario.length > 20, `${fixture.id} needs a meaningful scenario description`);
    assert(fixture.requiredControls.length > 0, `${fixture.id} needs at least one required control`);
  }
});

test("personal and commercial use the same golden workflow contract", () => {
  const lines = new Set(PHASE0_GOLDEN_SUBMISSIONS.map((fixture) => fixture.lineOfBusiness));
  assert(lines.has("personal"), "golden set must include personal risks");
  assert(lines.has("commercial"), "golden set must include commercial risks");
  for (const fixture of PHASE0_GOLDEN_SUBMISSIONS) {
    assert(fixture.expectedControlOutcome.length > 0, `${fixture.id} needs a shared control outcome`);
  }
});

test("golden fixtures cover every control outcome", () => {
  const outcomes = new Set(PHASE0_GOLDEN_SUBMISSIONS.map((fixture) => fixture.expectedControlOutcome));
  const expectedOutcomes: Phase0ControlOutcome[] = [
    "proceed_after_review",
    "request_information",
    "refer_for_authority",
    "decline_or_escalate",
    "manual_review_required",
  ];
  for (const expected of expectedOutcomes) {
    assert(outcomes.has(expected), `missing golden scenario for ${expected}`);
  }
});

let failures = 0;
for (const current of tests) {
  try {
    current.fn();
    console.log(`ok - ${current.name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${current.name}: ${(error as Error).message}`);
  }
}

process.exitCode = failures ? 1 : 0;
