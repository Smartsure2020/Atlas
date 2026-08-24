/**
 * Atlas — shared UI primitives
 * ----------------------------------------------------------------------------
 * The repeated visual and behavioural patterns of the product, in one place.
 * Every component here handles the states the design system requires: default,
 * hover, focus, disabled, loading, empty, and error where they apply.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { Icon, TONE_ICON, type IconName } from "./Icon";
import type { StatusMeta, Tone } from "../lib/status";

/* ===========================================================================
   Button
   =========================================================================== */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "link";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  /** Shows a spinner and blocks repeat clicks. Keeps the label for context. */
  loading?: boolean;
  /** Label used while loading, e.g. "Running analysis…". */
  loadingLabel?: string;
  icon?: IconName;
  iconAfter?: IconName;
  block?: boolean;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "atlas-btn--primary",
  secondary: "",
  ghost: "atlas-btn--ghost",
  danger: "atlas-btn--danger",
  link: "atlas-btn--link",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  loadingLabel,
  icon,
  iconAfter,
  block,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  const classes = [
    "atlas-btn",
    VARIANT_CLASS[variant],
    size === "sm" ? "atlas-btn--sm" : size === "lg" ? "atlas-btn--lg" : "",
    block ? "atlas-btn--block" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button {...rest} type={type} className={classes} disabled={disabled || loading}>
      {loading ? (
        <span className="atlas-btn__spinner" aria-hidden="true" />
      ) : (
        icon && <Icon name={icon} />
      )}
      <span>{loading ? loadingLabel ?? children : children}</span>
      {!loading && iconAfter && <Icon name={iconAfter} />}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  /** Required: an icon-only control must have an accessible name. */
  label: string;
  variant?: ButtonVariant;
  size?: "sm" | "md";
}

export function IconButton({
  icon,
  label,
  variant = "ghost",
  size = "md",
  className,
  type = "button",
  ...rest
}: IconButtonProps) {
  const classes = [
    "atlas-btn",
    "atlas-btn--icon",
    VARIANT_CLASS[variant],
    size === "sm" ? "atlas-btn--sm" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button {...rest} type={type} className={classes} aria-label={label} title={label}>
      <Icon name={icon} />
    </button>
  );
}

/* ===========================================================================
   Status badge — the single badge system for the whole product
   =========================================================================== */

interface StatusBadgeProps {
  status: StatusMeta;
  /** Prefix such as "Priority" so the label reads unambiguously out of context. */
  prefix?: string;
  size?: "sm" | "md";
  /** Quiet metadata rendering for things that are not workflow states. */
  quiet?: boolean;
  strong?: boolean;
  className?: string;
}

export function StatusBadge({ status, prefix, quiet, strong, className }: StatusBadgeProps) {
  const classes = [
    "atlas-badge",
    `atlas-badge--${status.tone}`,
    quiet ? "atlas-badge--quiet" : "",
    strong ? "atlas-badge--strong" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes} title={status.description}>
      <Icon name={TONE_ICON[status.tone] ?? "info"} size={12} className="atlas-badge__mark" />
      <span className="atlas-badge__label">
        {prefix ? `${prefix}: ` : ""}
        {status.label}
      </span>
    </span>
  );
}

/** Plain metadata pill — no state semantics, so no tone icon. */
export function MetaTag({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="atlas-badge atlas-badge--quiet" title={title}>
      <span className="atlas-badge__label">{children}</span>
    </span>
  );
}

/* ===========================================================================
   Page header
   =========================================================================== */

export interface Crumb {
  label: string;
  onClick?: () => void;
}

interface PageHeaderProps {
  title: string;
  eyebrow?: string;
  description?: ReactNode;
  /** Only for genuinely nested routes; a flat page does not need these. */
  breadcrumbs?: Crumb[];
  badges?: ReactNode;
  actions?: ReactNode;
}

