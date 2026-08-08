/**
 * ColumnPicker behaviour tests.
 * Radix owns most of the accessibility contract; these tests prove the Atlas
 * wiring actually delivers it: opening from the trigger, focus-into-panel,
 * Escape closes and restores focus, outside pointer closes, keyboard reaches
 * every option, and toggling actually changes the hidden list.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { ColumnPicker, type Column } from "../components/DataTable";

interface Row {
  id: string;
  a: string;
  b: string;
  c: string;
}

const OPTIONAL_COLUMNS: Column<Row>[] = [
  { id: "a", header: "Alpha", cell: (row) => row.a, optional: true },
  { id: "b", header: "Beta", cell: (row) => row.b, optional: true },
  { id: "c", header: "Gamma", cell: (row) => row.c, optional: true },
];

function Harness({ onChange }: { onChange?: (hidden: string[]) => void }) {
  const [hidden, setHidden] = useState<string[]>([]);
  return (
    <ColumnPicker
      columns={OPTIONAL_COLUMNS}
      hidden={hidden}
      onChange={(next) => {
        setHidden(next);
        onChange?.(next);
      }}
    />
  );
}

describe("ColumnPicker", () => {
  it("does not render if there are no optional columns", () => {
    render(
      <ColumnPicker
        columns={[
          { id: "x", header: "X", cell: () => null },
        ]}
        hidden={[]}
        onChange={() => undefined}
      />
    );
    expect(screen.queryByRole("button", { name: /columns/i })).toBeNull();
  });

  it("opens from the trigger and reveals every optional column", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: /columns/i });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await user.click(trigger);
    await waitFor(() => {
      expect(trigger).toHaveAttribute("aria-expanded", "true");
    });
    expect(screen.getByLabelText("Alpha")).toBeInTheDocument();
    expect(screen.getByLabelText("Beta")).toBeInTheDocument();
    expect(screen.getByLabelText("Gamma")).toBeInTheDocument();
  });

  it("moves focus into the panel on open", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: /columns/i });
    await user.click(trigger);
    await waitFor(() => {
      // Radix moves focus into the content region; the trigger no longer
      // holds document focus once the popover opens.
      expect(document.activeElement).not.toBe(trigger);
      expect(trigger.contains(document.activeElement)).toBe(false);
    });
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: /columns/i });
    await user.click(trigger);
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "true"));

    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on outside pointer interaction", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <Harness />
        <button type="button">outside</button>
      </div>
    );
    const trigger = screen.getByRole("button", { name: /columns/i });
    await user.click(trigger);
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "true"));

    await user.click(screen.getByRole("button", { name: "outside" }));
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
  });

  it("toggles a column visibility on and off", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /columns/i }));
    const beta = await screen.findByLabelText("Beta");

    await user.click(beta);
    expect(onChange).toHaveBeenLastCalledWith(["b"]);

    await user.click(beta);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("keyboard traversal reaches every option", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: /columns/i });
    await user.click(trigger);
    await screen.findByLabelText("Alpha");

    const alpha = screen.getByLabelText("Alpha") as HTMLInputElement;
    const beta = screen.getByLabelText("Beta") as HTMLInputElement;
    const gamma = screen.getByLabelText("Gamma") as HTMLInputElement;

    alpha.focus();
    expect(document.activeElement).toBe(alpha);
    await user.tab();
    expect(document.activeElement).toBe(beta);
    await user.tab();
    expect(document.activeElement).toBe(gamma);
  });
});
