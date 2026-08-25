/**
 * Drawer discard-state leak regression.
 * ----------------------------------------------------------------------------
 * If a Drawer is externally closed (open flips to false) while a discard
 * confirmation is pending, the leftover discardPending=true previously
 * caused the confirm dialog to flash on the NEXT open. The fix clears
 * discardPending in a useEffect scoped to the `open` transition, so a
 * reopened panel always starts clean.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Drawer, ToastProvider } from "../components/ui";

function Harness({ startDirty = true }: { startDirty?: boolean }) {
  const [open, setOpen] = useState(true);
  const [dirty] = useState(startDirty);
  return (
    <ToastProvider>
      <button type="button" onClick={() => setOpen(true)}>
        reopen
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        force close
      </button>
      <Drawer
        open={open}
        dirty={dirty}
        title="Some drawer"
        onClose={() => setOpen(false)}
      >
        <p>content</p>
      </Drawer>
    </ToastProvider>
  );
}

describe("Drawer — discardPending state", () => {
  it("clears the pending discard when the drawer is externally closed", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    // 1) Open + dirty. Click the drawer's own close button; because
    //    dirty=true, this opens the discard confirmation dialog.
    const closeButton = screen.getByRole("button", { name: /close panel/i });
    await user.click(closeButton);
    expect(
      screen.getByRole("heading", { name: /Discard your unsaved changes/i })
    ).toBeInTheDocument();

    // 2) Externally close the drawer (open -> false) BEFORE resolving
    //    the confirm dialog.
    await user.click(screen.getByRole("button", { name: "force close" }));
    // Both the drawer and the discard dialog should be gone.
    expect(
      screen.queryByRole("heading", { name: /Discard your unsaved changes/i })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("content")).not.toBeInTheDocument();

    // 3) Reopen the drawer. The discard dialog must NOT flash on this
    //    reopen — discardPending is expected to have been cleared.
    await user.click(screen.getByRole("button", { name: "reopen" }));
    expect(screen.getByText("content")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /Discard your unsaved changes/i })
    ).not.toBeInTheDocument();
  });
});
