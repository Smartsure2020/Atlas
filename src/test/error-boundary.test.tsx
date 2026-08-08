/**
 * ErrorBoundary — proves a throwing child produces the recoverable
 * ErrorState UI instead of a blank application.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "../components/ErrorBoundary";

function BoomOnRender(): JSX.Element {
  throw new Error("intentional test failure");
}

describe("ErrorBoundary", () => {
  it("renders the children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>All good</p>
      </ErrorBoundary>
    );
    expect(screen.getByText("All good")).toBeInTheDocument();
  });

  it("shows the recovery UI when a child throws", () => {
    // React logs the caught error to console.error; silence it just for
    // this render so the test output stays clean.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <ErrorBoundary>
        <BoomOnRender />
      </ErrorBoundary>
    );

    expect(
      screen.getByText(/atlas ran into an unexpected error/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /reload atlas/i })
    ).toBeInTheDocument();
    // The boundary presents itself as an alert region so screen readers
    // announce the failure.
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    // The error message must not appear as raw text — the boundary shows a
    // human-readable explanation instead.
    expect(screen.queryByText(/intentional test failure/i)).not.toBeInTheDocument();

    consoleError.mockRestore();
  });
});
