/**
 * Atlas — insurer index
 * ----------------------------------------------------------------------------
 * The appetite matrix is what every recommendation reads from, so this screen's
 * job is to show which insurers Atlas can actually reason about and which are
 * data gaps.
 *
 * An insurer with no active rules is not a neutral state — it means Atlas will
 * silently skip that insurer on every submission. That is called out here
 * rather than left as a "0".
 */

import { useEffect, useMemo, useState } from "react";
import { createInsurer, listInsurers, type InsurerListItem } from "../lib/insurers";
import {
  Button,
  Card,
  Drawer,
  EmptyState,
  ErrorState,
  Metric,
  Notice,
  PageHeader,
  SearchInput,
  StatusBadge,
  TextAreaField,
  TextField,
  useToast,
} from "../components/ui";
import { canManage as roleCanManage, type AtlasUiRole } from "../components/AppShell";
import { humanise, pluralise } from "../lib/format";

export default function Insurers({
  role,
  onOpen,
}: {
  role: AtlasUiRole;
  onOpen: (id: string) => void;
}) {
  const canManage = roleCanManage(role);
  const toast = useToast();
  const [items, setItems] = useState<InsurerListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    listInsurers()
      .then((result) => {
        if (!live) return;
        setItems(result.insurers);
        setError(null);
      })
      .catch((cause: Error) => {
        if (!live) return;
        setError(
          cause.message === "not_authenticated"
            ? "Your session has expired. Sign in again to view the insurer list."
            : "The insurer list could not be loaded. The Atlas API did not respond."
        );
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [reloadToken]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return items;
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        (item.quote_channel ?? "").toLowerCase().includes(query)
    );
  }, [items, search]);

  const withRules = items.filter((item) => item.active_appetite_count > 0);
  const withoutRules = items.filter((item) => item.active_appetite_count === 0);

  if (error) {
    return (
      <div>
        <PageHeader
          eyebrow="Intelligence"
          title="Insurers"
          description="Guideline documents and the appetite rules every recommendation is scored against."
        />
        <ErrorState
          title="The insurer list could not be loaded"
          message={error}
          onRetry={() => setReloadToken((token) => token + 1)}
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Intelligence"
        title="Insurers"
        description="Guideline documents and the appetite rules every recommendation is scored against."
        actions={
          canManage ? (
            <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
              Add insurer
            </Button>
          ) : undefined
        }
      />

      <section className="atlas-metrics" aria-label="Matrix coverage" style={{ marginBottom: "var(--atlas-space-4)" }}>
        <Metric
          label="Insurers on file"
          value={items.length}
          loading={loading}
          hint="Every insurer Atlas knows about."
        />
        <Metric
          label="Scored on appetite"
          value={withRules.length}
          loading={loading}
          hint="Insurers with at least one active rule, so Atlas can consider them."
        />
        <Metric
          label="No active rules"
          value={withoutRules.length}
          loading={loading}
          tone={withoutRules.length > 0 ? "warning" : "default"}
          hint="Atlas skips these on every submission until a guideline is processed and confirmed."
        />
      </section>

      {withoutRules.length > 0 && (
        <div style={{ marginBottom: "var(--atlas-space-4)" }}>
          <Notice tone="warning" title={`${withoutRules.length} insurer${withoutRules.length === 1 ? "" : "s"} cannot be recommended`}>
            {withoutRules.map((item) => item.name).join(", ")}{" "}
            {withoutRules.length === 1 ? "has" : "have"} no active appetite rules. Atlas reports them as
            a data gap on every recommendation rather than considering them.
            {canManage
              ? " Upload and confirm a guideline to bring them into the matrix."
              : " Ask an underwriting manager to add their guideline."}
          </Notice>
        </div>
      )}

      <div className="atlas-toolbar" style={{ marginBottom: "var(--atlas-space-4)" }}>
        <div className="atlas-toolbar__field atlas-toolbar__field--grow">
          <label htmlFor="insurer-search">Search</label>
          <SearchInput
            id="insurer-search"
            label="Search insurers by name or quote channel"
            value={search}
            placeholder="Insurer name or quote channel"
            onChange={setSearch}
          />
        </div>
        <div className="atlas-toolbar__spacer" />
        <p className="atlas-result-count">
          {loading ? "Loading…" : `${pluralise(visible.length, "insurer")} shown`}
        </p>
      </div>

      {loading ? (
        <ul className="atlas-insurer-grid" aria-hidden="true">
          {Array.from({ length: 6 }).map((_, index) => (
            <li key={index}>
              <span className="atlas-skeleton atlas-skeleton--block" style={{ height: 118 }} />
            </li>
          ))}
        </ul>
      ) : visible.length === 0 ? (
        <Card>
          {items.length === 0 ? (
            <EmptyState
              title="No insurers have been added yet"
              body={
                canManage
                  ? "Add an insurer, then upload their underwriting guideline. Atlas reads it and proposes appetite rules for you to confirm."
                  : "Ask an underwriting manager to add insurers and upload their guidelines before running recommendations."
              }
              actions={
                canManage ? (
                  <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
                    Add insurer
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <EmptyState
              title="No insurers match that search"
              body="Nothing on file matches the name or quote channel you searched for."
              actions={<Button onClick={() => setSearch("")}>Clear search</Button>}
            />
          )}
        </Card>
      ) : (
        <ul className="atlas-insurer-grid">
          {visible.map((insurer) => (
            <li key={insurer.id}>
              <button type="button" className="atlas-insurer-card" onClick={() => onOpen(insurer.id)}>
                <span className="atlas-insurer-card__name">{insurer.name}</span>
                <span className="atlas-text-dense atlas-text-muted">
                  {insurer.notes || "No notes recorded."}
                </span>
                <span className="atlas-insurer-card__meta">
                  {insurer.active_appetite_count > 0 ? (
                    <StatusBadge
                      status={{
                        label: pluralise(insurer.active_appetite_count, "active rule"),
                        tone: "success",
                        description: "Atlas scores this insurer against these rules.",
                      }}
                    />
                  ) : (
                    <StatusBadge
                      status={{
                        label: "No active rules",
                        tone: "warning",
                        description: "Atlas cannot recommend this insurer until a rule is confirmed.",
                      }}
                    />
                  )}
                  {insurer.quote_channel && (
                    <span className="atlas-badge atlas-badge--quiet">
                      <span className="atlas-badge__label">{humanise(insurer.quote_channel)}</span>
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <AddInsurerDrawer
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(id) => {
          setAddOpen(false);
          toast.notify("Insurer added. Upload their guideline next.", "success");
          onOpen(id);
        }}
      />
    </div>
  );
}

function AddInsurerDrawer({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [channel, setChannel] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setChannel("");
    setNotes("");
    setError(null);
    setTouched(false);
  }, [open]);

  async function save() {
    setTouched(true);
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const { id } = await createInsurer({
        name: name.trim(),
        quote_channel: channel.trim() || undefined,
        notes: notes.trim() || undefined,
      });
      onCreated(id);
    } catch (cause) {
      setError(
        (cause as Error).message === "manager_only"
          ? "Only an underwriting manager can add insurers."
          : "The insurer could not be created. Check the name is not already in use."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      open={open}
      title="Add insurer"
      description="Atlas can only recommend an insurer once its guideline has been read and its rules confirmed."
      onClose={onClose}
      dirty={Boolean(name || channel || notes) && !saving}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={saving} loadingLabel="Creating…">
            Create insurer
          </Button>
        </>
      }
    >
      <div className="atlas-form">
        {error && <Notice tone="danger">{error}</Notice>}
        <TextField
          label="Insurer name"
          required
          value={name}
          placeholder="CIB, ONE, Alpha, Infiniti…"
          error={touched && !name.trim() ? "The insurer needs a name." : null}
          onChange={(event) => setName(event.target.value)}
        />
        <TextField
          label="Quote channel"
          optional
          value={channel}
          placeholder="cardinal, own_portal, email_submission"
          hint="Recorded for reference only. It does not affect how Atlas scores appetite."
          onChange={(event) => setChannel(event.target.value)}
        />
        <TextAreaField
          label="Notes"
          optional
          rows={4}
          value={notes}
          hint="Anything the team should know when placing with this insurer."
          onChange={(event) => setNotes(event.target.value)}
        />
      </div>
    </Drawer>
  );
}
