/**
 * Atlas — application shell
 * ----------------------------------------------------------------------------
 * The stable frame every screen sits inside: a quiet ink sidebar grouped by
 * what people actually do, a top bar carrying only genuinely global controls,
 * and the content column.
 *
 * Navigation is grouped by task, not by route inventory:
 *   Work        — the queue an underwriter lives in
 *   Intelligence— the insurer appetite knowledge the recommendations read from
 *   Oversight   — manager-only visibility and operational health
 *
 * Role gating mirrors the server's own gates. Hiding a nav item is a courtesy,
 * never the security boundary — the Worker enforces every one of these.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { IconButton } from "./ui";
import { initialsOf } from "../lib/format";
import { ROLE_LABELS } from "../lib/status";
import type { Route } from "../lib/router";
import { routeSection } from "../lib/router";

export type AtlasUiRole = "underwriter" | "consultant" | "manager" | "admin" | "readonly";

export const canManage = (role: AtlasUiRole) => role === "admin" || role === "manager";
export const canWrite = (role: AtlasUiRole) => role !== "readonly";

interface NavItem {
  section: ReturnType<typeof routeSection>;
  label: string;
  icon: IconName;
  route: Route;
  managerOnly?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Work",
    items: [
      { section: "queue", label: "Work queue", icon: "queue", route: { name: "queue" } },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { section: "insurers", label: "Insurers", icon: "insurers", route: { name: "insurers" } },
    ],
  },
  {
    label: "Oversight",
    items: [
      {
        section: "oversight",
        label: "Manager overview",
        icon: "oversight",
        route: { name: "oversight" },
        managerOnly: true,
      },
      {
        section: "jobs",
        label: "Processing & alerts",
        icon: "jobs",
        route: { name: "jobs" },
        managerOnly: true,
      },
    ],
  },
];

const NAV_COLLAPSED_KEY = "atlas.nav.collapsed";

export function AppShell({
  route,
  role,
  email,
  onNavigate,
  onSignOut,
  onSearch,
  searchValue,
  children,
}: {
  route: Route;
  role: AtlasUiRole;
  email: string | null;
  onNavigate: (route: Route) => void;
  onSignOut: () => void;
  onSearch: (value: string) => void;
  searchValue: string;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(NAV_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [navOpen, setNavOpen] = useState(false);
  // Compact-mode search: on narrow viewports the search input collapses
  // to an icon-only trigger and the role pill hides behind the avatar,
  // so the top bar no longer clips at 375 or 320 px. Expanding the
  // trigger swaps it for the full field for one-off searches.
  const [searchExpanded, setSearchExpanded] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const searchTriggerRef = useRef<HTMLButtonElement | null>(null);
  const active = routeSection(route);

  // Focus/dismissal management for the mobile expand-search sheet.
  // Opening moves focus into the search input; closing restores focus to
  // the trigger; Escape dismisses irrespective of whether the field is
  // empty. Dismissal never issues a write — the query itself is
  // preserved so the reader can reopen and continue where they left off.
  useEffect(() => {
    if (searchExpanded) {
      searchInputRef.current?.focus();
    } else {
      // Only restore focus to the trigger when the trigger is currently
      // rendered (the mobile-only breakpoint); otherwise let native
      // focus flow continue.
      const trigger = searchTriggerRef.current;
      if (trigger && document.activeElement === searchInputRef.current) {
        trigger.focus();
      }
    }
  }, [searchExpanded]);

  useEffect(() => {
    if (!searchExpanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setSearchExpanded(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchExpanded]);

  const closeSearch = useCallback(() => setSearchExpanded(false), []);

  useEffect(() => {
    try {
      window.localStorage.setItem(NAV_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // Storage can be unavailable (private mode); the preference is not critical.
    }
  }, [collapsed]);

  // Close the overlay navigation whenever the route changes on small screens.
  useEffect(() => {
    setNavOpen(false);
  }, [route]);

  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.managerOnly || canManage(role)),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="atlas-shell" data-nav-collapsed={collapsed} data-nav-open={navOpen}>
      <a className="atlas-skip-link" href="#atlas-main">
        Skip to main content
      </a>

      {navOpen && (
        <div
          className="atlas-overlay"
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
      )}

      <nav className="atlas-sidebar" aria-label="Primary">
        <div className="atlas-sidebar__brand">
          <span className="atlas-sidebar__mark" aria-hidden="true">
            A
          </span>
          <span className="atlas-sidebar__wordmark">Atlas</span>
        </div>

        <div className="atlas-sidebar__nav">
          {groups.map((group) => (
            <div className="atlas-sidebar__group" key={group.label}>
              <p className="atlas-sidebar__group-label">{group.label}</p>
              {group.items.map((item) => {
                const isActive = active === item.section;
                return (
                  <button
                    key={item.label}
                    type="button"
                    className="atlas-navitem"
                    aria-current={isActive ? "page" : undefined}
                    title={collapsed ? item.label : undefined}
                    onClick={() => onNavigate(item.route)}
                  >
                    <Icon name={item.icon} className="atlas-navitem__icon" />
                    <span className="atlas-navitem__label">{item.label}</span>
                    {collapsed && <span className="atlas-sr-only">{item.label}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div className="atlas-sidebar__foot">
          <div className="atlas-sidebar__account">
            <span className="atlas-sidebar__avatar" aria-hidden="true">
              {initialsOf(email)}
            </span>
            <span className="atlas-sidebar__identity">
              <span className="atlas-sidebar__email" title={email ?? undefined}>
                {email ?? "Signed in"}
              </span>
              <span className="atlas-sidebar__role">{ROLE_LABELS[role] ?? role}</span>
            </span>
          </div>
        </div>
      </nav>

      <div className="atlas-shell__main">
        <header className="atlas-topbar">
          <IconButton
            icon="menu"
            label={navOpen ? "Close navigation" : "Open navigation"}
            className="atlas-nav-toggle"
            onClick={() => setNavOpen((value) => !value)}
          />
          <IconButton
            icon="panel-left"
            label={collapsed ? "Expand navigation" : "Collapse navigation"}
            onClick={() => setCollapsed((value) => !value)}
          />

          {searchExpanded && (
            <div
              className="atlas-topbar__search-scrim"
              onClick={closeSearch}
              aria-hidden="true"
            />
          )}

          <div
            className={[
              "atlas-topbar__search",
              searchExpanded ? "atlas-topbar__search--expanded" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            role={searchExpanded ? "dialog" : undefined}
            aria-label={searchExpanded ? "Search submissions" : undefined}
            aria-modal={searchExpanded ? true : undefined}
          >
            <div className="atlas-search">
              <label className="atlas-sr-only" htmlFor="atlas-global-search">
                Search submissions by client, broker or request type
              </label>
              <Icon name="search" size={15} className="atlas-search__icon" />
              <input
                id="atlas-global-search"
                ref={searchInputRef}
                type="search"
                className="atlas-input"
                placeholder="Search submissions…"
                value={searchValue}
                onChange={(event) => onSearch(event.target.value)}
              />
              {searchExpanded && (
                <IconButton
                  icon="close"
                  label="Close search"
                  className="atlas-topbar__search-close"
                  onClick={closeSearch}
                />
              )}
            </div>
          </div>

          <IconButton
            icon="search"
            label={searchExpanded ? "Close search" : "Search submissions"}
            className="atlas-topbar__search-trigger"
            ref={searchTriggerRef}
            onClick={() => setSearchExpanded((value) => !value)}
          />

          <div className="atlas-topbar__spacer" />

          <div className="atlas-topbar__actions">
            <span
              className="atlas-topbar__env"
              title={`Atlas is decision-support only — signed in as ${ROLE_LABELS[role] ?? role}`}
            >
              <Icon name="info" size={12} />
              <span className="atlas-topbar__env-label">Decision-support</span>
            </span>
            <IconButton icon="sign-out" label="Sign out" onClick={onSignOut} />
          </div>
        </header>

        <main className="atlas-shell__content" id="atlas-main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
