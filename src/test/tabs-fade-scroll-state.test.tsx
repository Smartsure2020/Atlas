/**
 * Horizontal fade — scroll-state regression.
 * ----------------------------------------------------------------------------
 * The mask on `.atlas-tabs` and `.atlas-timeline__filterbar` previously
 * faded the right edge unconditionally, which permanently shadowed the
 * last tab even when the reader had scrolled fully to the end.
 * `useHorizontalFade` now sets `--fade-right` to `1` only while there
 * is still content beyond the viewport and `0` at the scroll end.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useRef } from "react";
import { useHorizontalFade } from "../components/ui";

class RO {
  observe() {}
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: RO,
  });
});

function Strip({
  scrollWidth,
  clientWidth,
  scrollLeft,
}: {
  scrollWidth: number;
  clientWidth: number;
  scrollLeft: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useHorizontalFade(ref);
  return (
    <div
      ref={(node) => {
        if (node) {
          Object.defineProperty(node, "scrollWidth", { configurable: true, value: scrollWidth });
          Object.defineProperty(node, "clientWidth", { configurable: true, value: clientWidth });
          Object.defineProperty(node, "scrollLeft", { configurable: true, value: scrollLeft, writable: true });
        }
        ref.current = node;
      }}
      data-testid="strip"
    >
      <span>tab 1</span>
      <span>tab 2</span>
    </div>
  );
}

function readFade(node: HTMLElement | null): string | null {
  return node?.style.getPropertyValue("--fade-right") ?? null;
}

describe("useHorizontalFade", () => {
  it("sets --fade-right=0 when the strip does not overflow", () => {
    const { getByTestId } = render(
      <Strip scrollWidth={200} clientWidth={200} scrollLeft={0} />
    );
    expect(readFade(getByTestId("strip"))).toBe("0");
  });

  it("sets --fade-right=1 when overflowing and not scrolled to the end", () => {
    const { getByTestId } = render(
      <Strip scrollWidth={1000} clientWidth={300} scrollLeft={0} />
    );
    expect(readFade(getByTestId("strip"))).toBe("1");
  });

  it("sets --fade-right=0 when scrolled fully to the end", () => {
    const { getByTestId } = render(
      <Strip scrollWidth={1000} clientWidth={300} scrollLeft={700} />
    );
    expect(readFade(getByTestId("strip"))).toBe("0");
  });

  it("restores --fade-right=1 when scrolling left again", () => {
    const { getByTestId } = render(
      <Strip scrollWidth={1000} clientWidth={300} scrollLeft={700} />
    );
    const strip = getByTestId("strip");
    expect(readFade(strip)).toBe("0");
    // Simulate a scroll-left event.
    Object.defineProperty(strip, "scrollLeft", { configurable: true, value: 100, writable: true });
    act(() => {
      strip.dispatchEvent(new Event("scroll"));
    });
    expect(readFade(strip)).toBe("1");
  });
});