export function PageHeader({
  title,
  eyebrow,
  description,
  breadcrumbs,
  badges,
  actions,
}: PageHeaderProps) {
  return (
    <header className="atlas-page-header">
      <div className="atlas-page-header__main">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav aria-label="Breadcrumb">
            <ol className="atlas-breadcrumbs">
              {breadcrumbs.map((crumb, index) => (
                <li key={`${crumb.label}-${index}`}>
                  {crumb.onClick ? (
                    <button type="button" onClick={crumb.onClick}>
                      {crumb.label}
                    </button>
                  ) : (
                    <span>{crumb.label}</span>
                  )}
                  {index < breadcrumbs.length - 1 && (
                    <Icon name="chevron-right" size={12} className="atlas-breadcrumbs__sep" />
                  )}
                </li>
              ))}
            </ol>
          </nav>
        )}
        {eyebrow && <p className="atlas-eyebrow">{eyebrow}</p>}
        <div className="atlas-page-header__title-row">
          <h1 className="atlas-title-page">{title}</h1>
          {badges}
        </div>
        {description && <p className="atlas-page-header__description">{description}</p>}
      </div>
      {actions && <div className="atlas-page-header__actions">{actions}</div>}
    </header>
  );
}

/* ===========================================================================
   Card / section scaffolding
   =========================================================================== */

interface CardProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Remove body padding, e.g. when the body is a table. */
  flush?: boolean;
  tight?: boolean;
  id?: string;
  className?: string;
  as?: "div" | "section";
  ariaLabel?: string;
}

