/**
 * Atlas — display formatting
 * ----------------------------------------------------------------------------
 * South African conventions in one place: ZAR amounts, `29 Jul 2026` dates,
 * full timestamps for tooltips, and relative ages for queue scanning.
 *
 * Everything here is defensive: the API returns nullable fields throughout and
 * screens should render a readable placeholder rather than "null" or "NaN".
 */

const LOCALE = "en-ZA";

/** Em dash placeholder for a value the backend did not provide. */
export const EMPTY = "—";

export function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

/**
 * ZAR amount in the local convention: `R 1 250 000`. Cents are shown only when
 * the amount actually carries them, so premium tables stay scannable.
 */
export function formatZAR(value: number | string | null | undefined): string {
  const amount = typeof value === "string" ? Number(value) : value;
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return EMPTY;
  const hasCents = Math.round(amount * 100) % 100 !== 0;
  const formatted = new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  })
    .format(amount)
    // en-ZA groups with a (narrow) no-break space and a comma decimal
    // separator. Normalise the group separator to a plain space so it
    // renders identically across browsers and fonts.
    .replace(/[\u00A0\u202F\u2009]/g, " ");
  return `R ${formatted}`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  return new Intl.NumberFormat(LOCALE).format(value);
}

/** `29 Jul 2026` — the compact form used in tables and metadata rows. */
export function formatDate(value: string | null | undefined): string {
  if (isBlank(value)) return EMPTY;
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) return EMPTY;
  return new Intl.DateTimeFormat(LOCALE, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

/** `29 Jul 2026, 14:32` — for detail views and tooltips. */
export function formatDateTime(value: string | null | undefined): string {
  if (isBlank(value)) return EMPTY;
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) return EMPTY;
  return new Intl.DateTimeFormat(LOCALE, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/** Day heading used to group long activity histories. */
export function formatDayHeading(value: string | null | undefined): string {
  if (isBlank(value)) return "Unknown date";
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  const today = new Date();
  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (isSameDay(date, today)) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (isSameDay(date, yesterday)) return "Yesterday";
  return formatDate(value);
}

/** "3 days ago" / "just now" — for last-movement columns. */
export function formatRelative(value: string | null | undefined): string {
  if (isBlank(value)) return EMPTY;
  const then = new Date(value as string).getTime();
  if (Number.isNaN(then)) return EMPTY;
  const elapsed = Date.now() - then;
  if (elapsed < 0) return formatDate(value);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 31) return `${days}d ago`;
  return formatDate(value);
}

/** Elapsed duration between two instants, as `4m 12s`. */
export function formatDuration(
  from: string | null | undefined,
  to: string | null | undefined
): string {
  if (isBlank(from)) return EMPTY;
  const start = new Date(from as string).getTime();
  const end = isBlank(to) ? Date.now() : new Date(to as string).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return EMPTY;
  return formatElapsed(end - start);
}

/** Milliseconds as `4m 12s` (or `0:34` style for short live counters). */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return EMPTY;
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * Turn a backend enum into readable text. This is a last resort — a screen
 * should prefer an explicit label from `lib/status.ts` so users never see a
 * raw variable name.
 */
export function humanise(value: string | null | undefined, fallback = EMPTY): string {
  if (isBlank(value)) return fallback;
  const text = (value as string).replace(/[_-]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Truncate a long file name in the middle so the extension stays visible. */
export function truncateMiddle(value: string, max = 42): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

/** Initials for the account avatar. */
export function initialsOf(email: string | null | undefined): string {
  if (isBlank(email)) return "?";
  const local = (email as string).split("@")[0];
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

/** A stable short reference for a submission, derived from its id. */
export function submissionReference(id: string | null | undefined): string {
  if (isBlank(id)) return EMPTY;
  return `SUB-${(id as string).replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

export function pluralise(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : plural ?? `${singular}s`}`;
}
