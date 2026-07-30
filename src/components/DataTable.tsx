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

import { useMemo, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { EmptyState, TableSkeleton } from "./ui";

export interface Column<T> {
  id: string;
  header: string;
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

  return (
    <div className="atlas-table-wrap">
      <div className="atlas-table-scroll">
        <table
          className={[
            "atlas-table",
            "atlas-table--responsive",
            dense ? "atlas-table--dense" : "",
          ]
            .filter(Boolean)
            .join(" ")}
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
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>

          {loading ? (
            <TableSkeleton columns={visibleColumns.length} />
          ) : showEmpty ? (
            <tbody>
              <tr>
                <td colSpan={visibleColumns.length} style={{ padding: 0 }}>
                  {empty ?? (
                    <EmptyState
                      title="Nothing to show"
                      body="No records match the current view."
                    />
                  )}
                </td>
              </tr>
            </tbody>
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

/**
 * Column visibility control. Only offered where a table has genuinely optional
 * columns — it is a power-user affordance, not decoration.
 */
export function ColumnPicker<T>({
  columns,
  hidden,
  onChange,
}: {
  columns: Column<T>[];
  hidden: string[];
  onChange: (hidden: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const optional = columns.filter((column) => column.optional);
  if (optional.length === 0) return null;

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        className="atlas-btn atlas-btn--sm"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="filter" size={13} />
        <span>Columns</span>
      </button>
      {open && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 40 }}
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            style={{
              position: "absolute",
              right: 0,
              top: "calc(100% + 4px)",
              zIndex: 41,
              minWidth: 210,
              padding: "var(--atlas-space-2)",
              background: "var(--atlas-surface)",
              border: "1px solid var(--atlas-border-strong)",
              borderRadius: "var(--atlas-radius-control)",
              boxShadow: "var(--atlas-shadow-md)",
            }}
            role="group"
            aria-label="Visible columns"
          >
            {optional.map((column) => {
              const isHidden = hidden.includes(column.id);
              return (
                <label
                  key={column.id}
                  className="atlas-checkbox"
                  style={{ minHeight: 28, width: "100%" }}
                >
                  <input
                    type="checkbox"
                    checked={!isHidden}
                    onChange={() =>
                      onChange(
                        isHidden
                          ? hidden.filter((id) => id !== column.id)
                          : [...hidden, column.id]
                      )
                    }
                  />
                  <span>{column.header}</span>
                </label>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
