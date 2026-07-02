import { useEffect, useState } from "react";
import { getManagerStatsFiltered, type ManagerStats } from "../lib/phase4";
import { cleanupPreview, getSystemStatus, listJobs, type AtlasJob, type JobSummary, type SystemStatus } from "../lib/phase7";

export default function ManagerDashboard({ onBack }: { onBack: () => void }) {
  const [stats, setStats] = useState<ManagerStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<"7d" | "30d" | "90d" | "all">("30d");
  const [status, setStatus] = useState("");
  const [outcome, setOutcome] = useState("");
  const [insurerId, setInsurerId] = useState("");
  const [consultantId, setConsultantId] = useState("");
  const [lineOfBusiness, setLineOfBusiness] = useState("");
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [jobs, setJobs] = useState<AtlasJob[]>([]);
  const [jobSummary, setJobSummary] = useState<JobSummary | null>(null);
  const [cleanupCount, setCleanupCount] = useState<number | null>(null);

  useEffect(() => {
    getManagerStatsFiltered({
      date_range: dateRange,
      status: status || undefined,
      outcome: outcome || undefined,
      insurer_id: insurerId || undefined,
      consultant_id: consultantId || undefined,
      line_of_business: lineOfBusiness || undefined,
    })
      .then((res) => setStats(res.stats))
      .catch(() => setError("Could not load manager visibility."));
  }, [dateRange, status, outcome, insurerId, consultantId, lineOfBusiness]);

  useEffect(() => {
    Promise.all([getSystemStatus(), listJobs(), cleanupPreview()])
      .then(([system, jobRes, cleanup]) => {
        setSystemStatus(system);
        setJobs(jobRes.jobs);
        setJobSummary(jobRes.summary);
        setCleanupCount(cleanup.expired_active_documents.length);
      })
      .catch(() => {
        // Keep underwriting stats visible even if ops status fails.
      });
  }, []);

  if (error) return <div className="atlas-card">{error}</div>;
  if (!stats) return <div className="atlas-card">Loading...</div>;

  return (
    <div>
      <button className="atlas-btn" onClick={onBack} style={{ marginBottom: 16 }}>
        Back to submissions
      </button>
      <div className="atlas-page-head">
        <h1>Manager visibility</h1>
        <p>Quote review outcomes, missing information, referrals, and overrides.</p>
      </div>
      <div className="atlas-card atlas-manager-filters">
        <div className="atlas-form__row">
          <label>Date range</label>
          <select value={dateRange} onChange={(e) => setDateRange(e.target.value as typeof dateRange)}>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
            <option value="all">All time</option>
          </select>
        </div>
        <div className="atlas-form__row">
          <label>Status</label>
          <input value={status} onChange={(e) => setStatus(e.target.value)} placeholder="refer, declined..." />
        </div>
        <div className="atlas-form__row">
          <label>Outcome</label>
          <input value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="can_proceed, info_required..." />
        </div>
        <div className="atlas-form__row">
          <label>Insurer ID</label>
          <input value={insurerId} onChange={(e) => setInsurerId(e.target.value)} />
        </div>
        <div className="atlas-form__row">
          <label>Consultant ID</label>
          <input value={consultantId} onChange={(e) => setConsultantId(e.target.value)} />
        </div>
        <div className="atlas-form__row">
          <label>Line of business</label>
          <select value={lineOfBusiness} onChange={(e) => setLineOfBusiness(e.target.value)}>
            <option value="">Any</option>
            <option value="personal">Personal</option>
            <option value="commercial">Commercial</option>
          </select>
        </div>
      </div>
      <div className="atlas-manager-grid">
        <Metric label="Submissions" value={stats.total_submissions} />
        <Metric label="Quote reviews" value={stats.quote_reviews_completed} />
        <Metric label="Open missing info" value={stats.missing_info_open_count} />
        <Metric label="Referrals" value={stats.referrals_count} />
        <Metric label="Declined" value={stats.declined_count} />
        <Metric label="Overrides" value={stats.overrides_count} />
        <Metric label="Communications" value={stats.communications_generated_count} />
        <Metric label="Sent manually" value={stats.communications_sent_manually_count} />
      </div>
      <div className="atlas-manager-grid atlas-manager-grid--wide">
        <List title="Reviews by status" items={Object.entries(stats.reviews_by_status).map(([label, count]) => ({ label, count }))} />
        <List title="Common missing information" items={stats.common_missing_information} />
        <List title="Common referral triggers" items={stats.common_referral_triggers} />
        <List title="Common declined reasons" items={stats.common_declined_reasons} />
      </div>
      <div className="atlas-card">
        <h3 className="atlas-h3">Recent reviews needing attention</h3>
        {stats.recent_reviews_needing_attention.length === 0 ? (
          <p className="atlas-muted">No recent reviews needing attention.</p>
        ) : (
          <ul className="atlas-checklist">
            {stats.recent_reviews_needing_attention.map((review) => (
              <li key={review.id}>
                <span className={`atlas-pri atlas-pri--${review.status === "declined" ? "high" : "medium"}`}>
                  {review.status}
                </span>
                <span>{new Date(review.created_at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <OperationsPanel
        systemStatus={systemStatus}
        jobs={jobs}
        jobSummary={jobSummary}
        cleanupCount={cleanupCount}
      />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="atlas-card atlas-manager-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function OperationsPanel({
  systemStatus,
  jobs,
  jobSummary,
  cleanupCount,
}: {
  systemStatus: SystemStatus | null;
  jobs: AtlasJob[];
  jobSummary: JobSummary | null;
  cleanupCount: number | null;
}) {
  return (
    <div className="atlas-card" style={{ marginTop: 16 }}>
      <h3 className="atlas-h3">Operational status</h3>
      {!systemStatus ? (
        <p className="atlas-muted">Operational status is not available.</p>
      ) : (
        <>
          <div className="atlas-manager-grid">
            <Metric label="Database" value={systemStatus.database.ok ? 1 : 0} />
            <Metric label="Failed jobs 24h" value={systemStatus.jobs_24h.failed_count} />
            <Metric label="Stuck jobs" value={systemStatus.jobs_24h.stuck_count} />
            <Metric label="Expired active docs" value={cleanupCount ?? 0} />
          </div>
          <p className="atlas-muted">
            Environment: {systemStatus.environment}. Storage: client bucket{" "}
            {systemStatus.storage.client_docs_bucket_configured ? "configured" : "missing"}, guideline bucket{" "}
            {systemStatus.storage.insurer_docs_bucket_configured ? "configured" : "missing"}.
          </p>
        </>
      )}
      <h4 className="atlas-h3">Recent failed or stuck jobs</h4>
      {!jobSummary || (jobSummary.recent_failed_jobs.length === 0 && jobSummary.stuck_jobs.length === 0) ? (
        <p className="atlas-muted">No recent failed or stuck jobs.</p>
      ) : (
        <ul className="atlas-checklist">
          {[...jobSummary.recent_failed_jobs, ...jobSummary.stuck_jobs].slice(0, 8).map((job) => (
            <li key={job.id}>
              <span className="atlas-pri atlas-pri--high">{job.status}</span>
              <span>
                {job.job_type} {job.error_code ? `- ${job.error_code}` : ""}{" "}
                {new Date(job.created_at).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
      {jobs.length > 0 && (
        <p className="atlas-muted">Last job: {jobs[0].job_type} / {jobs[0].status}</p>
      )}
    </div>
  );
}

function List({ title, items }: { title: string; items: { label: string; count: number }[] }) {
  return (
    <div className="atlas-card">
      <h3 className="atlas-h3">{title}</h3>
      {items.length === 0 ? (
        <p className="atlas-muted">No data yet.</p>
      ) : (
        <ul className="atlas-checklist">
          {items.map((item) => (
            <li key={item.label}>
              <span>{item.label}</span>
              <strong>{item.count}</strong>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
