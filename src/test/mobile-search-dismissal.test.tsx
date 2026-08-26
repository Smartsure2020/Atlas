/**
 * AppShell mobile expand-search — dismissal + focus regressions.
 * ----------------------------------------------------------------------------
 * The expand-search sheet previously depended on onBlur+empty-field to
 * dismiss, meaning Escape did not work, focus was never restored to the
 * trigger, and the sheet could not be closed while it held a query. This
 * test covers the new contract:
 *
 *   - opening moves focus into the input;
 *   - Escape dismisses even when the field is non-empty;
 *   - the explicit close button dismisses;
 *   - closing restores focus to the trigger;
 *   - no external write is issued by dismissal itself.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { AppShell } from "../components/AppShell";

function Harness() {
  const [search, setSearch] = useState("");
  return (
    <AppShell
      route={{ name: "queue" }}
      role="underwriter"
      email="user@example.com"
      onNavigate={() => undefined}
      onSignOut={() => undefined}
      onSearch={setSearch}
      searchValue={search}
    >
      <p>content</p>
    </AppShell>
  );
}

describe("AppShell — mobile search dismissal", () => {
  it("Escape closes the sheet even with a non-empty query and restores focus", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: /Search submissions/i });
    await user.click(trigger);
    // After opening, focus should be inside the input.
    const input = screen.getByRole("searchbox");
    expect(document.activeElement).toBe(input);
    await user.type(input, "acme");
    await user.keyboard("{Escape}");
    // The trigger's label changes back to "Search submissions" — no
    // "Close search" trigger label means the sheet is closed.
    expect(
      screen.queryByRole("button", { name: /Close search$/ })
    ).not.toBeInTheDocument();
    // Focus restored to the search trigger.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /Search submissions/i })
    );
  });

  it("explicit Close button dismisses the sheet", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: /Search submissions/i });
    await user.click(trigger);
    // Two "Close search" controls exist while open (the trigger's aria-label
    // flips to "Close search" and the in-sheet close button). Query the
    // in-sheet button by its class.
    const closeButton = document.querySelector(".atlas-topbar__search-close") as HTMLButtonElement;
    expect(closeButton).toBeTruthy();
    await user.click(closeButton);
    expect(
      screen.queryByRole("button", { name: /^Close search$/ })
    ).not.toBeInTheDocument();
  });

  it("dismissal does not clear the query (no write to onSearch)", async () => {
    const onSearch = vi.fn();
    function LocalHarness() {
      const [value, setValue] = useState("");
      return (
        <AppShell
          route={{ name: "queue" }}
          role="underwriter"
          email={null}
          onNavigate={() => undefined}
          onSignOut={() => undefined}
          onSearch={(next) => {
            onSearch(next);
            setValue(next);
          }}
          searchValue={value}
        >
          <p>content</p>
        </AppShell>
      );
    }
    const user = userEvent.setup();
    render(<LocalHarness />);
    const trigger = screen.getByRole("button", { name: /Search submissions/i });
    await user.click(trigger);
    const input = screen.getByRole("searchbox");
    await user.type(input, "acme");
    onSearch.mockClear();
    await user.keyboard("{Escape}");
    // Dismissal must not fire onSearch (no clearing).
    expect(onSearch).not.toHaveBeenCalled();
  });
});
