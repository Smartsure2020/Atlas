/**
 * Atlas — add an appetite rule by hand
 * ----------------------------------------------------------------------------
 * For appetite an underwriter knows but no guideline states, or where the
 * document was unreadable.
 *
 * Two shapes of rule, chosen explicitly rather than by typing "*" into two
 * fields and hoping:
 *   - a product rule, matching one product line and risk type;
 *   - a portfolio rule, applying across everything unless a product rule
 *     matches first.
 *
 * A manually added rule goes straight into the active matrix, so the form is
 * clear that it takes effect on the next recommendation.
 */

import { useState } from "react";
import { addAppetiteRule } from "../lib/insurers";
import { Button, Card, Notice, SelectField, TextAreaField, TextField } from "../components/ui";
import { APPETITE_LEVEL_OPTIONS } from "../lib/status";

type Level = "preferred" | "standard" | "caution" | "declined";

const SCOPE_OPTIONS = [
  { value: "product", label: "One product line and risk type" },
  { value: "portfolio", label: "The whole portfolio" },
];

const LIST_FIELDS: {
  key: "preferred_risks" | "caution_risks" | "declined_risks" | "referral_triggers" | "required_documents";
  label: string;
  hint: string;
}[] = [
  {
    key: "preferred_risks",
    label: "Preferred risks",
    hint: "Risks this insurer actively wants. A match raises the ranking.",
  },
  {
    key: "caution_risks",
    label: "Caution risks",
    hint: "Written with care. A match lowers the ranking but does not rule the insurer out.",
  },
  {
    key: "declined_risks",
    label: "Declined risks",
    hint: "A match rules this insurer out entirely for that risk.",
  },
  {
    key: "referral_triggers",
    label: "Referral triggers",
    hint: "A match requires insurer or senior approval before you can proceed.",
  },
  {
    key: "required_documents",
    label: "Required documents",
    hint: "Documents this insurer needs before it will consider the risk.",
  },
];

export function AddRuleForm({
  insurerId,
  onAdded,
  onCancel,
}: {
  insurerId: string;
  onAdded: () => void;
  onCancel: () => void;
}) {
  const [scope, setScope] = useState<"product" | "portfolio">("product");
  const [draft, setDraft] = useState({
    product_line: "",
    risk_type: "",
    appetite_level: "standard" as Level,
    preferred_risks: "",
    caution_risks: "",
    declined_risks: "",
    referral_triggers: "",
    required_documents: "",
    notes: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const isPortfolio = scope === "portfolio";
  const productMissing = touched && !isPortfolio && !draft.product_line.trim();
  const riskMissing = touched && !isPortfolio && !draft.risk_type.trim();
  const canSave = isPortfolio || Boolean(draft.product_line.trim() && draft.risk_type.trim());

  const csv = (value: string) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

  async function save() {
    setTouched(true);
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await addAppetiteRule(insurerId, {
        product_line: isPortfolio ? "*" : draft.product_line.trim(),
        risk_type: isPortfolio ? "*" : draft.risk_type.trim(),
        appetite_level: draft.appetite_level,
        preferred_risks: csv(draft.preferred_risks),
        caution_risks: csv(draft.caution_risks),
        declined_risks: csv(draft.declined_risks),
        required_documents: csv(draft.required_documents),
        referral_triggers: csv(draft.referral_triggers),
        notes: draft.notes || undefined,
      });
      onAdded();
    } catch (cause) {
      setError(
        (cause as Error).message === "manager_only"
          ? "Only an underwriting manager can add appetite rules."
          : "The rule could not be saved. Check the values and try again."
      );
      setSaving(false);
    }
  }

  return (
    <Card
      title="Add an appetite rule"
      description="Manually added rules go straight into the active matrix and apply from the next recommendation."
      footer={
        <>
          <Button onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={saving} loadingLabel="Saving…">
            Add rule to matrix
          </Button>
        </>
      }
    >
      <div className="atlas-form">
        {error && <Notice tone="danger">{error}</Notice>}

        <SelectField
          label="What does this rule cover?"
          required
          value={scope}
          options={SCOPE_OPTIONS}
          hint={
            isPortfolio
              ? "A portfolio rule applies to every risk for this insurer, unless a more specific product rule matches first."
              : "A product rule applies only where both the product line and risk type match."
          }
          onChange={(event) => setScope(event.target.value as "product" | "portfolio")}
        />

        {!isPortfolio && (
          <div className="atlas-form__grid">
            <TextField
              label="Product line"
              required
              value={draft.product_line}
              placeholder="Commercial property"
              error={productMissing ? "Name the product line this rule applies to." : null}
              onChange={(event) => setDraft({ ...draft, product_line: event.target.value })}
            />
            <TextField
              label="Risk type"
              required
              value={draft.risk_type}
              placeholder="Sectional title"
              error={riskMissing ? "Name the risk type this rule applies to." : null}
              onChange={(event) => setDraft({ ...draft, risk_type: event.target.value })}
            />
          </div>
        )}

        <SelectField
          label="Appetite level"
          required
          value={draft.appetite_level}
          options={APPETITE_LEVEL_OPTIONS}
          hint={
            draft.appetite_level === "declined"
              ? "Atlas will rule this insurer out for any matching risk."
              : draft.appetite_level === "caution"
              ? "Atlas will rank the insurer lower and flag the concern."
              : "Atlas will treat matching risks as within normal appetite."
          }
          onChange={(event) => setDraft({ ...draft, appetite_level: event.target.value as Level })}
        />

        <div className="atlas-form__section">
          <p className="atlas-block__title" style={{ marginBottom: 12 }}>
            Risk lists
          </p>
          <div className="atlas-form">
            {LIST_FIELDS.map((field) => (
              <TextField
                key={field.key}
                label={field.label}
                optional
                value={draft[field.key]}
                placeholder="Comma-separated list"
                hint={field.hint}
                onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
              />
            ))}
          </div>
        </div>

        <TextAreaField
          label="Notes"
          optional
          rows={3}
          value={draft.notes}
          hint="Why this rule exists. Underwriters see it alongside the recommendation."
          onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
        />
      </div>
    </Card>
  );
}
