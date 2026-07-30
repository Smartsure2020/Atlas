/**
 * Atlas — icon set
 * ----------------------------------------------------------------------------
 * A small hand-picked set drawn inline rather than a bundled icon library.
 * Roughly 4 KB of markup for the whole product versus tens of kilobytes for a
 * dependency, and it keeps stroke weight and optical size consistent.
 *
 * Icons are decorative by default (aria-hidden). Where an icon carries the only
 * meaning — an icon-only button, a status mark — the caller supplies a `title`
 * and the icon becomes an accessible image.
 */

export type IconName =
  | "queue"
  | "insurers"
  | "oversight"
  | "jobs"
  | "alerts"
  | "search"
  | "plus"
  | "close"
  | "chevron-right"
  | "chevron-down"
  | "chevron-up"
  | "arrow-right"
  | "arrow-up-right"
  | "check"
  | "check-circle"
  | "alert-triangle"
  | "x-circle"
  | "info"
  | "clock"
  | "minus-circle"
  | "refresh"
  | "copy"
  | "document"
  | "upload"
  | "filter"
  | "menu"
  | "panel-left"
  | "sign-out"
  | "help"
  | "edit"
  | "sort"
  | "sort-asc"
  | "sort-desc"
  | "user"
  | "external";

const PATHS: Record<IconName, JSX.Element> = {
  queue: (
    <>
      <rect x="2.75" y="3.75" width="10.5" height="2.5" rx="0.75" />
      <rect x="2.75" y="9.75" width="10.5" height="2.5" rx="0.75" />
    </>
  ),
  insurers: (
    <>
      <path d="M8 2.25 13.25 4.5v3.75c0 3-2.2 5.3-5.25 6.25C4.95 13.55 2.75 11.25 2.75 8.25V4.5Z" />
      <path d="M6 8.1 7.4 9.5 10.2 6.7" />
    </>
  ),
  oversight: (
    <>
      <path d="M2.5 13.25V7.5M6.5 13.25V3.5M10.5 13.25v-4M14 13.25V5.75" />
    </>
  ),
  jobs: (
    <>
      <circle cx="8" cy="8" r="5.25" />
      <path d="M8 5.25V8l1.9 1.4" />
    </>
  ),
  alerts: (
    <>
      <path d="M8 2.25c-2.1 0-3.5 1.6-3.5 3.6 0 2.9-1 4-1 4h9s-1-1.1-1-4c0-2-1.4-3.6-3.5-3.6Z" />
      <path d="M6.6 12.1a1.5 1.5 0 0 0 2.8 0" />
    </>
  ),
  search: (
    <>
      <circle cx="7.2" cy="7.2" r="4.4" />
      <path d="m10.6 10.6 3 3" />
    </>
  ),
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  close: <path d="m4 4 8 8M12 4l-8 8" />,
  "chevron-right": <path d="m6.25 3.5 4.5 4.5-4.5 4.5" />,
  "chevron-down": <path d="m3.5 6.25 4.5 4.5 4.5-4.5" />,
  "chevron-up": <path d="m3.5 9.75 4.5-4.5 4.5 4.5" />,
  "arrow-right": <path d="M3 8h10m-4-4 4 4-4 4" />,
  "arrow-up-right": <path d="M5 11 11 5m0 0H6.2M11 5v4.8" />,
  check: <path d="m3.5 8.4 3 3 6-6.8" />,
  "check-circle": (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="m5.6 8.2 1.7 1.7 3.2-3.6" />
    </>
  ),
  "alert-triangle": (
    <>
      <path d="M8 2.9 14 13H2Z" />
      <path d="M8 6.6v3M8 11.3v.1" />
    </>
  ),
  "x-circle": (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="m6.1 6.1 3.8 3.8M9.9 6.1l-3.8 3.8" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 7.4v3.2M8 5.3v.1" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5.2V8l2 1.4" />
    </>
  ),
  "minus-circle": (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.6 8h4.8" />
    </>
  ),
  refresh: (
    <>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13.2 2.9v2.6h-2.6" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.2" />
      <path d="M10.5 5.5v-1a1.2 1.2 0 0 0-1.2-1.2H4.2A1.2 1.2 0 0 0 3 4.5v5.1a1.2 1.2 0 0 0 1.2 1.2h1.3" />
    </>
  ),
  document: (
    <>
      <path d="M9 2.75H4.9a1.15 1.15 0 0 0-1.15 1.15v8.2A1.15 1.15 0 0 0 4.9 13.25h6.2a1.15 1.15 0 0 0 1.15-1.15V5.75Z" />
      <path d="M9 2.75v3h3.25" />
    </>
  ),
  upload: (
    <>
      <path d="M8 10.5V3.2m0 0L5.3 5.9M8 3.2l2.7 2.7" />
      <path d="M3 10.8v1.3a1.2 1.2 0 0 0 1.2 1.2h7.6a1.2 1.2 0 0 0 1.2-1.2v-1.3" />
    </>
  ),
  filter: <path d="M2.75 4h10.5l-4 4.6v3.6l-2.5 1.2V8.6Z" />,
  menu: <path d="M2.75 4.5h10.5M2.75 8h10.5M2.75 11.5h10.5" />,
  "panel-left": (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.4" />
      <path d="M6.4 3v10" />
    </>
  ),
  "sign-out": (
    <>
      <path d="M6.2 13.25H4a1.2 1.2 0 0 1-1.2-1.2V3.95A1.2 1.2 0 0 1 4 2.75h2.2" />
      <path d="M10 11 13 8l-3-3M13 8H6.2" />
    </>
  ),
  help: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M6.5 6.4A1.6 1.6 0 0 1 9.6 7c0 1.1-1.6 1.3-1.6 2.3M8 11.4v.1" />
    </>
  ),
  edit: (
    <>
      <path d="M11.1 2.9a1.35 1.35 0 0 1 1.9 1.9l-7 7-2.5.6.6-2.5Z" />
    </>
  ),
  sort: <path d="M5.5 6.2 8 3.6l2.5 2.6M10.5 9.8 8 12.4l-2.5-2.6" />,
  "sort-asc": <path d="M5.5 6.8 8 4.2l2.5 2.6M8 4.4v7.4" />,
  "sort-desc": <path d="M10.5 9.2 8 11.8 5.5 9.2M8 11.6V4.2" />,
  user: (
    <>
      <circle cx="8" cy="6" r="2.5" />
      <path d="M3.4 13.2a4.8 4.8 0 0 1 9.2 0" />
    </>
  ),
  external: (
    <>
      <path d="M9.5 3.2h3.3v3.3" />
      <path d="M12.8 3.2 7.6 8.4" />
      <path d="M11.4 9.6v2.6a1.05 1.05 0 0 1-1.05 1.05H3.85A1.05 1.05 0 0 1 2.8 12.2V5.7a1.05 1.05 0 0 1 1.05-1.05h2.6" />
    </>
  ),
};

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  /** Supply when the icon is the only carrier of meaning. */
  title?: string;
  strokeWidth?: number;
}

export function Icon({ name, size = 16, className, title, strokeWidth = 1.5 }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      style={{ flex: "none" }}
    >
      {title && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  );
}

/** The mark a status badge uses for its tone, so state never relies on colour. */
export const TONE_ICON: Record<string, IconName> = {
  success: "check-circle",
  info: "info",
  neutral: "minus-circle",
  warning: "alert-triangle",
  referral: "arrow-up-right",
  danger: "x-circle",
};
