/**
 * Atlas — submission workspace
 * ----------------------------------------------------------------------------
 * The underwriting workbench for one submission. Previously a single very long
 * page of stacked cards; now a persistent context header plus URL-addressable
 * tabs, so a person can send a colleague a link straight to the recommendation
 * or the missing-information list.
 *
 * The record's data is loaded once here and handed to the panels, rather than
 * every panel fetching the recommendation for itself. Mutations call the same
 * endpoints as before and then ask this component to refresh.
 *
 * Nothing about the underlying rules changed: extraction is still manager-only,
 * recommendations and quote reviews are still gated on a reviewed extraction,
 * and every decision still goes through the same audited endpoint.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  getSubmission,
  runExtraction,
  saveReview,
  updatePilotFlag,
  listPilotIssues,
  createPilotIssue,
  updatePilotIssue,
  type ExtractionRecord,
  type PilotIssue,
} from "../lib/atlas";
import {
  resolveExtractionConfidence,
  type ExtractionConfidenceState,
} from "../lib/extraction-confidence";
import { cancelJob, updateAssignment } from "../lib/phase7";
import { getRecommendation, type Recommendation } from "../lib/recommendations";
import { getQuoteReview, type QuoteReview, type QuoteReviewSection } from "../lib/quote-reviews";
import { getDecision, type Decision } from "../lib/decisions";
import { listMissingInfo, type MissingInfoItem } from "../lib/phase4";
import {
  Button,
  Card,
  CardSkeleton,
  Drawer,
  ErrorState,
  Notice,
  ProgressStages,
  SelectField,
  StatusBadge,
  TabPanel,
  Tabs,
  TextAreaField,
  TextField,
  useToast,
  type TabDefinition,
} from "../components/ui";
import { Icon } from "../components/Icon";
import ExtractionTrustSummary from "../components/ExtractionTrustSummary";
import { canManage as roleCanManage, canWrite as roleCanWrite, type AtlasUiRole } from "../components/AppShell";
import RiskInformationPanel from "./RiskInformationPanel";
import { countByBand } from "../lib/extraction-fields";
import RecommendationPanel from "./RecommendationPanel";
import QuoteReviewPanel from "./QuoteReviewPanel";
import MissingInfoPanel from "./MissingInfoPanel";
import DocumentsTab from "./SubmissionDocuments";
import CommunicationsPanel from "./CommunicationsPanel";
import AuditTimeline from "./AuditTimeline";
import {
  EMPTY,
  formatDate,
  formatDateTime,
  formatRelative,
  submissionReference,
} from "../lib/format";
import {
  lineOfBusinessLabel,
  priority as priorityStatus,
  processingStage,
  QUEUE_STATUS_OPTIONS,
  queueStatus,
  quoteReviewStatus,
  severity as severityMeta,
  workflowStatus,
} from "../lib/status";
import type { SubmissionTab } from "../lib/router";

const EXPENSIVE_JOBS = ["extraction", "recommendation", "quote_review"] as const;
type ExpensiveJob = (typeof EXPENSIVE_JOBS)[number];

interface JobRecord {
  id?: string;
  status?: string;
  progress_percent?: number;
  current_step?: string | null;
  created_at?: string;
  completed_at?: string;
  error_message?: string | null;
  cancellation_requested?: boolean;
}

interface SubmissionRecord {
  id: string;
  client_name: string | null;
  broker_name: string | null;
  broker_email: string | null;
  request_type: string | null;
  status: string;
  queue_status: string | null;
  line_of_business: string | null;
  priority: string | null;
  next_action: string | null;
  due_at: string | null;
  assigned_to: string | null;
  assigned_underwriter: string | null;
  pilot_flag: boolean | null;
  pilot_notes: string | null;
  assigned_to_email: string | null;
  created_at: string;
  updated_at: string;
}

interface SubmissionPayload {
  submission: SubmissionRecord;
  documents: Record<string, unknown>[];
  extraction: ExtractionRecord | null;
  jobs?: Partial<Record<ExpensiveJob, JobRecord>>;
}

/**
 * Narrow parser for the submission record the Worker sends back. Replaces
 * the previous `payloadRaw.submission as unknown as SubmissionRecord`
 * double cast, which silently disabled the type check on the shape the
 * render layer relies on. Only `id` and `status` are required; the rest
 * of the fields are read through nullable accessors on the same shape,
 * so a missing optional never throws — but a missing id/status means
 * the payload is not actually a submission and we throw a targeted error
 * instead of silently rendering an unusable workspace.
 */
export function toSubmissionRecord(raw: unknown): SubmissionRecord {
  if (!raw || typeof raw !== "object") {
    throw new Error("Submission payload is not an object");
  }
  const source = raw as Record<string, unknown>;
  if (typeof source.id !== "string" || source.id.length === 0) {
    throw new Error("Submission payload is missing id");
  }
  if (typeof source.status !== "string") {
    throw new Error("Submission payload is missing status");
  }
  const asStringOrNull = (key: string): string | null => {
    const value = source[key];
    return typeof value === "string" ? value : null;
  };
  const asBoolOrNull = (key: string): boolean | null => {
    const value = source[key];
    return typeof value === "boolean" ? value : null;
  };
  return {
    id: source.id,
    client_name: asStringOrNull("client_name"),
    broker_name: asStringOrNull("broker_name"),
    broker_email: asStringOrNull("broker_email"),
    request_type: asStringOrNull("request_type"),
    status: source.status,
    queue_status: asStringOrNull("queue_status"),
    line_of_business: asStringOrNull("line_of_business"),
    priority: asStringOrNull("priority"),
    next_action: asStringOrNull("next_action"),
    due_at: asStringOrNull("due_at"),
    assigned_to: asStringOrNull("assigned_to"),
    assigned_underwriter: asStringOrNull("assigned_underwriter"),
    pilot_flag: asBoolOrNull("pilot_flag"),
    pilot_notes: asStringOrNull("pilot_notes"),
    assigned_to_email: asStringOrNull("assigned_to_email"),
    created_at: typeof source.created_at === "string" ? source.created_at : "",
    updated_at: typeof source.updated_at === "string" ? source.updated_at : "",
  };
}

/**
 * Narrow parser for the optional `jobs` map. Keeps only the three
 * expensive-job keys we know how to render, and re-shapes each entry
 * into a plain JobRecord. Anything unrecognised is dropped rather than
 * cast blindly.
 */
export function toJobsMap(
  raw: unknown
): Partial<Record<ExpensiveJob, JobRecord>> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const out: Partial<Record<ExpensiveJob, JobRecord>> = {};
  for (const key of EXPENSIVE_JOBS) {
    const value = source[key];
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    out[key] = {
      id: typeof entry.id === "string" ? entry.id : undefined,
      status: typeof entry.status === "string" ? entry.status : undefined,
      progress_percent:
        typeof entry.progress_percent === "number" ? entry.progress_percent : undefined,
      current_step: typeof entry.current_step === "string" ? entry.current_step : null,
      created_at: typeof entry.created_at === "string" ? entry.created_at : undefined,
      completed_at: typeof entry.completed_at === "string" ? entry.completed_at : undefined,
      error_message: typeof entry.error_message === "string" ? entry.error_message : null,
      cancellation_requested:
        typeof entry.cancellation_requested === "boolean"
          ? entry.cancellation_requested
          : undefined,
    };
  }
  return out;
}

export interface WorkspaceData {
  payload: SubmissionPayload;
  recommendation: Recommendation | null;
  quoteReview: QuoteReview | null;
  quoteSections: QuoteReviewSection[];
  decision: Decision | null;
  missingInfo: MissingInfoItem[];
}

