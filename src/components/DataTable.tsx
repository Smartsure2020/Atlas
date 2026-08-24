/**
 * Atlas — data table
 * ----------------------------------------------------------------------------
 * One accessible table implementation for every operational list in the
 * product. Real <table> semantics, sortable headers that announce their state,
 * sticky header, skeletons shaped like the final rows, and explicit empty and
 * error states.
 *
 * Row interaction model, applied consistently everywhere:
 *   - the identifying cell is a link-style button that opens the full record
 *   - clicking elsewhere on the row opens a preview, when the screen offers one
 *   - explicit actions live in a final actions column, never hidden behind an
 *     overflow menu alone
 */

import { useMemo, type ReactNode } from "react";
import { Icon } from "./Icon";
import { EmptyState, TableSkeleton } from "./ui";

export interface Column<T> {
  id: string;
  header: string;
  /**
   * Screen-reader-only header text used when `header` is empty (e.g. the
   * row-actions column). Defaults to "Actions".
   */
  srHeader?: string;
  /** Cell content. Keep it to what the user decides from in this view. */
  cell: (row: T) => ReactNode;
  /** Provide to make the column sortable. */
  sortValue?: (row: T) => string | number;
  align?: "left" | "right";
  width?: string;
  /** Columns the user can hide; omitted columns are always visible. */
  optional?: boolean;
  defaultHidden?: boolean;
}

export type SortState = { columnId: string; direction: "asc" | "desc" } | null;

interface DataTableProps<T> {
  /** Describes the table for screen readers. */
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  /** Rendered in place of the body when there are no rows. */
  empty?: ReactNode;
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  onRowActivate?: (row: T) => void;
  rowAttention?: (row: T) => boolean;
  selectedKey?: string | null;
  dense?: boolean;
  /** Footer content, e.g. a result count or pagination. */
  footer?: ReactNode;
  hiddenColumns?: string[];
  /**
   * At narrow viewports the leading column stays pinned to the left of
   * the scroll container so the identifying label (Client, insurer name,
   * job name) stays visible while the reader pages across the rest of
   * the row. The rest of the columns scroll under it as usual — this
   * is scoped to the mobile breakpoint via CSS.
   */
  stickyFirstColumn?: boolean;
}

