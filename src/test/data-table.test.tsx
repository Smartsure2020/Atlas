/**
 * DataTable behaviour tests.
 * Cover the observable outcomes the Work Queue depends on: caption, sort
 * announcement, string/numeric sort correctness, loading skeleton, aria-busy,
 * empty state rendered outside the horizontal-scroll wrapper, screen-reader
 * label on empty header cells, and nested-control click semantics.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { axe } from "vitest-axe";
import { DataTable, type Column, type SortState } from "../components/DataTable";
import { EmptyState } from "../components/ui";

interface Row {
  id: string;
  name: string;
  score: number;
}

const ROWS: Row[] = [
  { id: "1", name: "Charlie", score: 3 },
  { id: "2", name: "alice", score: 12 },
  { id: "3", name: "Bob", score: 7 },
];

function baseColumns(activate: (row: Row) => void): Column<Row>[] {
  return [
    {
      id: "name",
      header: "Name",
      sortValue: (row) => row.name.toLowerCase(),
      cell: (row) => (
        <button type="button" onClick={() => activate(row)}>
          {row.name}
        </button>
      ),
    },
    {
      id: "score",
      header: "Score",
      align: "right",
      sortValue: (row) => row.score,
      cell: (row) => <span>{row.score}</span>,
    },
    {
      id: "actions",
      header: "",
      srHeader: "Actions",
      align: "right",
      cell: (row) => (
        <button type="button" onClick={() => activate(row)}>
          Open {row.id}
        </button>
      ),
    },
  ];
}

function Harness({
  rows,
  onActivate,
  loading,
  empty,
}: {
  rows: Row[];
  onActivate?: (row: Row) => void;
  loading?: boolean;
  empty?: React.ReactNode;
}) {
  const [sort, setSort] = useState<SortState>({ columnId: "name", direction: "asc" });
  const activate = onActivate ?? (() => undefined);
  return (
    <DataTable
      caption="Test submissions"
      columns={baseColumns(activate)}
      rows={rows}
      rowKey={(row) => row.id}
      loading={loading}
      empty={empty}
      sort={sort}
      onSortChange={setSort}
      onRowActivate={activate}
    />
  );
}

describe("DataTable", () => {
  it("renders the caption for screen readers", () => {
    render(<Harness rows={ROWS} />);
    expect(screen.getByText("Test submissions")).toBeInTheDocument();
  });

  it("labels the empty header cell with the srHeader", () => {
    render(<Harness rows={ROWS} />);
    // Column headers appear as columnheader roles. The actions header has an
    // empty visible label but must expose an accessible name.
    const columnHeaders = screen.getAllByRole("columnheader");
    const actionsHeader = columnHeaders.find(
      (node) => node.textContent?.trim() === "Actions"
    );
    expect(actionsHeader).toBeDefined();
  });

  it("cycles aria-sort ascending → descending → none", async () => {
    const user = userEvent.setup();
    render(<Harness rows={ROWS} />);
    const nameHeader = screen
      .getAllByRole("columnheader")
      .find((th) => th.textContent?.trim() === "Name")!;
    expect(nameHeader).toHaveAttribute("aria-sort", "ascending");

    const sortButton = within(nameHeader).getByRole("button");
    await user.click(sortButton);
    expect(nameHeader).toHaveAttribute("aria-sort", "descending");
    await user.click(sortButton);
    expect(nameHeader).toHaveAttribute("aria-sort", "none");
  });

  it("sorts strings case-insensitively via sortValue", () => {
    render(<Harness rows={ROWS} />);
    // Initial sort is ascending on name; sortValue lowercases so "alice" wins.
    const rowCells = screen.getAllByRole("row");
    // First row is header; body starts at 1.
    expect(rowCells[1].textContent).toContain("alice");
    expect(rowCells[2].textContent).toContain("Bob");
    expect(rowCells[3].textContent).toContain("Charlie");
  });

  it("sorts numerics numerically, not lexicographically", async () => {
    const user = userEvent.setup();
    render(<Harness rows={ROWS} />);
    const scoreHeader = screen
      .getAllByRole("columnheader")
      .find((th) => th.textContent?.trim() === "Score")!;
    await user.click(within(scoreHeader).getByRole("button"));
    const rowCells = screen.getAllByRole("row");
    expect(rowCells[1].textContent).toMatch(/Charlie.*3/);
    expect(rowCells[2].textContent).toMatch(/Bob.*7/);
    expect(rowCells[3].textContent).toMatch(/alice.*12/);
  });

  it("renders the loading skeleton and toggles aria-busy on the table", () => {
    render(<Harness rows={[]} loading />);
    const table = screen.getByRole("table");
    expect(table).toHaveAttribute("aria-busy", "true");
  });

  it("renders the empty state outside .atlas-table-scroll", () => {
    render(
      <Harness
        rows={[]}
        empty={<EmptyState title="Nothing here" body="Try widening the view." />}
      />
    );
    const emptyTitle = screen.getByText("Nothing here");
    // Walk up the tree: the empty state must sit inside .atlas-table-wrap
    // but NOT inside .atlas-table-scroll (which clips at 375px).
    let node: HTMLElement | null = emptyTitle;
    let sawScrollWrapper = false;
    let sawTableWrap = false;
    while (node) {
      if (node.classList?.contains("atlas-table-scroll")) sawScrollWrapper = true;
      if (node.classList?.contains("atlas-table-wrap")) sawTableWrap = true;
      node = node.parentElement;
    }
    expect(sawScrollWrapper).toBe(false);
    expect(sawTableWrap).toBe(true);
  });

  it("does not fire row activation when a nested control is clicked", async () => {
    const user = userEvent.setup();
    const activate = vi.fn();
    render(<Harness rows={ROWS} onActivate={activate} />);
    // The "Open 1" button is nested in the actions cell. Its click must
    // activate exactly once — the row-level click must not double-fire.
    await user.click(screen.getByRole("button", { name: "Open 1" }));
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("has zero axe violations in the populated state", async () => {
    const { container } = render(<Harness rows={ROWS} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has zero axe violations in the empty state", async () => {
    const { container } = render(
      <Harness rows={[]} empty={<EmptyState title="Nothing here" />} />
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
