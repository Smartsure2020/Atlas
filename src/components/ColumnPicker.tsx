/**
 * Column visibility control. Behaviour comes from the Atlas Popover wrapper:
 * aria-expanded on the trigger, focus moves into the panel on open, Escape
 * closes it, outside pointer closes it, focus returns to the trigger on
 * close, and Tab is scoped to the panel until it is closed.
 */

import { Icon } from "./Icon";
import { Popover, PopoverContent, PopoverTrigger } from "./Popover";
import type { Column } from "./DataTable";

export interface ColumnPickerProps<T> {
  columns: Column<T>[];
  hidden: string[];
  onChange: (hidden: string[]) => void;
}

export default function ColumnPicker<T>({
  columns,
  hidden,
  onChange,
}: ColumnPickerProps<T>) {
  const optional = columns.filter((column) => column.optional);
  if (optional.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="atlas-btn atlas-btn--sm">
          <Icon name="filter" size={13} />
          <span>Columns</span>
        </button>
      </PopoverTrigger>
      <PopoverContent aria-label="Visible columns">
        <div role="group" aria-label="Visible columns">
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
      </PopoverContent>
    </Popover>
  );
}
