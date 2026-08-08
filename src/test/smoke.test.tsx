/**
 * Gate 0 smoke test — proves the harness works, not product behaviour.
 * Deliberately trivial: DOM rendering, Testing Library queries, jest-dom
 * matchers, and the axe accessibility matcher, in one file.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";

function SmokeWidget() {
  return (
    <button type="button" aria-label="Smoke test button">
      Ready
    </button>
  );
}

describe("frontend test harness (Gate 0)", () => {
  it("renders into jsdom and Testing Library can query it", () => {
    render(<SmokeWidget />);
    expect(screen.getByRole("button", { name: "Smoke test button" })).toBeInTheDocument();
  });

  it("has zero axe violations", async () => {
    const { container } = render(<SmokeWidget />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