export function DataTable<T>({
  caption,
  columns,
  rows,
  rowKey,
  loading,
  empty,
  sort,
  onSortChange,
  onRowActivate,
  rowAttention,
  selectedKey,
  dense,
  footer,
  hiddenColumns = [],
  stickyFirstColumn = false,
}: DataTableProps<T>) {
  const visibleColumns = useMemo(
    () => columns.filter((column) => !hiddenColumns.includes(column.id)),
    [columns, hiddenColumns]
  );

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((item) => item.id === sort.columnId);
    if (!column?.sortValue) return rows;
    const factor = sort.direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const left = column.sortValue!(a);
      const right = column.sortValue!(b);
      if (left === right) return 0;
      if (typeof left === "number" && typeof right === "number") return (left - right) * factor;
      return String(left).localeCompare(String(right), "en-ZA") * factor;
    });
  }, [rows, sort, columns]);

  function toggleSort(column: Column<T>) {
    if (!column.sortValue || !onSortChange) return;
    if (!sort || sort.columnId !== column.id) {
      onSortChange({ columnId: column.id, direction: "asc" });
    } else if (sort.direction === "asc") {
      onSortChange({ columnId: column.id, direction: "desc" });
    } else {
      onSortChange(null);
    }
  }

  const showEmpty = !loading && sorted.length === 0;

  // When the table has nothing to show, render the empty state OUTSIDE the
  // horizontal-scroll wrapper. Wide operational tables scroll horizontally on
  // narrow viewports, and putting the empty message inside that wrapper clips
  // its content at 375px (Gate 0B finding). Placing it in the surrounding
  // .atlas-table-wrap keeps it fully readable at every viewport.
  if (showEmpty) {
    return (
      <div className="atlas-table-wrap">
        <div role="status" aria-live="polite">
          {empty ?? (
            <EmptyState
              title="Nothing to show"
              body="No records match the current view."
            />
          )}
        </div>
        {footer && <div className="atlas-table__foot">{footer}</div>}
      </div>
    );
  }

  return (
    <div className="atlas-table-wrap">
      <div
        className="atlas-table-scroll"
        role="region"
        aria-label={`${caption} — scroll horizontally to see more columns`}
        // Focusable so screen-reader and keyboard users can horizontally
        // scroll the wide operational tables the same way pointer users
        // can. The role="region" + aria-label pair gives the scroll
        // container an announceable name; tabIndex=0 makes it a tab stop
        // only when the browser reports it as scrollable. The keydown
        // handler translates ←/→/Home/End into horizontal scroll so the
        // Client column stays visible while the reader pages across.
        tabIndex={0}
        onKeyDown={(event) => {
          const el = event.currentTarget;
          if (el.scrollWidth <= el.clientWidth) return;
          const step = Math.max(80, el.clientWidth * 0.6);
          if (event.key === "ArrowRight") {
            event.preventDefault();
            el.scrollBy({ left: step, behavior: "smooth" });
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            el.scrollBy({ left: -step, behavior: "smooth" });
          } else if (event.key === "Home") {
            event.preventDefault();
            el.scrollTo({ left: 0, behavior: "smooth" });
          } else if (event.key === "End") {
            event.preventDefault();
            el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
          }
        }}
      >
        <table
          className={[
            "atlas-table",
            "atlas-table--responsive",
            dense ? "atlas-table--dense" : "",
            stickyFirstColumn ? "atlas-table--sticky-first" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          aria-busy={loading ? true : undefined}
        >
          <caption className="atlas-sr-only">{caption}</caption>
          <thead>
            <tr>
              {visibleColumns.map((column) => {
                const isSorted = sort?.columnId === column.id;
                const ariaSort = isSorted
                  ? sort!.direction === "asc"
                    ? "ascending"
                    : "descending"
                  : column.sortValue
                  ? "none"
                  : undefined;
                // Columns without a visible header (row-actions column) still
                // need an accessible name — otherwise axe raises
                // empty-table-header and screen readers announce nothing.
                const hasHeader = column.header !== "";
                return (
                  <th
                    key={column.id}
                    scope="col"
                    style={column.width ? { width: column.width } : undefined}
                    data-align={column.align === "right" ? "right" : undefined}
                    aria-sort={ariaSort}
                  >
                    {column.sortValue ? (
                      <button
                        type="button"
                        className="atlas-table__sort"
                        onClick={() => toggleSort(column)}
                        title={`Sort by ${column.header}`}
                      >
                        <span>{column.header}</span>
                        <Icon
                          name={isSorted ? (sort!.direction === "asc" ? "sort-asc" : "sort-desc") : "sort"}
                          size={12}
                          className="atlas-table__sort-mark"
                        />
                      </button>
                    ) : hasHeader ? (
                      column.header
                    ) : (
                      <span className="atlas-sr-only">
                        {column.srHeader ?? "Actions"}
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>

          {loading ? (
            <TableSkeleton columns={visibleColumns.length} />
          ) : (
            <tbody>
              {sorted.map((row) => {
                const key = rowKey(row);
                return (
                  <tr
                    key={key}
                    data-attention={rowAttention?.(row) ? "true" : undefined}
                    data-selected={selectedKey === key ? "true" : undefined}
                    onClick={
                      onRowActivate
                        ? (event) => {
                            // Let genuine controls inside the row win the click.
                            const target = event.target as HTMLElement;
                            if (target.closest("button, a, input, select, textarea, summary")) return;
                            onRowActivate(row);
                          }
                        : undefined
                    }
                    style={onRowActivate ? { cursor: "pointer" } : undefined}
                  >
                    {visibleColumns.map((column) => (
                      <td
                        key={column.id}
                        data-align={column.align === "right" ? "right" : undefined}
                      >
                        {column.cell(row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          )}
        </table>
      </div>
      {footer && <div className="atlas-table__foot">{footer}</div>}
    </div>
  );
}

// ColumnPicker moved to src/components/ColumnPicker.tsx so consumers can
// React.lazy it — that way its @radix-ui/react-popover dependency
// (Popper positioning, focus-scope, portal, dismissable-layer, presence)
// only downloads when a screen with optional columns actually mounts.
// A static re-export from this file would pull the Radix chunk back into
// the DataTable module's graph, so we deliberately do not re-export.
