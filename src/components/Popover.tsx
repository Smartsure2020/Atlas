/**
 * Atlas — Popover
 * ----------------------------------------------------------------------------
 * A very thin Atlas skin over @radix-ui/react-popover. The value the wrapper
 * adds is:
 *
 *   1. Standard Atlas visual chrome — surface, border, radius, shadow, padding
 *      taken from the design tokens so the popover reads as part of the same
 *      system as menus, cards and drawers.
 *   2. Predictable defaults — bottom placement, small offset, and end
 *      alignment. Consumers can override per surface.
 *
 * Radix owns the important behaviour (aria-expanded on the trigger, focus
 * moves in on open, focus returns to the trigger on close, Escape closes,
 * outside pointer closes, focus-scope prevents Tab escaping into the page
 * behind it), and we do not re-implement or wrap those.
 *
 * Portal note: content is portalled to document.body by Radix's default.
 * Nothing in Atlas styling is scoped as `.atlas-shell .atlas-*` (verified in
 * src/styles), so portalled content still receives the correct
 * `--atlas-*` custom properties from :root and every widget class resolves.
 */

import * as PopoverPrimitive from "@radix-ui/react-popover";
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverClose = PopoverPrimitive.Close;

export const PopoverContent = forwardRef<
  ElementRef<typeof PopoverPrimitive.Content>,
  ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(function PopoverContent(
  { align = "end", sideOffset = 4, className, style, ...rest },
  ref
) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        sideOffset={sideOffset}
        className={["atlas-popover", className].filter(Boolean).join(" ")}
        style={{
          minWidth: 210,
          padding: "var(--atlas-space-2)",
          background: "var(--atlas-surface)",
          border: "1px solid var(--atlas-border-strong)",
          borderRadius: "var(--atlas-radius-control)",
          boxShadow: "var(--atlas-shadow-md)",
          color: "var(--atlas-ink)",
          font: "inherit",
          fontSize: "var(--atlas-fs-dense)",
          zIndex: "var(--atlas-z-overlay)" as unknown as number,
          ...style,
        }}
        {...rest}
      />
    </PopoverPrimitive.Portal>
  );
});
