/**
 * Atlas — hash router
 * ----------------------------------------------------------------------------
 * The app has always used hash routing; that stays, because the existing deep
 * links, the Worker's auth redirect, and any bookmarks the pilot team already
 * hold depend on it. What changes is that every meaningful location is now
 * addressable, including the tab inside a submission workspace, so browser
 * back/forward and "send me that link" both behave.
 *
 * Route table:
 *   #submissions                       work queue
 *   #submissions/new                   new submission
 *   #submissions/:id                   submission workspace (overview)
 *   #submissions/:id/:tab              submission workspace, specific tab
 *   #insurers                          insurer index
 *   #insurers/:id                      insurer detail
 *   #oversight                         manager oversight
 *   #jobs                              processing jobs and alerts
 */

export type Route =
  | { name: "queue" }
  | { name: "new-submission" }
  | { name: "submission"; id: string; tab: string }
  | { name: "insurers" }
  | { name: "insurer"; id: string }
  | { name: "oversight" }
  | { name: "jobs" };

export const SUBMISSION_TABS = [
  "overview",
  "risk",
  "recommendation",
  "quote-review",
  "missing-information",
  "documents",
  "communications",
  "history",
] as const;

export type SubmissionTab = (typeof SUBMISSION_TABS)[number];

export function routeToHash(route: Route): string {
  switch (route.name) {
    case "queue":
      return "#submissions";
    case "new-submission":
      return "#submissions/new";
    case "submission":
      return route.tab === "overview"
        ? `#submissions/${route.id}`
        : `#submissions/${route.id}/${route.tab}`;
    case "insurers":
      return "#insurers";
    case "insurer":
      return `#insurers/${route.id}`;
    case "oversight":
      return "#oversight";
    case "jobs":
      return "#jobs";
  }
}

export function routeFromHash(hash: string = window.location.hash): Route {
  const path = hash.replace(/^#\/?/, "").replace(/\/$/, "");
  if (path === "" || path === "submissions") return { name: "queue" };
  if (path === "insurers") return { name: "insurers" };
  // "manager" is the legacy hash for this screen; keep it working for anyone
  // holding an old bookmark.
  if (path === "oversight" || path === "manager") return { name: "oversight" };
  if (path === "jobs") return { name: "jobs" };
  if (path === "new" || path === "submissions/new") return { name: "new-submission" };

  const submission = path.match(/^submissions\/([^/]+)(?:\/([^/]+))?$/);
  if (submission) {
    const [, id, rawTab] = submission;
    const tab = (SUBMISSION_TABS as readonly string[]).includes(rawTab ?? "")
      ? (rawTab as SubmissionTab)
      : "overview";
    return { name: "submission", id, tab };
  }

  const insurer = path.match(/^insurers\/([^/]+)$/);
  if (insurer) return { name: "insurer", id: insurer[1] };

  return { name: "queue" };
}

/** True when `route` is inside the section a nav item represents. */
export function routeSection(route: Route): "queue" | "insurers" | "oversight" | "jobs" {
  switch (route.name) {
    case "insurers":
    case "insurer":
      return "insurers";
    case "oversight":
      return "oversight";
    case "jobs":
      return "jobs";
    default:
      return "queue";
  }
}