export function Card({
  title,
  description,
  actions,
  children,
  footer,
  flush,
  tight,
  id,
  className,
  as: Tag = "section",
  ariaLabel,
}: CardProps) {
  const headingId = useId();
  return (
    <Tag
      id={id}
      className={["atlas-card", className ?? ""].filter(Boolean).join(" ")}
      aria-labelledby={title ? headingId : undefined}
      aria-label={!title ? ariaLabel : undefined}
    >
      {(title || actions) && (
        <div className="atlas-card__head">
          <div className="atlas-card__heading">
            {title && (
              <h2 id={headingId} className="atlas-title-sub">
                {title}
              </h2>
            )}
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="atlas-actions">{actions}</div>}
        </div>
      )}
      {children !== undefined && (
        <div
          className={[
            "atlas-card__body",
            flush ? "atlas-card__body--flush" : "",
            tight ? "atlas-card__body--tight" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {children}
        </div>
      )}
      {footer && <div className="atlas-card__footer">{footer}</div>}
    </Tag>
  );
}

export function Block({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="atlas-block">
      <div className="atlas-block__head">
        <h3 className="atlas-block__title">{title}</h3>
        {actions && <div className="atlas-actions">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

/* ===========================================================================
   Metrics
   =========================================================================== */

interface MetricProps {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "default" | "warning" | "danger";
  /** Turns the tile into a filter control that scopes the view below it. */
  onClick?: () => void;
  active?: boolean;
  loading?: boolean;
}

export function Metric({ label, value, hint, tone = "default", onClick, active, loading }: MetricProps) {
  const inner = (
    <>
      <span className="atlas-metric__label">{label}</span>
      <span
        className={[
          "atlas-metric__value",
          tone === "warning" ? "atlas-metric__value--warning" : "",
          tone === "danger" ? "atlas-metric__value--danger" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {loading ? <span className="atlas-skeleton" style={{ width: 40, height: 24, display: "block" }} /> : value}
      </span>
      {hint && <span className="atlas-metric__hint">{hint}</span>}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className="atlas-metric" onClick={onClick} aria-pressed={active} title={hint}>
        {inner}
      </button>
    );
  }
  return (
    <div className="atlas-metric" title={hint}>
      {inner}
    </div>
  );
}

export function StatLine({ items }: { items: { label: string; value: ReactNode; title?: string }[] }) {
  return (
    <dl className="atlas-statline">
      {items.map((item) => (
        <div className="atlas-statline__item" key={item.label}>
          <dt className="atlas-statline__label">{item.label}</dt>
          <dd className="atlas-statline__value" title={item.title}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function KeyValue({
  items,
  wide,
}: {
  items: { key: string; value: ReactNode; hint?: string }[];
  wide?: boolean;
}) {
  return (
    <dl className={["atlas-kv", wide ? "atlas-kv--wide" : ""].filter(Boolean).join(" ")}>
      {items.map((item) => (
        <div className="atlas-kv__item" key={item.key}>
          <dt className="atlas-kv__key">
            {item.key}
            {item.hint && <Icon name="info" size={12} title={item.hint} />}
          </dt>
          <dd className="atlas-kv__value">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ===========================================================================
   Form fields
   =========================================================================== */

interface FieldProps {
  label: string;
  htmlFor?: string;
  required?: boolean;
  optional?: boolean;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}

export function Field({ label, htmlFor, required, optional, hint, error, children }: FieldProps) {
  return (
    <div className="atlas-field">
      <label className="atlas-field__label" htmlFor={htmlFor}>
        {label}
        {required && (
          <span className="atlas-field__required" aria-hidden="true">
            *
          </span>
        )}
        {optional && <span className="atlas-field__optional">(optional)</span>}
      </label>
      {children}
      {hint && !error && <p className="atlas-field__hint">{hint}</p>}
      {error && (
        <p className="atlas-field__error" role="alert">
          <Icon name="alert-triangle" size={13} />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

/**
 * A labelled text input wired for accessibility: the label points at the
 * control, the hint and the error are announced with it.
 */
export function TextField({
  label,
  hint,
  error,
  required,
  optional,
  id,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
}) {
  const generated = useId();
  const inputId = id ?? generated;
  const describedBy = [hint ? `${inputId}-hint` : null, error ? `${inputId}-error` : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="atlas-field">
      <label className="atlas-field__label" htmlFor={inputId}>
        {label}
        {required && (
          <span className="atlas-field__required" aria-hidden="true">
            *
          </span>
        )}
        {optional && <span className="atlas-field__optional">(optional)</span>}
      </label>
      <input
        {...rest}
        id={inputId}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={["atlas-input", error ? "atlas-input--invalid" : "", className ?? ""]
          .filter(Boolean)
          .join(" ")}
      />
      {hint && !error && (
        <p className="atlas-field__hint" id={`${inputId}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="atlas-field__error" id={`${inputId}-error`} role="alert">
          <Icon name="alert-triangle" size={13} />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

export function TextAreaField({
  label,
  hint,
  error,
  required,
  optional,
  id,
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
}) {
  const generated = useId();
  const inputId = id ?? generated;
  const describedBy = [hint ? `${inputId}-hint` : null, error ? `${inputId}-error` : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="atlas-field">
      <label className="atlas-field__label" htmlFor={inputId}>
        {label}
        {required && (
          <span className="atlas-field__required" aria-hidden="true">
            *
          </span>
        )}
        {optional && <span className="atlas-field__optional">(optional)</span>}
      </label>
      <textarea
        {...rest}
        id={inputId}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={["atlas-textarea", error ? "atlas-textarea--invalid" : "", className ?? ""]
          .filter(Boolean)
          .join(" ")}
      />
      {hint && !error && (
        <p className="atlas-field__hint" id={`${inputId}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="atlas-field__error" id={`${inputId}-error`} role="alert">
          <Icon name="alert-triangle" size={13} />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

export function SelectField({
  label,
  hint,
  error,
  required,
  optional,
  options,
  placeholder,
  id,
  className,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  options: SelectOption[];
  placeholder?: string;
}) {
  const generated = useId();
  const inputId = id ?? generated;
  const describedBy = [hint ? `${inputId}-hint` : null, error ? `${inputId}-error` : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="atlas-field">
      <label className="atlas-field__label" htmlFor={inputId}>
        {label}
        {required && (
          <span className="atlas-field__required" aria-hidden="true">
            *
          </span>
        )}
        {optional && <span className="atlas-field__optional">(optional)</span>}
      </label>
      <select
        {...rest}
        id={inputId}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={["atlas-select", error ? "atlas-select--invalid" : "", className ?? ""]
          .filter(Boolean)
          .join(" ")}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint && !error && (
        <p className="atlas-field__hint" id={`${inputId}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="atlas-field__error" id={`${inputId}-error`} role="alert">
          <Icon name="alert-triangle" size={13} />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="atlas-checkbox">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label: string;
  id?: string;
}) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className="atlas-search">
      <label className="atlas-sr-only" htmlFor={inputId}>
        {label}
      </label>
      <Icon name="search" size={15} className="atlas-search__icon" />
      <input
        id={inputId}
        type="search"
        className="atlas-input"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/* ===========================================================================
   Filter chips
   =========================================================================== */

export interface ActiveFilter {
  key: string;
  label: string;
  value: string;
  onRemove: () => void;
}

export function FilterChips({
  filters,
  onClearAll,
  resultLabel,
}: {
  filters: ActiveFilter[];
  onClearAll: () => void;
  resultLabel?: string;
}) {
  if (filters.length === 0) {
    return resultLabel ? <p className="atlas-result-count">{resultLabel}</p> : null;
  }
  return (
    <div className="atlas-chips">
      {resultLabel && <span className="atlas-result-count">{resultLabel}</span>}
      {filters.map((filter) => (
        <span className="atlas-chip" key={filter.key}>
          <span className="atlas-chip__key">{filter.label}:</span>
          <span>{filter.value}</span>
          <button
            type="button"
            className="atlas-chip__remove"
            onClick={filter.onRemove}
            aria-label={`Remove ${filter.label} filter`}
          >
            <Icon name="close" size={11} />
          </button>
        </span>
      ))}
      <Button variant="link" size="sm" onClick={onClearAll}>
        Clear all
      </Button>
    </div>
  );
}

/* ===========================================================================
   States: empty, error, loading
   =========================================================================== */

export function EmptyState({
  title,
  body,
  actions,
  inline,
}: {
  title: string;
  body?: ReactNode;
  actions?: ReactNode;
  inline?: boolean;
}) {
  return (
    <div className={["atlas-empty", inline ? "atlas-empty--inline" : ""].filter(Boolean).join(" ")}>
      <p className="atlas-empty__title">{title}</p>
      {body && <p className="atlas-empty__body">{body}</p>}
      {actions && <div className="atlas-empty__actions">{actions}</div>}
    </div>
  );
}

type NoticeTone = "info" | "success" | "warning" | "referral" | "danger";

const NOTICE_ICON: Record<NoticeTone, IconName> = {
  info: "info",
  success: "check-circle",
  warning: "alert-triangle",
  referral: "arrow-up-right",
  danger: "x-circle",
};

export function Notice({
  tone = "info",
  title,
  children,
  actions,
  detail,
  role,
}: {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** Technical detail kept out of the way behind a disclosure. */
  detail?: string | null;
  role?: "alert" | "status" | "note";
}) {
  return (
    <div className={`atlas-notice atlas-notice--${tone}`} role={role ?? (tone === "danger" ? "alert" : "note")}>
      <Icon name={NOTICE_ICON[tone]} size={16} className="atlas-notice__icon" />
      <div className="atlas-notice__content">
        {title && <strong className="atlas-notice__title">{title}</strong>}
        {children}
        {detail && (
          <details className="atlas-notice__detail">
            <summary>Technical detail</summary>
            <pre>{detail}</pre>
          </details>
        )}
        {actions && <div className="atlas-notice__actions">{actions}</div>}
      </div>
    </div>
  );
}

/**
 * A recoverable failure. Always names what failed and what the user can do,
 * never "Something went wrong".
 */
export function ErrorState({
  title,
  message,
  detail,
  onRetry,
  retryLabel = "Try again",
}: {
  title: string;
  message: ReactNode;
  detail?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <Notice
      tone="danger"
      title={title}
      detail={detail}
      role="alert"
      actions={
        onRetry ? (
          <Button size="sm" icon="refresh" onClick={onRetry}>
            {retryLabel}
          </Button>
        ) : undefined
      }
    >
      <span>{message}</span>
    </Notice>
  );
}

export function Skeleton({
  width,
  height,
  variant = "text",
}: {
  width?: number | string;
  height?: number | string;
  variant?: "text" | "title" | "block";
}) {
  return (
    <span
      className={`atlas-skeleton atlas-skeleton--${variant}`}
      style={{ width, height, display: "block" }}
      aria-hidden="true"
    />
  );
}

/** Skeleton rows shaped like the table they replace, so nothing jumps. */
export function TableSkeleton({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <tbody aria-hidden="true">
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <tr key={rowIndex}>
          {Array.from({ length: columns }).map((__, colIndex) => (
            <td key={colIndex}>
              <Skeleton width={colIndex === 0 ? "70%" : "50%"} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

export function CardSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="atlas-card" aria-hidden="true">
      <div className="atlas-card__body">
        <Skeleton variant="title" />
        <div style={{ marginTop: 12 }}>
          {Array.from({ length: lines }).map((_, index) => (
            <Skeleton key={index} width={index === lines - 1 ? "60%" : "100%"} />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Progress with smooth interpolation between backend milestones.
 * The backend reports progress at a few hard-coded points (e.g. 10, 35, 85).
 * This component fills the gaps with a gentle drift so the bar never looks
 * frozen, while never overshooting the next known milestone.
 */
export function ProgressStages({
  percent,
  caption,
}: {
  percent?: number | null;
  caption: string;
}) {
  const target = typeof percent === "number" && percent > 0 && percent <= 100 ? percent : 0;
  const determinate = target > 0;
  const [display, setDisplay] = useState(target);
  const displayRef = useRef(display);
  displayRef.current = display;
  const targetRef = useRef(target);

  useEffect(() => {
    if (target > targetRef.current) {
      setDisplay(target);
    }
    targetRef.current = target;
  }, [target]);

  useEffect(() => {
    if (!determinate || target >= 100) return;
    const ceiling = target < 35 ? 34 : target < 85 ? 84 : 99;
    const timer = window.setInterval(() => {
      setDisplay((prev) => {
        if (prev >= ceiling) return prev;
        const step = 0.3 + Math.random() * 0.5;
        return Math.min(prev + step, ceiling);
      });
    }, 800);
    return () => window.clearInterval(timer);
  }, [determinate, target]);

  const shown = Math.round(display);

  return (
    <div className="atlas-progress">
      <div className="atlas-progress__track">
        <div
          className={`atlas-progress__bar ${determinate ? "" : "atlas-progress__bar--indeterminate"}`}
          style={determinate ? { width: `${shown}%` } : undefined}
          role="progressbar"
          aria-valuenow={determinate ? shown : undefined}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={caption}
        />
      </div>
      <p className="atlas-progress__caption" aria-live="polite">
        {caption}
        {determinate ? ` — ${shown}%` : ""}
      </p>
    </div>
  );
}

/* ===========================================================================
   Tabs
   =========================================================================== */

export interface TabDefinition {
  id: string;
  label: string;
  count?: number;
  /** Renders the count in an attention tone (outstanding work). */
  attention?: boolean;
}

export function Tabs({
  tabs,
  active,
  onChange,
  label,
}: {
  tabs: TabDefinition[];
  active: string;
  onChange: (id: string) => void;
  label: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((tab) => tab.id === active);
    if (index < 0) return;
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    const target = tabs[next];
    onChange(target.id);
    refs.current[target.id]?.focus();
  }

  return (
    <div className="atlas-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          ref={(node) => {
            refs.current[tab.id] = node;
          }}
          type="button"
          role="tab"
          id={`tab-${tab.id}`}
          aria-selected={tab.id === active}
          aria-controls={`tabpanel-${tab.id}`}
          tabIndex={tab.id === active ? 0 : -1}
          className="atlas-tab"
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count !== undefined && tab.count > 0 && (
            <span
              className={`atlas-tab__count ${tab.attention ? "atlas-tab__count--attention" : ""}`}
            >
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({
  id,
  active,
  children,
}: {
  id: string;
  active: string;
  children: ReactNode;
}) {
  if (id !== active) return null;
  return (
    <div role="tabpanel" id={`tabpanel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={-1}>
      {children}
    </div>
  );
}

/* ===========================================================================
   Focus management shared by Drawer and Modal
   =========================================================================== */

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), details > summary, [tabindex]:not([tabindex="-1"])';

function useFocusTrap(
  containerRef: React.RefObject<HTMLElement>,
  onDismiss: () => void,
  options: { dismissOnEscape?: boolean } = {}
) {
  const { dismissOnEscape = true } = options;
  const previouslyFocused = useRef<HTMLElement | null>(null);
  // Hold the latest handler and option in refs so the trap installs exactly
  // once for the surface's open lifetime. Keying the effect on the handler
  // identity used to tear the trap down on every parent re-render — running the
  // cleanup, which restored focus to the trigger, and pulling focus back out of
  // an open dialog. Reading them through refs keeps the Escape and Tab
  // behaviour current without re-running the effect.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const dismissOnEscapeRef = useRef(dismissOnEscape);
  dismissOnEscapeRef.current = dismissOnEscape;

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const container = containerRef.current;
    if (container) {
      const first = container.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? container).focus();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && dismissOnEscapeRef.current) {
        event.stopPropagation();
        onDismissRef.current();
        return;
      }
      if (event.key !== "Tab" || !containerRef.current) return;
      const focusable = Array.from(
        containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)
      ).filter((node) => node.offsetParent !== null || node === document.activeElement);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      // Focus returns to whatever opened the surface — but only if it is still
      // in the document and focusable, so a trigger that unmounted while the
      // surface was open never receives a stray focus call.
      const trigger = previouslyFocused.current;
      if (trigger && trigger.isConnected && typeof trigger.focus === "function") {
        trigger.focus();
      }
    };
  }, [containerRef]);
}

/* ===========================================================================
   Drawer — contextual work that keeps the page behind it
   =========================================================================== */

export function Drawer({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  size = "md",
  /** Set when the drawer holds unsaved edits; blocks accidental dismissal. */
  dirty = false,
  flush = false,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  dirty?: boolean;
  flush?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Confirmation is a real ConfirmDialog now, not native window.confirm.
  // The old browser prompt broke the focus trap contract — Chrome would
  // return focus to <body> after the OK/Cancel choice instead of the
  // Drawer panel, and the focus trap could never re-install itself
  // correctly on the round trip. The ConfirmDialog is trap-native, so
  // Escape and outside-click behave consistently, and focus returns to
  // the Drawer close control when the user chooses to keep editing.
  const [discardPending, setDiscardPending] = useState(false);

  const requestClose = useCallback(() => {
    if (dirty) {
      setDiscardPending(true);
      return;
    }
    onClose();
  }, [dirty, onClose]);

  if (!open) return null;
  return (
    <>
      <DrawerBody
        panelRef={panelRef}
        titleId={titleId}
        title={title}
        description={description}
        requestClose={requestClose}
        footer={footer}
        size={size}
        flush={flush}
      >
        {children}
      </DrawerBody>
      <ConfirmDialog
        open={discardPending}
        title="Discard your unsaved changes?"
        destructive
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        body={
          <p>
            You have unsaved edits in this panel. Discarding closes the panel
            and loses them; keeping editing returns you to the form.
          </p>
        }
        onCancel={() => setDiscardPending(false)}
        onConfirm={() => {
          setDiscardPending(false);
          onClose();
        }}
      />
    </>
  );
}

function DrawerBody({
  panelRef,
  titleId,
  title,
  description,
  requestClose,
  children,
  footer,
  size,
  flush,
}: {
  panelRef: React.RefObject<HTMLDivElement>;
  titleId: string;
  title: string;
  description?: ReactNode;
  requestClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size: "sm" | "md" | "lg" | "xl";
  flush: boolean;
}) {
  useFocusTrap(panelRef, requestClose);
  return (
    <>
      <div className="atlas-overlay" onClick={requestClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className={`atlas-drawer atlas-drawer--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="atlas-drawer__head">
          <div>
            <h2 className="atlas-drawer__title" id={titleId}>
              {title}
            </h2>
            {description && <p className="atlas-drawer__description">{description}</p>}
          </div>
          <IconButton icon="close" label="Close panel" onClick={requestClose} />
        </div>
        <div className={["atlas-drawer__body", flush ? "atlas-drawer__body--flush" : ""].filter(Boolean).join(" ")}>
          {children}
        </div>
        {footer && <div className="atlas-drawer__footer">{footer}</div>}
      </div>
    </>
  );
}

/* ===========================================================================
   Modal + confirmation dialog
   =========================================================================== */

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: "md" | "lg";
}) {
  if (!open) return null;
  return (
    <ModalBody title={title} onClose={onClose} footer={footer} size={size}>
      {children}
    </ModalBody>
  );
}

function ModalBody({
  title,
  onClose,
  children,
  footer,
  size,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size: "md" | "lg";
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(panelRef, onClose);
  return (
    <>
      <div className="atlas-overlay" onClick={onClose} aria-hidden="true" />
      <div className="atlas-modal-layer">
        <div
          ref={panelRef}
          className={`atlas-modal ${size === "lg" ? "atlas-modal--lg" : ""}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
        >
          <div className="atlas-modal__head">
            <h2 className="atlas-modal__title" id={titleId}>
              {title}
            </h2>
          </div>
          <div className="atlas-modal__body">{children}</div>
          {footer && <div className="atlas-modal__footer">{footer}</div>}
        </div>
      </div>
    </>
  );
}

/**
 * Confirmation for actions with a real consequence. The title states the
 * action, the body states what will happen, and the button repeats the action
 * — never "Are you sure?" / "OK".
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive,
  working,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  working?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel} disabled={working}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            onClick={onConfirm}
            loading={working}
            loadingLabel="Working…"
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body}
    </Modal>
  );
}

/**
 * A prompt that collects one short piece of text before an action proceeds —
 * the accessible replacement for window.prompt().
 */
export function PromptDialog({
  open,
  title,
  label,
  body,
  confirmLabel,
  required = true,
  working,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  label: string;
  body?: ReactNode;
  confirmLabel: string;
  required?: boolean;
  working?: boolean;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) {
      setValue("");
      setTouched(false);
    }
  }, [open]);

  const invalid = required && touched && value.trim().length === 0;

  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel} disabled={working}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={working}
            onClick={() => {
              setTouched(true);
              if (required && value.trim().length === 0) return;
              onConfirm(value.trim());
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body && <p style={{ marginBottom: 12 }}>{body}</p>}
      <TextAreaField
        label={label}
        required={required}
        rows={3}
        value={value}
        error={invalid ? "This note is required for the audit history." : null}
        onChange={(event) => {
          setValue(event.target.value);
          setTouched(true);
        }}
      />
    </Modal>
  );
}

/* ===========================================================================
   Toasts — lightweight confirmation only
   =========================================================================== */

interface Toast {
  id: number;
  message: string;
  tone: "default" | "success" | "warning" | "danger";
}

interface ToastApi {
  notify: (message: string, tone?: Toast["tone"]) => void;
}

const ToastContext = createContext<ToastApi>({ notify: () => undefined });

export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  // Track the auto-dismiss timers so we can (a) cancel one when the user
  // clicks the close button, avoiding a redundant setState-after-dismiss,
  // and (b) clear the whole map on unmount, so a full-page reload while
  // a toast is queued does not leave a setState pending on a torn-down
  // provider.
  const timersRef = useRef<Map<number, number>>(new Map());

  const dismiss = useCallback((id: number) => {
    const timers = timersRef.current;
    const handle = timers.get(id);
    if (handle !== undefined) {
      window.clearTimeout(handle);
      timers.delete(id);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback<ToastApi["notify"]>(
    (message, tone = "default") => {
      const id = nextId.current++;
      setToasts((current) => [...current, { id, message, tone }]);
      const handle = window.setTimeout(() => dismiss(id), 5000);
      timersRef.current.set(id, handle);
    },
    [dismiss]
  );

  useEffect(() => {
    // Clear every pending auto-dismiss when the provider tears down.
    const timers = timersRef.current;
    return () => {
      timers.forEach((handle) => window.clearTimeout(handle));
      timers.clear();
    };
  }, []);

  const api = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="atlas-toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`atlas-toast ${toast.tone !== "default" ? `atlas-toast--${toast.tone}` : ""}`}
          >
            <span className="atlas-toast__body">{toast.message}</span>
            <button
              type="button"
              className="atlas-toast__close"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss notification"
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ===========================================================================
   Evidence and disclosure
   =========================================================================== */

export function Disclosure({
  summary,
  children,
  defaultOpen,
}: {
  summary: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="atlas-disclosure" open={defaultOpen}>
      <summary>{summary}</summary>
      <div className="atlas-disclosure__body">{children}</div>
    </details>
  );
}

/** Where a value or rule actually came from, with the supporting quote. */
export function SourceReference({
  parts,
  quote,
  note,
}: {
  parts: (string | null | undefined)[];
  quote?: string | null;
  note?: string | null;
}) {
  const source = parts.filter(Boolean) as string[];
  if (source.length === 0 && !quote && !note) return null;
  return (
    <div className="atlas-evidence">
      {source.length > 0 && (
        <div className="atlas-evidence__source">
          <Icon name="document" size={12} />
          <span>{source.join(" · ")}</span>
        </div>
      )}
      {quote && <blockquote>{quote}</blockquote>}
      {note && <div style={{ marginTop: 4 }}>{note}</div>}
    </div>
  );
}

/* ===========================================================================
   Structured reason — the shape every explanation on the product uses
   =========================================================================== */

export function Reason({
  kind,
  title,
  children,
  nextAction,
  evidence,
}: {
  kind: "blocker" | "referral" | "concern" | "strength" | "info";
  title: string;
  children?: ReactNode;
  nextAction?: ReactNode;
  evidence?: ReactNode;
}) {
  const icon: Record<typeof kind, IconName> = {
    blocker: "x-circle",
    referral: "arrow-up-right",
    concern: "alert-triangle",
    strength: "check-circle",
    info: "info",
  };
  return (
    <div className={`atlas-reason atlas-reason--${kind}`}>
      <div className="atlas-reason__head">
        <Icon name={icon[kind]} size={14} />
        <span className="atlas-reason__title">{title}</span>
      </div>
      {children && <div className="atlas-reason__text">{children}</div>}
      {evidence}
      {nextAction && (
        <p className="atlas-reason__next">
          <span className="atlas-reason__next-label">Next action: </span>
          {nextAction}
        </p>
      )}
    </div>
  );
}

/* ===========================================================================
   Ranked list — used instead of pie charts for category breakdowns
   =========================================================================== */

export function RankedList({
  items,
  emptyLabel = "No data for this period.",
}: {
  items: { label: string; count: number }[];
  emptyLabel?: string;
}) {
  if (items.length === 0) return <p className="atlas-text-dense atlas-text-muted">{emptyLabel}</p>;
  const max = Math.max(...items.map((item) => item.count), 1);
  return (
    <ul className="atlas-rank">
      {items.map((item) => (
        <li className="atlas-rank__item" key={item.label}>
          <span className="atlas-rank__label">{item.label}</span>
          <span className="atlas-rank__count">{item.count}</span>
          <span className="atlas-rank__track">
            <span
              className="atlas-rank__bar"
              style={{ width: `${Math.max(3, (item.count / max) * 100)}%` }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ===========================================================================
   Tone helper for consumers that need the raw class
   =========================================================================== */

export function toneClass(tone: Tone): string {
  return `atlas-badge--${tone}`;
}