export default function SubmissionDetail({
  submissionId,
  tab,
  role,
  onTabChange,
  onBack,
}: {
  submissionId: string;
  tab: string;
  role: AtlasUiRole;
  onTabChange: (tab: SubmissionTab) => void;
  onBack: () => void;
}) {
  const canManage = roleCanManage(role);
  const canWrite = roleCanWrite(role);
  const toast = useToast();

  const [data, setData] = useState<WorkspaceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [forceRetry, setForceRetry] = useState(false);
  const [assignmentOpen, setAssignmentOpen] = useState(false);

  // The five dependent GETs are addressed by their result identifier so a
  // poll knows whether the recommendation / quote review / decision on the
  // workspace has actually changed. When only the submission's job
  // heartbeat updates, none of these need re-fetching.
  const dependentSignatureRef = useRef<string>("");

  const load = useCallback(
    async (options: { silent?: boolean; dependents?: boolean } = {}) => {
      const dependents = options.dependents !== false;
      if (!options.silent) setLoading(true);
      // Phase 3: brokers must NEVER issue recommendation/quote-review/decision
      // requests. Even though those endpoints return 403 for broker, relying on
      // that as normal flow leaks intent through network logs and produces
      // console noise in the SPA. Skip the calls entirely for broker.
      const isBroker = role === "broker";
      try {
        // One round of parallel reads for the whole workspace. Failures on the
        // optional pieces must not blank the record.
        const results = await Promise.all([
          getSubmission(submissionId),
          dependents && !isBroker
            ? getRecommendation(submissionId).catch(() => ({ recommendation: null }))
            : Promise.resolve(null),
          dependents && !isBroker
            ? getQuoteReview(submissionId).catch(() => ({ quote_review: null, sections: [] }))
            : Promise.resolve(null),
          dependents && !isBroker
            ? getDecision(submissionId).catch(() => ({ decision: null }))
            : Promise.resolve(null),
          dependents ? listMissingInfo(submissionId).catch(() => ({ items: [] })) : Promise.resolve(null),
        ]);
        const payloadRaw = results[0];
        // Narrow parser instead of a double `as unknown as SubmissionRecord`
        // cast: keep the wider Worker-typed submission shape available,
        // and hand-verify the fields the render layer actually reads.
        // If a field is missing/wrong-shaped we throw a targeted error
        // rather than pretending we have a valid record.
        const payload: SubmissionPayload = {
          submission: toSubmissionRecord(payloadRaw.submission),
          documents: payloadRaw.documents,
          extraction: payloadRaw.extraction,
          jobs: toJobsMap(payloadRaw.jobs),
        };
        setData((prev) => {
          if (!dependents && prev) {
            // Poll path — only the submission was re-fetched; keep the
            // last-known dependent slices in place.
            return { ...prev, payload };
          }
          const recommendation = results[1] as Awaited<ReturnType<typeof getRecommendation>> | null;
          const quote = results[2] as Awaited<ReturnType<typeof getQuoteReview>> | null;
          const decision = results[3] as Awaited<ReturnType<typeof getDecision>> | null;
          const missing = results[4] as Awaited<ReturnType<typeof listMissingInfo>> | null;
          return {
            payload,
            recommendation: recommendation?.recommendation ?? null,
            quoteReview: quote?.quote_review ?? null,
            quoteSections: quote?.sections ?? [],
            decision: decision?.decision ?? null,
            missingInfo: missing?.items ?? [],
          };
        });
        setLoadError(null);
      } catch (cause) {
        const message = (cause as Error).message;
        setLoadError(
          message === "not_authenticated"
            ? "Your session has expired. Sign in again to open this submission."
            : "This submission could not be loaded. It may have been removed, or the Atlas API did not respond."
        );
      } finally {
        if (!options.silent) setLoading(false);
      }
    },
    [submissionId, role]
  );

  useEffect(() => {
    // Cancellation gate closes the StrictMode-remount duplicate: the
    // discarded mount's fetch is scheduled behind a microtask, and the
    // cleanup flips `cancelled` before that microtask drains — so no
    // duplicate GET reaches the network for /submission, /recommendation,
    // /quote-review, /decision, or /missing-info.
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const jobs = data?.payload.jobs;

  // Poll only while expensive work is genuinely in flight. The poll
  // fetches only the submission (so we pick up job progress / job
  // completion + the new payload). When the completion changes any of
  // the dependent identifiers below (recommendation, quote review,
  // decision, missing information), a follow-up read refreshes just
  // those slices. This replaces the previous 5-endpoint every-3s poll,
  // which under load ran 50–200 authenticated requests per active
  // submission per 30–120s window.
  const workInFlight = EXPENSIVE_JOBS.some((key) =>
    ["queued", "running"].includes(jobs?.[key]?.status ?? "")
  );
  const jobSignature = EXPENSIVE_JOBS.map(
    (key) => `${key}:${jobs?.[key]?.status ?? "none"}:${jobs?.[key]?.progress_percent ?? 0}`
  ).join("|");

  // Dependent-result identifiers. When the extraction / recommendation /
  // quote-review completes and its result identifier changes, refresh
  // the dependent slices in one follow-up read. This runs regardless of
  // whether the workInFlight poll is active, so a manual refresh that
  // lands a fresh recommendation also picks up the follow-through.
  const dependentSignature = [
    data?.payload.extraction?.id ?? "none",
    data?.payload.extraction?.reviewed_json ? "reviewed" : "raw",
    data?.recommendation?.id ?? "none",
    data?.quoteReview?.id ?? "none",
    data?.decision?.id ?? "none",
    data?.payload.jobs?.extraction?.status ?? "none",
    data?.payload.jobs?.recommendation?.status ?? "none",
    data?.payload.jobs?.quote_review?.status ?? "none",
  ].join("|");

  useEffect(() => {
    if (!data) return;
    if (dependentSignatureRef.current === dependentSignature) return;
    // The first time we settle the signature we record it and skip the
    // follow-up read — the initial load already fetched everything.
    const first = dependentSignatureRef.current === "";
    dependentSignatureRef.current = dependentSignature;
    if (first) return;
    void load({ silent: true });
    // dependentSignature is deliberately the only trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dependentSignature]);

  // Normalise a broker who direct-navigates to a hidden tab back to Overview.
  // Kept above the loading/error early returns so React's hook order is
  // stable across the pre-data → post-data transition. The allowed broker
  // tab set is static and does not depend on `data`, so pinning it here is
  // safe.
  const isBrokerRole = role === "broker";
  const BROKER_TABS: readonly SubmissionTab[] = [
    "overview",
    "missing-information",
    "documents",
    "history",
  ];
  useEffect(() => {
    if (isBrokerRole && !BROKER_TABS.includes(tab as SubmissionTab)) {
      onTabChange("overview" as SubmissionTab);
    }
    // BROKER_TABS is a stable readonly literal; excluded from deps intentionally.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBrokerRole, tab, onTabChange]);

  useEffect(() => {
    if (!workInFlight) return;
    let timer: number | null = null;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void load({ silent: true, dependents: false });
    };
    const start = () => {
      if (timer !== null) return;
      timer = window.setInterval(tick, 3000);
    };
    const stop = () => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // Immediately pick up whatever changed while the tab was hidden,
        // then resume polling.
        void load({ silent: true, dependents: false });
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // jobSignature drives restart when a stage advances.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workInFlight, jobSignature, load]);

  if (loading && !data) {
    return (
      <div className="atlas-stack">
        <CardSkeleton lines={2} />
        <CardSkeleton lines={5} />
      </div>
    );
  }

  if (loadError && !data) {
    return (
      <div className="atlas-stack">
        <Button icon="arrow-right" onClick={onBack}>
          Back to the work queue
        </Button>
        <ErrorState
          title="This submission could not be opened"
          message={loadError}
          onRetry={() => void load()}
        />
      </div>
    );
  }

  if (!data) return null;

  const { submission, extraction, documents } = data.payload;
  const summary = (extraction?.reviewed_json ?? extraction?.extracted_json ?? null) as Record<
    string,
    unknown
  > | null;
  const reviewed = Boolean(extraction?.reviewed_json);

  const missingFromExtraction = Array.isArray(summary?.missing_information)
    ? (summary!.missing_information as unknown[])
    : [];
  const redFlags = Array.isArray(summary?.red_flags) ? (summary!.red_flags as unknown[]) : [];
  const openMissingInfo = data.missingInfo.filter(
    (item) => item.status === "open" || item.status === "requested"
  );
  const uncertainFieldCount = summary ? countByBand(summary, reviewed, ["uncertain", "conflicting", "missing"]) : 0;
  const activeDocuments = documents.filter((document) => document.status !== "expired");
  const extractionConfidence = resolveExtractionConfidence(extraction);

  const nextAction = deriveNextAction({
    submission,
    hasExtraction: Boolean(extraction),
    reviewed,
    recommendation: data.recommendation,
    quoteReview: data.quoteReview,
    decision: data.decision,
    openMissingInfo: openMissingInfo.length,
    canManage,
    activeJob: EXPENSIVE_JOBS.find((key) =>
      ["queued", "running"].includes(data.payload.jobs?.[key]?.status ?? "")
    ),
  });

  // Phase 3: brokers get a narrow tab set only. Underwriting-intelligence
  // tabs (Risk information, Recommendation, Quote review, Communications)
  // are removed entirely — not hidden — so a direct hash navigation to one
  // of them normalises to Overview via the effect below.
  const isBroker = role === "broker";
  const tabs: TabDefinition[] = isBroker
    ? [
        { id: "overview", label: "Overview" },
        {
          id: "missing-information",
          label: "Missing information",
          count: openMissingInfo.length,
          attention: openMissingInfo.length > 0,
        },
        { id: "documents", label: "Documents", count: activeDocuments.length },
        { id: "history", label: "History" },
      ]
    : [
        { id: "overview", label: "Overview" },
        { id: "risk", label: "Risk information", count: uncertainFieldCount, attention: uncertainFieldCount > 0 },
        { id: "recommendation", label: "Recommendation" },
        { id: "quote-review", label: "Quote review" },
        {
          id: "missing-information",
          label: "Missing information",
          count: openMissingInfo.length,
          attention: openMissingInfo.length > 0,
        },
        { id: "documents", label: "Documents", count: activeDocuments.length },
        { id: "communications", label: "Communications" },
        { id: "history", label: "History" },
      ];

  // Tab-normalisation for broker moved above the loading/error early
  // returns so hook ordering stays stable — see the effect defined
  // alongside BROKER_TABS earlier in this component.

  async function onExtract(force = false) {
    setExtracting(true);
    setActionError(null);
    try {
      await runExtraction(submissionId, { force });
      await load({ silent: true });
      toast.notify("Extraction started. Atlas is reading the documents.", "success");
    } catch (cause) {
      const msg = (cause as Error).message;
      if (msg === "manager_only") {
        setActionError("Only an underwriting manager can run an extraction. Ask a manager to run it for this submission.");
      } else if ((msg === "job_already_running" || msg === "http_409") && !force) {
        setActionError("A previous extraction is still recorded as running. Click the button again to force a new extraction.");
        setForceRetry(true);
      } else {
        setActionError("The extraction could not be started. Check the processing screen for the failure reason, then try again.");
      }
    } finally {
      setExtracting(false);
    }
  }

  return (
    <div>
      <WorkspaceHeader
        submission={submission}
        onBack={onBack}
        primaryAction={
          isBroker ? null : (
            <NextActionButton
              action={nextAction}
              extracting={extracting}
              canWrite={canWrite}
              onExtract={() => {
                if (forceRetry) {
                  setForceRetry(false);
                  onExtract(true);
                } else {
                  onExtract();
                }
              }}
              onGoToTab={onTabChange}
            />
          )
        }
      />

      {actionError && (
        <div style={{ marginBottom: "var(--atlas-space-4)" }}>
          <Notice
            tone="danger"
            title="That action did not complete"
            actions={
              <Button size="sm" onClick={() => setActionError(null)}>
                Dismiss
              </Button>
            }
          >
            {actionError}
          </Notice>
        </div>
      )}

      <div className="atlas-workspace__tabs">
        <Tabs
          tabs={tabs}
          active={tab}
          label="Submission sections"
          onChange={(id) => onTabChange(id as SubmissionTab)}
        />
      </div>

      <div className="atlas-workspace__layout">
        <div className="atlas-stack">
          <TabPanel id="overview" active={tab}>
            <OverviewTab
              data={data}
              nextAction={nextAction}
              openMissingInfo={openMissingInfo.length}
              uncertainFields={uncertainFieldCount}
              redFlags={redFlags}
              missingFromExtraction={missingFromExtraction}
              activeDocuments={activeDocuments.length}
              extractionConfidence={extractionConfidence}
              onGoToTab={onTabChange}
              isBroker={isBroker}
            />
          </TabPanel>

          {!isBroker && (
            <TabPanel id="risk" active={tab}>
              <RiskInformationPanel
                submissionId={submissionId}
                extraction={extraction}
                extractionConfidence={extractionConfidence}
                canWrite={canWrite}
                canManage={canManage}
                extracting={extracting}
                onExtract={() => {
                  if (forceRetry) {
                    setForceRetry(false);
                    onExtract(true);
                  } else {
                    onExtract();
                  }
                }}
                onSave={async (extractionId, reviewedJson) => {
                  await saveReview(submissionId, extractionId, reviewedJson);
                  await load({ silent: true });
                  toast.notify("Corrections saved. Rerun the analysis to use them.", "success");
                }}
              />
            </TabPanel>
          )}

          {!isBroker && (
            <TabPanel id="recommendation" active={tab}>
              <RecommendationPanel
                submissionId={submissionId}
                recommendation={data.recommendation}
                extractionExists={Boolean(extraction)}
                extractionReviewed={reviewed}
                extractionConfidence={extractionConfidence}
                openMissingInfo={openMissingInfo}
                onRefresh={() => load({ silent: true })}
                onGoToTab={onTabChange}
              />
            </TabPanel>
          )}

          {!isBroker && (
            <TabPanel id="quote-review" active={tab}>
              <QuoteReviewPanel
                submissionId={submissionId}
                data={data}
                extractionReviewed={reviewed}
                extractionConfidence={extractionConfidence}
                onRefresh={() => load({ silent: true })}
                onGoToTab={onTabChange}
              />
            </TabPanel>
          )}

          <TabPanel id="missing-information" active={tab}>
            <MissingInfoPanel
              submissionId={submissionId}
              items={data.missingInfo}
              quoteReviewId={data.quoteReview?.id ?? null}
              canWrite={canWrite}
              onRefresh={() => load({ silent: true })}
              onGoToTab={onTabChange}
            />
          </TabPanel>

          <TabPanel id="documents" active={tab}>
            <DocumentsTab
              documents={documents}
              extraction={extraction}
              canManage={canManage}
              extracting={extracting}
              onExtract={() => {
                if (forceRetry) {
                  setForceRetry(false);
                  onExtract(true);
                } else {
                  onExtract();
                }
              }}
            />
          </TabPanel>

          {!isBroker && (
            <TabPanel id="communications" active={tab}>
              <CommunicationsPanel
                submissionId={submissionId}
                data={data}
                canWrite={canWrite}
                onRefresh={() => load({ silent: true })}
              />
            </TabPanel>
          )}

          <TabPanel id="history" active={tab}>
            <AuditTimeline submissionId={submissionId} />
          </TabPanel>
        </div>

        <aside className="atlas-workspace__rail" aria-label="Submission context">
          <ProcessingRail
            jobs={jobs}
            onCancel={async (jobId) => {
              try {
                await cancelJob(jobId);
                void load({ silent: true });
              } catch {
                // Cancellation is best-effort; polling will pick up the new state
              }
            }}
          />

          <div className="atlas-workspace__rail-card">
            <h2 className="atlas-workspace__rail-title">Ownership</h2>
            <dl className="atlas-workspace__rail-facts">
              <div className="atlas-workspace__rail-fact">
                <dt>Owner</dt>
                <dd>{submission.assigned_to_email || submission.assigned_to || "Shared queue"}</dd>
              </div>
              <div className="atlas-workspace__rail-fact">
                <dt>Queue state</dt>
                <dd>
                  <StatusBadge status={queueStatus(submission.queue_status)} />
                </dd>
              </div>
              <div className="atlas-workspace__rail-fact">
                <dt>Priority</dt>
                <dd>
                  <StatusBadge status={priorityStatus(submission.priority)} />
                </dd>
              </div>
              <div className="atlas-workspace__rail-fact">
                <dt>Due</dt>
                <dd>{submission.due_at ? formatDate(submission.due_at) : "Not set"}</dd>
              </div>
            </dl>
            {canWrite && !isBroker && (
              <div style={{ marginTop: "var(--atlas-space-3)" }}>
                <Button size="sm" icon="edit" block onClick={() => setAssignmentOpen(true)}>
                  Change assignment
                </Button>
              </div>
            )}
          </div>

          {!isBroker && (
            <PilotRailCard
              submissionId={submissionId}
              pilotFlag={submission.pilot_flag ?? false}
              pilotNotes={submission.pilot_notes ?? ""}
              canWrite={canWrite}
              canManage={canManage}
              onSaved={() => load({ silent: true })}
            />
          )}

          <div className="atlas-workspace__rail-card">
            <h2 className="atlas-workspace__rail-title">Outstanding</h2>
            <dl className="atlas-workspace__rail-facts">
              <RailCount
                label="Missing information"
                value={openMissingInfo.length}
                onClick={() => onTabChange("missing-information")}
              />
              {!isBroker && (
                <>
                  <RailCount
                    label="Uncertain risk fields"
                    value={uncertainFieldCount}
                    onClick={() => onTabChange("risk")}
                  />
                  <RailCount label="Risk concerns raised" value={redFlags.length} onClick={() => onTabChange("risk")} />
                </>
              )}
              <RailCount label="Active documents" value={activeDocuments.length} onClick={() => onTabChange("documents")} />
            </dl>
          </div>

          <div className="atlas-workspace__rail-card">
            <h2 className="atlas-workspace__rail-title">Record</h2>
            <dl className="atlas-workspace__rail-facts">
              <div className="atlas-workspace__rail-fact">
                <dt>Created</dt>
                <dd title={formatDateTime(submission.created_at)}>{formatDate(submission.created_at)}</dd>
              </div>
              <div className="atlas-workspace__rail-fact">
                <dt>Last movement</dt>
                <dd title={formatDateTime(submission.updated_at)}>{formatRelative(submission.updated_at)}</dd>
              </div>
              <div className="atlas-workspace__rail-fact">
                <dt>Reference</dt>
                <dd className="atlas-mono">{submissionReference(submission.id)}</dd>
              </div>
            </dl>
          </div>
        </aside>
      </div>

      {!isBroker && (
        <AssignmentDrawer
          open={assignmentOpen}
          submissionId={submissionId}
          submission={submission}
          onClose={() => setAssignmentOpen(false)}
          onSaved={async () => {
            setAssignmentOpen(false);
            await load({ silent: true });
            toast.notify("Assignment updated.", "success");
          }}
        />
      )}
    </div>
  );
}

/* ===========================================================================
   Context header
   =========================================================================== */

function WorkspaceHeader({
  submission,
  onBack,
  primaryAction,
}: {
  submission: SubmissionRecord;
  onBack: () => void;
  primaryAction: ReactNode;
}) {
  return (
    <>
      <nav aria-label="Breadcrumb">
        <ol className="atlas-breadcrumbs">
          <li>
            <button type="button" onClick={onBack}>
              Work queue
            </button>
            <Icon name="chevron-right" size={12} className="atlas-breadcrumbs__sep" />
          </li>
          <li>
            <span>{submission.client_name || "Untitled submission"}</span>
          </li>
        </ol>
      </nav>

      <section className="atlas-workspace__context" aria-label="Submission context">
        <div className="atlas-workspace__context-top">
          <div className="atlas-workspace__identity">
            <div className="atlas-workspace__client">
              <h1 className="atlas-title-page">{submission.client_name || "Untitled submission"}</h1>
              <span className="atlas-workspace__reference">{submissionReference(submission.id)}</span>
            </div>
            <div className="atlas-workspace__tags">
              <StatusBadge status={workflowStatus(submission.status)} strong />
              <StatusBadge status={priorityStatus(submission.priority)} prefix="Priority" />
              {submission.pilot_flag && (
                <span className="atlas-badge atlas-badge--info">
                  <span className="atlas-badge__label">Pilot</span>
                </span>
              )}
              <span className="atlas-badge atlas-badge--quiet">
                <span className="atlas-badge__label">{lineOfBusinessLabel(submission.line_of_business)}</span>
              </span>
              <span className="atlas-badge atlas-badge--quiet">
                <span className="atlas-badge__label">
                  {submission.request_type || "Risk type not captured"}
                </span>
              </span>
            </div>
          </div>
          <div className="atlas-page-header__actions">{primaryAction}</div>
        </div>

        <div className="atlas-workspace__context-facts">
          <FactItem label="Broker" value={submission.broker_name || EMPTY} title={submission.broker_email ?? undefined} />
          <FactItem label="Owner" value={submission.assigned_to_email || "Shared queue"} />
          <FactItem
            label="Last movement"
            value={formatRelative(submission.updated_at)}
            title={formatDateTime(submission.updated_at)}
          />
          <FactItem label="Due" value={submission.due_at ? formatDate(submission.due_at) : "Not set"} />
        </div>
      </section>
    </>
  );
}

function FactItem({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="atlas-statline__item">
      <span className="atlas-statline__label">{label}</span>
      <span className="atlas-statline__value atlas-truncate" title={title ?? value}>
        {value}
      </span>
    </div>
  );
}

function RailCount({
  label,
  value,
  onClick,
}: {
  label: string;
  value: number;
  onClick: () => void;
}) {
  return (
    <div className="atlas-workspace__rail-fact">
      <dt>{label}</dt>
      <dd>
        <button
          type="button"
          className="atlas-btn atlas-btn--link"
          onClick={onClick}
          style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}
        >
          {value}
        </button>
      </dd>
    </div>
  );
}

function MetricRow({
  label,
  value,
  onClick,
  emphasise,
}: {
  label: string;
  value: number;
  onClick: () => void;
  emphasise?: boolean;
}) {
  return (
    <div className={`atlas-uwsummary__count${emphasise ? " atlas-uwsummary__count--emphasise" : ""}`}>
      <dt>{label}</dt>
      <dd>
        <button
          type="button"
          className="atlas-btn atlas-btn--link"
          onClick={onClick}
          style={{ fontWeight: 600, fontVariantNumeric: "tabular-nums" }}
        >
          {value}
        </button>
      </dd>
    </div>
  );
}

/* ===========================================================================
   Next action
   =========================================================================== */

interface NextAction {
  label: string;
  why: string;
  /** The control the primary button should be. */
  kind:
    | "extract"
    | "review-risk"
    | "run-recommendation"
    | "review-recommendation"
    | "chase-info"
    | "record-decision"
    | "in-flight"
    | "none";
  tab: SubmissionTab;
  attention: boolean;
}

function deriveNextAction(input: {
  submission: SubmissionRecord;
  hasExtraction: boolean;
  reviewed: boolean;
  recommendation: Recommendation | null;
  quoteReview: QuoteReview | null;
  decision: Decision | null;
  openMissingInfo: number;
  canManage: boolean;
  activeJob?: ExpensiveJob;
}): NextAction {
  const { hasExtraction, reviewed, recommendation, quoteReview, decision, openMissingInfo, canManage, activeJob } =
    input;

  // A job in flight overrides every other next-action call — the header
  // primary button and the Next-action callout both reflect that the
  // expensive step is already running rather than inviting the user to
  // kick another one off.
  if (activeJob === "extraction") {
    return {
      label: "Extraction in progress",
      why: "Atlas is currently reading the documents. The recommendation and quote review become available once this finishes.",
      kind: "in-flight",
      tab: "overview",
      attention: false,
    };
  }
  if (activeJob === "recommendation") {
    return {
      label: "Recommendation in progress",
      why: "Atlas is scoring insurers against the reviewed risk information.",
      kind: "in-flight",
      tab: "recommendation",
      attention: false,
    };
  }
  if (activeJob === "quote_review") {
    return {
      label: "Quote review in progress",
      why: "Atlas is comparing the quoted terms against the reviewed risk information.",
      kind: "in-flight",
      tab: "quote-review",
      attention: false,
    };
  }

  if (!hasExtraction) {
    return {
      label: canManage ? "Run extraction" : "Waiting on extraction",
      why: canManage
        ? "Atlas has not read the documents yet. Extraction turns them into a structured risk summary."
        : "An underwriting manager needs to run the extraction before this submission can move forward.",
      kind: canManage ? "extract" : "none",
      tab: "risk",
      attention: true,
    };
  }

  if (!reviewed) {
    return {
      label: "Review extracted risk information",
      why:
        "Atlas will not produce a recommendation until a person has checked what it read from the documents. " +
        "Correct anything wrong, then save.",
      kind: "review-risk",
      tab: "risk",
      attention: true,
    };
  }

  if (!recommendation) {
    return {
      label: "Run the insurer recommendation",
      why: "The risk information is reviewed. Atlas can now check it against insurer appetite.",
      kind: "run-recommendation",
      tab: "recommendation",
      attention: false,
    };
  }

  if (openMissingInfo > 0) {
    return {
      label: "Follow up outstanding information",
      why: `${openMissingInfo} item${openMissingInfo === 1 ? "" : "s"} of information is still outstanding and may change the outcome.`,
      kind: "chase-info",
      tab: "missing-information",
      attention: true,
    };
  }

  if (!quoteReview) {
    return {
      label: "Review the recommendation",
      why: "Atlas has ranked the insurers. Read the reasoning before taking the submission forward.",
      kind: "review-recommendation",
      tab: "recommendation",
      attention: false,
    };
  }

  if (!decision) {
    return {
      label: "Record the placement decision",
      why: "The quote review is complete. Record the insurer and outcome you are prepared to stand behind.",
      kind: "record-decision",
      tab: "quote-review",
      attention: true,
    };
  }

  return {
    label: "Decision recorded",
    why: "A decision is on file for this submission. Re-run the analysis if the risk information changes.",
    kind: "none",
    tab: "quote-review",
    attention: false,
  };
}

function NextActionButton({
  action,
  extracting,
  canWrite,
  onExtract,
  onGoToTab,
}: {
  action: NextAction;
  extracting: boolean;
  canWrite: boolean;
  onExtract: () => void;
  onGoToTab: (tab: SubmissionTab) => void;
}) {
  if (action.kind === "none") {
    return (
      <Button iconAfter="arrow-right" onClick={() => onGoToTab(action.tab)}>
        {action.label}
      </Button>
    );
  }
  if (action.kind === "in-flight") {
    // While a job is running the primary is disabled — a second "Run
    // extraction" click on top of the running one would either be
    // rejected by the API or (worse) queue a duplicate. The button
    // still routes to the tab the job belongs to for context.
    return (
      <Button
        variant="primary"
        loading
        loadingLabel={action.label}
        disabled
        onClick={() => onGoToTab(action.tab)}
      >
        {action.label}
      </Button>
    );
  }
  if (action.kind === "extract") {
    return (
      <Button
        variant="primary"
        loading={extracting}
        loadingLabel="Extracting…"
        disabled={!canWrite}
        onClick={onExtract}
      >
        {action.label}
      </Button>
    );
  }
  return (
    <Button variant="primary" iconAfter="arrow-right" onClick={() => onGoToTab(action.tab)}>
      {action.label}
    </Button>
  );
}

/* ===========================================================================
   Overview tab
   =========================================================================== */

function OverviewTab({
  data,
  nextAction,
  openMissingInfo,
  uncertainFields,
  redFlags,
  missingFromExtraction,
  activeDocuments,
  extractionConfidence,
  onGoToTab,
  isBroker,
}: {
  data: WorkspaceData;
  nextAction: NextAction;
  openMissingInfo: number;
  uncertainFields: number;
  redFlags: unknown[];
  missingFromExtraction: unknown[];
  activeDocuments: number;
  extractionConfidence: ExtractionConfidenceState;
  onGoToTab: (tab: SubmissionTab) => void;
  isBroker: boolean;
}) {
  const { recommendation, quoteReview, decision, payload } = data;
  const top = recommendation?.reasoning_json.top ?? null;

  // Phase 3: broker-safe overview. Never render recommendation reasoning,
  // insurer ranking, quote-review analysis, decision internals, extraction
  // trust, or risk concerns. Broker sees operational status only.
  if (isBroker) {
    return (
      <div className="atlas-stack">
        <div className="atlas-nextaction">
          <div>
            <p className="atlas-nextaction__label">Case status</p>
            <p className="atlas-nextaction__text">
              {openMissingInfo > 0
                ? "Outstanding information requested"
                : "With the underwriter"}
            </p>
            <p className="atlas-nextaction__why">
              You will be notified when the underwriter needs more from you.
            </p>
          </div>
        </div>
        <div className="atlas-uwsummary">
          <aside className="atlas-uwsummary__metrics" aria-label="Operational metrics">
            <dl className="atlas-uwsummary__counts">
              <MetricRow
                label="Outstanding information"
                value={openMissingInfo}
                onClick={() => onGoToTab("missing-information")}
                emphasise={openMissingInfo > 0}
              />
              <MetricRow
                label="Active documents"
                value={activeDocuments}
                onClick={() => onGoToTab("documents")}
              />
            </dl>
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div className="atlas-stack">
      <div className={`atlas-nextaction ${nextAction.attention ? "atlas-nextaction--attention" : ""}`}>
        <div>
          <p className="atlas-nextaction__label">Next action</p>
          <p className="atlas-nextaction__text">{nextAction.label}</p>
          <p className="atlas-nextaction__why">{nextAction.why}</p>
        </div>
        <Button iconAfter="arrow-right" onClick={() => onGoToTab(nextAction.tab)}>
          Go there
        </Button>
      </div>

      <div className="atlas-uwsummary">
        <section className="atlas-uwsummary__primary" aria-labelledby="atlas-uwsummary-heading">
          <div className="atlas-uwsummary__head">
            <p className="atlas-uwsummary__eyebrow">Underwriting summary</p>
            <h2 id="atlas-uwsummary-heading" className="atlas-uwsummary__title">
              {top
                ? top.insurer_name
                : recommendation
                ? "No insurer cleared appetite"
                : "Recommendation not run yet"}
            </h2>
          </div>

          <p className="atlas-uwsummary__body">
            {top
              ? `Atlas ranked ${top.insurer_name} first against the reviewed risk information. Open the recommendation to read the reasoning before you commit.`
              : recommendation
              ? "Every insurer with active appetite rules was ruled out. Review the failures on the recommendation tab — a referral, or a correction to the risk information, may change the outcome."
              : payload.extraction
              ? payload.extraction.reviewed_json
                ? "The risk information is reviewed. Atlas can now check it against insurer appetite."
                : "Atlas has read the documents. Confirm the risk information, then run the recommendation."
              : "Atlas has not read the documents yet. Extraction turns them into a structured risk summary."}
          </p>

          {recommendation?.referral_required && (
            <div className="atlas-uwsummary__notice">
              <Notice tone="referral" title="This submission requires a referral">
                At least one insurer rule for this risk sits outside standard authority. Open the
                recommendation to see which trigger applies, then prepare a referral pack.
              </Notice>
            </div>
          )}

          <dl className="atlas-uwsummary__facts">
            <div className="atlas-uwsummary__fact">
              <dt>Quote review</dt>
              <dd>
                {quoteReview ? (
                  <StatusBadge status={quoteReviewStatus(quoteReview.status)} />
                ) : (
                  <span className="atlas-text-muted">Not run yet</span>
                )}
              </dd>
            </div>
            <div className="atlas-uwsummary__fact">
              <dt>Decision</dt>
              <dd>
                {decision ? (
                  <span>
                    {decision.selected_insurer || "Insurer not named"}
                    <span className="atlas-text-muted"> · {formatDate(decision.decided_at)}</span>
                  </span>
                ) : (
                  <span className="atlas-text-muted">Not recorded</span>
                )}
              </dd>
            </div>
          </dl>

          <div className="atlas-uwsummary__actions">
            {top ? (
              <Button
                variant="primary"
                iconAfter="arrow-right"
                onClick={() => onGoToTab("recommendation")}
              >
                Open the recommendation
              </Button>
            ) : recommendation ? (
              <Button iconAfter="arrow-right" onClick={() => onGoToTab("recommendation")}>
                Open the recommendation
              </Button>
            ) : (
              <Button iconAfter="arrow-right" onClick={() => onGoToTab("risk")}>
                Open risk information
              </Button>
            )}
          </div>
        </section>

        <aside className="atlas-uwsummary__metrics" aria-label="Operational metrics">
          <ExtractionTrustSummary
            extraction={payload.extraction}
            state={extractionConfidence}
            heading="Extraction trust"
          />

          <dl className="atlas-uwsummary__counts">
            <MetricRow
              label="Active documents"
              value={activeDocuments}
              onClick={() => onGoToTab("documents")}
            />
            <MetricRow
              label="Uncertain risk fields"
              value={uncertainFields}
              onClick={() => onGoToTab("risk")}
              emphasise={uncertainFields > 0}
            />
            <MetricRow
              label="Outstanding information"
              value={openMissingInfo}
              onClick={() => onGoToTab("missing-information")}
              emphasise={openMissingInfo > 0}
            />
            <MetricRow
              label="Risk concerns"
              value={redFlags.length}
              onClick={() => onGoToTab("risk")}
              emphasise={redFlags.length > 0}
            />
          </dl>
        </aside>
      </div>


      {redFlags.length > 0 && (
        <Card
          title="Risk concerns raised during extraction"
          description="Raised by Atlas from the source documents. Confirm each one against the evidence."
          actions={
            <Button size="sm" iconAfter="arrow-right" onClick={() => onGoToTab("risk")}>
              Open risk information
            </Button>
          }
        >
          <ul className="atlas-list">
            {redFlags.slice(0, 5).map((flag, index) => {
              const record = flag as { issue?: string; reason?: string; severity?: string };
              return (
                <li className="atlas-list__item" key={index}>
                  <div className="atlas-list__main">
                    <p className="atlas-list__title">{record.issue || "Concern"}</p>
                    <p className="atlas-list__meta">{record.reason}</p>
                  </div>
                  <div className="atlas-list__side">
                    <StatusBadge status={severityMeta(record.severity)} />
                  </div>
                </li>
              );
            })}
          </ul>
          {redFlags.length > 5 && (
            <p className="atlas-text-dense atlas-text-muted" style={{ marginTop: 12 }}>
              {redFlags.length - 5} further concern{redFlags.length - 5 === 1 ? "" : "s"} in the risk
              information tab.
            </p>
          )}
        </Card>
      )}

      {missingFromExtraction.length > 0 && openMissingInfo === 0 && (
        <Notice tone="warning" title="Extraction flagged information as missing">
          Atlas identified {missingFromExtraction.length} gap
          {missingFromExtraction.length === 1 ? "" : "s"} while reading the documents, but no tracked
          items have been created yet.
          <div style={{ marginTop: 8 }}>
            <Button size="sm" onClick={() => onGoToTab("missing-information")}>
              Open missing information
            </Button>
          </div>
        </Notice>
      )}
    </div>
  );
}

/* ===========================================================================
   Processing rail
   =========================================================================== */

const JOB_LABELS: Record<ExpensiveJob, string> = {
  extraction: "Extract risk details",
  recommendation: "Check insurer appetite",
  quote_review: "Review quote terms",
};

const EXTRACTION_STEPS = [
  { key: "reading_documents", label: "Reading documents", threshold: 0 },
  { key: "calling_extraction_model", label: "Analysing with AI", threshold: 10 },
  { key: "saving_extraction", label: "Saving extraction", threshold: 85 },
  { key: "completed", label: "Extracted", threshold: 100 },
];

function stepIndex(currentStep: string | null | undefined, percent: number): number {
  if (!currentStep && percent <= 0) return 0;
  const idx = EXTRACTION_STEPS.findIndex((s) => s.key === currentStep);
  if (idx >= 0) return idx;
  for (let i = EXTRACTION_STEPS.length - 1; i >= 0; i--) {
    if (percent >= EXTRACTION_STEPS[i].threshold) return i;
  }
  return 0;
}

function ExtractionStepTracker({ job }: { job: JobRecord | undefined }) {
  const done = job?.status === "completed";
  const failed = job?.status === "failed";
  const running = job?.status === "queued" || job?.status === "running";
  // No extraction job at all: render every dot as outlined and the
  // status label as "Not started". Nothing about the widget should imply
  // Atlas is currently reading anything.
  const notStarted = !job;
  const current = done
    ? EXTRACTION_STEPS.length - 1
    : notStarted
      ? -1
      : stepIndex(job?.current_step, job?.progress_percent ?? 0);

  return (
    <div style={{ padding: "4px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 0, position: "relative" }}>
        {EXTRACTION_STEPS.map((step, i) => {
          const isComplete = done || i < current;
          const isCurrent = !done && i === current && running;
          const isFailed = failed && i === current;
          return (
            <div key={step.key} style={{ display: "contents" }}>
              {i > 0 && (
                <div
                  style={{
                    flex: 1,
                    height: 2,
                    backgroundColor: isComplete
                      ? "var(--atlas-primary, #2563eb)"
                      : "var(--atlas-border, #e2e5ea)",
                    transition: "background-color 0.4s ease",
                  }}
                />
              )}
              <div
                style={{
                  width: isCurrent ? 18 : 14,
                  height: isCurrent ? 18 : 14,
                  borderRadius: "50%",
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "all 0.3s ease",
                  backgroundColor: isFailed
                    ? "var(--atlas-danger, #dc2626)"
                    : isComplete
                    ? "var(--atlas-primary, #2563eb)"
                    : isCurrent
                    ? "#fff"
                    : "var(--atlas-surface-sunken, #f0f2f5)",
                  border: isCurrent
                    ? "2.5px solid var(--atlas-primary, #2563eb)"
                    : isComplete
                    ? "none"
                    : "2px solid var(--atlas-border, #e2e5ea)",
                  boxShadow: isCurrent ? "0 0 0 3px var(--atlas-accent-glow)" : "none",
                  animation: isCurrent ? "atlas-pulse-ring 2s ease infinite" : "none",
                }}
              >
                {isComplete && (
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                    <path d="M2 6l3 3 5-5.5" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
                {isCurrent && (
                  <div
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      backgroundColor: "var(--atlas-primary, #2563eb)",
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
        {EXTRACTION_STEPS.map((step, i) => {
          const isComplete = done || i < current;
          const isCurrent = !done && i === current && running;
          return (
            <span
              key={step.key}
              style={{
                fontSize: 10,
                fontWeight: isCurrent ? 600 : 400,
                color: isComplete || isCurrent
                  ? "var(--atlas-ink, #1a1a1a)"
                  : "var(--atlas-ink-subtle, #999)",
                textAlign: "center",
                flex: 1,
                lineHeight: 1.3,
              }}
            >
              {step.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

const EXTRACTION_TIPS = [
  "Always cross-check the sum insured against the asset schedule — mismatches are the most common source of under-insurance.",
  "A renewal date within 14 days of the quote date often signals urgency — flag it for the broker.",
  "SASRIA cover is compulsory on most short-term policies in South Africa. If it's missing, that's a red flag.",
  "Look for gaps between the current cover sections and what the broker is requesting — they may indicate intentional changes or oversights.",
  "Claims history with a loss ratio above 60% in the last three years warrants closer scrutiny on excess levels.",
  "Body corporate policies should always specify whether common property, owners' units, or both are covered.",
  "When sums insured haven't changed in over two years, consider whether inflation has been accounted for.",
  "Warranty compliance is one of the top reasons claims get repudiated — always verify the client can meet them.",
  "A quote with no excess on all-risk items is unusual and may indicate the premium hasn't been optimised.",
  "If the broker email mentions 'like-for-like', compare every section against the current schedule — don't assume it's identical.",
  "Motor schedules should include VIN numbers. Duplicate or missing VINs are a sign of a copy-paste error.",
  "Public liability limits below R10m for commercial risks are increasingly considered inadequate in the SA market.",
  "Required documents lists are often buried in endorsements — Atlas pulls them out so you don't miss them.",
  "When multiple insurers quote, compare not just premiums but excess structures and exclusion wording.",
  "Sectional title schemes need separate sums for buildings, common property, and owners' improvements.",
];

function RotatingTip({ running }: { running: boolean }) {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * EXTRACTION_TIPS.length));

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      setIndex((prev) => (prev + 1) % EXTRACTION_TIPS.length);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [running]);

  if (!running) return null;

  return (
    <div
      style={{
        marginTop: 12,
        padding: "10px 12px",
        borderRadius: 6,
        backgroundColor: "var(--atlas-surface-raised, #f5f7fa)",
        borderLeft: "3px solid var(--atlas-primary, #2563eb)",
        fontSize: 12,
        lineHeight: 1.5,
        color: "var(--atlas-ink-secondary, #555)",
      }}
    >
      <span style={{ fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--atlas-primary, #2563eb)" }}>
        Underwriting tip
      </span>
      <p style={{ margin: "4px 0 0" }}>{EXTRACTION_TIPS[index]}</p>
    </div>
  );
}

function ProcessingRail({ jobs, onCancel }: { jobs: Partial<Record<ExpensiveJob, JobRecord>> | undefined; onCancel?: (jobId: string) => void }) {
  if (!jobs) return null;
  const extractionJob = jobs.extraction;
  const extractionRunning = extractionJob?.status === "queued" || extractionJob?.status === "running";
  const extractionCancelling = extractionRunning && extractionJob?.cancellation_requested;
  const extractionNotStarted = !extractionJob;

  return (
    <div className="atlas-workspace__rail-card">
      <h2 className="atlas-workspace__rail-title">Processing</h2>

      <div style={{ marginBottom: 12 }}>
        <span className="atlas-text-dense" style={{ display: "block", marginBottom: 8 }}>
          {JOB_LABELS.extraction}
        </span>
        <ExtractionStepTracker job={extractionJob} />
        {extractionNotStarted && (
          <p className="atlas-text-muted" style={{ fontSize: 12, marginTop: 4 }}>
            Not started
          </p>
        )}
        {/*
         * Cancel is only rendered while a job is genuinely queued or
         * running. On a fresh submission with no extraction requested
         * the button is hidden entirely — never a red action next to
         * dots that claim nothing is in flight.
         */}
        {extractionRunning && extractionJob?.id && onCancel && (
          <button
            type="button"
            className="atlas-btn atlas-btn--sm atlas-btn--ghost"
            style={{ marginTop: 8, color: "var(--atlas-danger)" }}
            disabled={!!extractionCancelling}
            onClick={() => onCancel(extractionJob.id!)}
          >
            {extractionCancelling ? "Cancelling…" : "Cancel extraction"}
          </button>
        )}
        {!extractionRunning && extractionJob && extractionJob.status !== "completed" && (extractionJob.completed_at || extractionJob.created_at) && (
          <p className="atlas-text-muted" style={{ fontSize: 12, marginTop: 4 }}>
            {formatRelative(extractionJob.completed_at ?? extractionJob.created_at)}
          </p>
        )}
      </div>

      {(["recommendation", "quote_review"] as const).map((key) => {
        const job = jobs[key];
        const stage = processingStage(job?.status, key);
        const running = job?.status === "queued" || job?.status === "running";
        return (
          <div key={key} style={{ marginBottom: 8 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <span className="atlas-text-dense">{JOB_LABELS[key]}</span>
              <StatusBadge status={stage} />
            </div>
            {running ? (
              <div style={{ marginTop: 6 }}>
                <ProgressStages
                  percent={job?.progress_percent ?? null}
                  caption={
                    job?.current_step
                      ? job.current_step.replace(/_/g, " ")
                      : "Processing"
                  }
                />
              </div>
            ) : (
              (job?.completed_at || job?.created_at) && (
                <p className="atlas-text-muted" style={{ fontSize: 12, marginTop: 3 }}>
                  {formatRelative(job.completed_at ?? job.created_at)}
                </p>
              )
            )}
          </div>
        );
      })}

      <RotatingTip running={extractionRunning} />
    </div>
  );
}

/* ===========================================================================
   Pilot rail card
   =========================================================================== */

function PilotRailCard({
  submissionId,
  pilotFlag,
  pilotNotes,
  canWrite,
  canManage,
  onSaved,
}: {
  submissionId: string;
  pilotFlag: boolean;
  pilotNotes: string;
  canWrite: boolean;
  canManage: boolean;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [notes, setNotes] = useState(pilotNotes);
  const [editingNotes, setEditingNotes] = useState(false);

  const [issues, setIssues] = useState<PilotIssue[]>([]);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issuesExpanded, setIssuesExpanded] = useState(false);
  const [creatingIssue, setCreatingIssue] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newSeverity, setNewSeverity] = useState("medium");
  const [editingIssueId, setEditingIssueId] = useState<string | null>(null);
  const [editStatus, setEditStatus] = useState("");
  const [editSeverity, setEditSeverity] = useState("");
  const [editResolutionNotes, setEditResolutionNotes] = useState("");

  useEffect(() => setNotes(pilotNotes), [pilotNotes]);

  const loadIssues = useCallback(async () => {
    if (!pilotFlag) return;
    setIssuesLoading(true);
    try {
      const result = await listPilotIssues(submissionId);
      setIssues(result.issues);
    } catch {
      // silent — issues are supplementary
    } finally {
      setIssuesLoading(false);
    }
  }, [submissionId, pilotFlag]);

  useEffect(() => {
    if (pilotFlag && issuesExpanded) void loadIssues();
  }, [pilotFlag, issuesExpanded, loadIssues]);

  async function togglePilot() {
    setSaving(true);
    try {
      await updatePilotFlag(submissionId, {
        pilot_flag: !pilotFlag,
        pilot_notes: notes || null,
      });
      onSaved();
      toast.notify(
        pilotFlag ? "Pilot flag removed." : "Submission marked as pilot.",
        "success"
      );
    } catch {
      toast.notify("Could not update pilot status.", "danger");
    } finally {
      setSaving(false);
    }
  }

  async function saveNotes() {
    setSaving(true);
    try {
      await updatePilotFlag(submissionId, {
        pilot_flag: pilotFlag,
        pilot_notes: notes || null,
      });
      setEditingNotes(false);
      onSaved();
    } catch {
      toast.notify("Could not save pilot notes.", "danger");
    } finally {
      setSaving(false);
    }
  }

  async function submitNewIssue() {
    if (!newTitle.trim()) return;
    setSaving(true);
    try {
      await createPilotIssue(submissionId, {
        title: newTitle.trim(),
        description: newDescription.trim() || undefined,
        severity: newSeverity,
      });
      setNewTitle("");
      setNewDescription("");
      setNewSeverity("medium");
      setCreatingIssue(false);
      toast.notify("Pilot issue created.", "success");
      await loadIssues();
    } catch {
      toast.notify("Could not create pilot issue.", "danger");
    } finally {
      setSaving(false);
    }
  }

  function startEditIssue(issue: PilotIssue) {
    setEditingIssueId(issue.id);
    setEditStatus(issue.status);
    setEditSeverity(issue.severity);
    setEditResolutionNotes(issue.resolution_notes ?? "");
  }

  async function saveIssueUpdate() {
    if (!editingIssueId) return;
    setSaving(true);
    try {
      await updatePilotIssue(editingIssueId, {
        status: editStatus,
        severity: editSeverity,
        resolution_notes: editResolutionNotes || null,
      });
      setEditingIssueId(null);
      toast.notify("Pilot issue updated.", "success");
      await loadIssues();
    } catch {
      toast.notify("Could not update pilot issue.", "danger");
    } finally {
      setSaving(false);
    }
  }

  const openIssueCount = issues.filter((i) => i.status === "open" || i.status === "in_progress").length;

  return (
    <div className="atlas-workspace__rail-card">
      <h2 className="atlas-workspace__rail-title">Pilot</h2>
      <dl className="atlas-workspace__rail-facts">
        <div className="atlas-workspace__rail-fact">
          <dt>Pilot case</dt>
          <dd>
            <StatusBadge
              status={
                pilotFlag
                  ? { label: "Yes", tone: "info" as const }
                  : { label: "No", tone: "neutral" as const }
              }
            />
          </dd>
        </div>
        {pilotFlag && pilotNotes && !editingNotes && (
          <div className="atlas-workspace__rail-fact">
            <dt>Notes</dt>
            <dd className="atlas-text-dense">{pilotNotes}</dd>
          </div>
        )}
      </dl>
      {canWrite && (
        <div style={{ marginTop: "var(--atlas-space-3)", display: "flex", flexDirection: "column", gap: "var(--atlas-space-2)" }}>
          <Button size="sm" block loading={saving} onClick={togglePilot}>
            {pilotFlag ? "Remove pilot flag" : "Mark as pilot"}
          </Button>
          {pilotFlag && !editingNotes && (
            <Button size="sm" block onClick={() => setEditingNotes(true)}>
              {pilotNotes ? "Edit notes" : "Add notes"}
            </Button>
          )}
          {pilotFlag && editingNotes && (
            <>
              <textarea
                className="atlas-input"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Pilot notes…"
              />
              <div style={{ display: "flex", gap: "var(--atlas-space-2)" }}>
                <Button size="sm" variant="primary" loading={saving} onClick={saveNotes}>
                  Save
                </Button>
                <Button size="sm" onClick={() => { setEditingNotes(false); setNotes(pilotNotes); }}>
                  Cancel
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {pilotFlag && (
        <div style={{ marginTop: "var(--atlas-space-4)", borderTop: "1px solid var(--atlas-border)", paddingTop: "var(--atlas-space-3)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--atlas-space-2)" }}>
            <button
              type="button"
              className="atlas-btn atlas-btn--link"
              style={{ fontWeight: 600, fontSize: 13, padding: 0 }}
              onClick={() => setIssuesExpanded(!issuesExpanded)}
            >
              Issues {openIssueCount > 0 && `(${openIssueCount} open)`}
              <Icon name={issuesExpanded ? "chevron-down" : "chevron-right"} size={12} />
            </button>
            {canWrite && issuesExpanded && !creatingIssue && (
              <Button size="sm" onClick={() => setCreatingIssue(true)}>
                New
              </Button>
            )}
          </div>

          {issuesExpanded && creatingIssue && (
            <div className="atlas-form" style={{ marginBottom: "var(--atlas-space-3)" }}>
              <TextField
                label="Title"
                value={newTitle}
                placeholder="Brief description of the issue"
                onChange={(e) => setNewTitle(e.target.value)}
              />
              <TextAreaField
                label="Description"
                value={newDescription}
                placeholder="Additional context (optional)"
                onChange={(e) => setNewDescription(e.target.value)}
                rows={2}
              />
              <SelectField
                label="Severity"
                value={newSeverity}
                options={[
                  { value: "low", label: "Low" },
                  { value: "medium", label: "Medium" },
                  { value: "high", label: "High" },
                  { value: "critical", label: "Critical" },
                ]}
                onChange={(e) => setNewSeverity(e.target.value)}
              />
              <div style={{ display: "flex", gap: "var(--atlas-space-2)" }}>
                <Button size="sm" variant="primary" loading={saving} disabled={!newTitle.trim()} onClick={submitNewIssue}>
                  Create issue
                </Button>
                <Button size="sm" onClick={() => { setCreatingIssue(false); setNewTitle(""); setNewDescription(""); setNewSeverity("medium"); }}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {issuesExpanded && issuesLoading && <p className="atlas-text-muted" style={{ fontSize: 12 }}>Loading issues…</p>}

          {issuesExpanded && !issuesLoading && issues.length === 0 && (
            <p className="atlas-text-muted" style={{ fontSize: 12 }}>No pilot issues recorded.</p>
          )}

          {issuesExpanded && !issuesLoading && issues.map((issue) => (
            <div
              key={issue.id}
              style={{
                padding: "var(--atlas-space-2)",
                marginBottom: "var(--atlas-space-2)",
                borderRadius: "var(--atlas-radius-card)",
                border: "1px solid var(--atlas-border)",
                fontSize: 13,
              }}
            >
              {editingIssueId === issue.id ? (
                <div className="atlas-form" style={{ gap: "var(--atlas-space-2)" }}>
                  <p className="atlas-text-dense" style={{ fontWeight: 600, margin: 0 }}>{issue.title}</p>
                  <SelectField
                    label="Status"
                    value={editStatus}
                    options={[
                      { value: "open", label: "Open" },
                      { value: "in_progress", label: "In progress" },
                      { value: "resolved", label: "Resolved" },
                      { value: "wont_fix", label: "Won't fix" },
                    ]}
                    onChange={(e) => setEditStatus(e.target.value)}
                  />
                  <SelectField
                    label="Severity"
                    value={editSeverity}
                    options={[
                      { value: "low", label: "Low" },
                      { value: "medium", label: "Medium" },
                      { value: "high", label: "High" },
                      { value: "critical", label: "Critical" },
                    ]}
                    onChange={(e) => setEditSeverity(e.target.value)}
                  />
                  <TextAreaField
                    label="Resolution notes"
                    value={editResolutionNotes}
                    placeholder="Optional resolution notes"
                    onChange={(e) => setEditResolutionNotes(e.target.value)}
                    rows={2}
                  />
                  <div style={{ display: "flex", gap: "var(--atlas-space-2)" }}>
                    <Button size="sm" variant="primary" loading={saving} onClick={saveIssueUpdate}>
                      Save
                    </Button>
                    <Button size="sm" onClick={() => setEditingIssueId(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 4 }}>
                    <p style={{ fontWeight: 600, margin: 0, lineHeight: 1.3 }}>{issue.title}</p>
                    <StatusBadge status={severityMeta(issue.severity)} />
                  </div>
                  {issue.description && (
                    <p className="atlas-text-muted" style={{ fontSize: 12, margin: "4px 0 0" }}>{issue.description}</p>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                    <StatusBadge
                      status={{
                        label: issue.status.replace(/_/g, " "),
                        tone: issue.status === "resolved" ? "success" : issue.status === "wont_fix" ? "neutral" : issue.status === "in_progress" ? "info" : "warning",
                      }}
                    />
                    <span className="atlas-text-muted" style={{ fontSize: 11 }}>
                      {formatRelative(issue.created_at)}
                    </span>
                  </div>
                  {issue.resolution_notes && (
                    <p className="atlas-text-muted" style={{ fontSize: 12, margin: "4px 0 0", fontStyle: "italic" }}>
                      {issue.resolution_notes}
                    </p>
                  )}
                  {canManage && (
                    <div style={{ marginTop: 6 }}>
                      <Button size="sm" onClick={() => startEditIssue(issue)}>
                        Update
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ===========================================================================
   Assignment drawer
   =========================================================================== */

function AssignmentDrawer({
  open,
  submissionId,
  submission,
  onClose,
  onSaved,
}: {
  open: boolean;
  submissionId: string;
  submission: SubmissionRecord;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [assignedTo, setAssignedTo] = useState("");
  const [queue, setQueue] = useState("new");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAssignedTo(submission.assigned_to ?? submission.assigned_underwriter ?? "");
    setQueue(submission.queue_status ?? "new");
    setError(null);
  }, [open, submission]);

  const dirty =
    assignedTo !== (submission.assigned_to ?? submission.assigned_underwriter ?? "") ||
    queue !== (submission.queue_status ?? "new");

  async function onSave() {
    setSaving(true);
    setError(null);
    try {
      await updateAssignment(submissionId, {
        assigned_to: assignedTo.trim() || null,
        queue_status: queue as "new" | "in_review" | "waiting_info" | "referred" | "completed" | "archived",
      });
      onSaved();
    } catch {
      setError("The assignment could not be saved. Check the user identifier and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      open={open}
      title="Change assignment"
      description="Assignment records visible ownership. It does not restrict who can open the submission."
      onClose={onClose}
      dirty={dirty && !saving}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onSave} loading={saving} loadingLabel="Saving…">
            Save assignment
          </Button>
        </>
      }
    >
      <div className="atlas-form">
        {error && <Notice tone="danger">{error}</Notice>}
        <TextField
          label="Assigned user"
          optional
          value={assignedTo}
          placeholder="Leave empty for the shared queue"
          hint="The Atlas user identifier of the person who owns this submission."
          onChange={(event) => setAssignedTo(event.target.value)}
        />
        <SelectField
          label="Queue state"
          value={queue}
          options={QUEUE_STATUS_OPTIONS}
          hint="Queue state tracks who is waiting on what. It is separate from the underwriting stage."
          onChange={(event) => setQueue(event.target.value)}
        />
      </div>
    </Drawer>
  );
}

export type { SubmissionRecord, JobRecord };
