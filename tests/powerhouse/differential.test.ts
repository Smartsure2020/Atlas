/**
 * Old-vs-new differential: the live matcher against the FROZEN production
 * matcher (tests/powerhouse/reference/matcher-v1.reference.ts), over thousands
 * of randomised single- and multi-section fixtures.
 *
 *   Corpus A — rows in canonical order, names aligned with ids. Scoring parity
 *              in isolation: EVERY fixture, single- and multi-section, must be
 *              byte-identical to v1.
 *   Corpus B — the same fixtures with rows shuffled and names unrelated to ids
 *              (what production's unspecified DB order looks like). Every
 *              difference must fall into a named class (order_only, tie_rule);
 *              anything else is UNEXPECTED and fails the run.
 *   Invariance — the live matcher's answer on B equals its answer on the
 *              canonical-ordered rows, for every fixture.
 *
 * The report is printed so a reviewer can see counts by fixture class instead
 * of a bare "zero differences".
 */

import { canonicalAppetiteOrder, matchInsurers, type MatchInputRisk } from "../../worker/src/matcher.js";
import type { AppetiteLevel, AppetiteRow } from "../../worker/src/matcher-types.js";
import { matchInsurers as matchInsurersV1 } from "./reference/matcher-v1.reference.js";
import { classifyParity, type ParityClass } from "./parity.js";
import type { MatchResult } from "../../worker/src/matcher.js";

const FIXTURES = 3000;

let seed = 0x2a17be5;
const next = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
};
const pick = <T,>(values: readonly T[]): T => values[Math.floor(next() * values.length)];
const some = <T,>(values: readonly T[], max: number): T[] => {
  const count = Math.floor(next() * (max + 1));
  const out = new Set<T>();
  for (let i = 0; i < count; i++) out.add(pick(values));
  return [...out];
};
const shuffle = <T,>(values: T[]): T[] => {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const PRODUCTS = ["commercial_motor", "goods_in_transit", "buildings", "cyber", "marine", "public_liability"];
const RISKS = ["transport", "cargo", "property", "technology", "retail"];
const TERMS = ["transport fleet", "high value cargo", "cross border", "hazardous goods", "old roof", "remote", "asbestos", "war", "unlicensed"];
const DOCS = ["Claims history", "Policy schedule", "Risk survey"];
const LEVELS: AppetiteLevel[] = ["preferred", "standard", "standard", "caution", "declined"];

interface Fixture {
  risk: MatchInputRisk;
  sections: number;
  rules: AppetiteRow[];
  /** insurer id -> name, aligned with id order */
  names: Record<string, string>;
}

function makeFixture(index: number): Fixture {
  const insurerCount = 2 + Math.floor(next() * 5);
  const rules: AppetiteRow[] = [];
  const names: Record<string, string> = {};
  for (let i = 0; i < insurerCount; i++) {
    const id = `i-${String(i).padStart(2, "0")}`;
    names[id] = `Insurer ${id}`;
    const productRules = 1 + Math.floor(next() * 4);
    for (let k = 0; k < productRules; k++) {
      rules.push({
        id: `r-${index}-${i}-${k}`, insurer_id: id, insurer_name: names[id],
        product_line: pick(PRODUCTS), risk_type: pick(RISKS), appetite_level: pick(LEVELS),
        preferred_risks: some(TERMS, 2), caution_risks: some(TERMS, 2), declined_risks: next() < 0.3 ? some(TERMS, 1) : [],
        required_documents: some(DOCS, 2), referral_triggers: some(TERMS, 2),
        notes: null, source: "manual", source_document_id: "doc", is_active: next() > 0.05,
      });
    }
    if (next() < 0.5) {
      rules.push({
        id: `r-${index}-${i}-pf`, insurer_id: id, insurer_name: names[id], product_line: "*", risk_type: "*",
        appetite_level: "standard", preferred_risks: [], caution_risks: some(TERMS, 2),
        declined_risks: next() < 0.2 ? some(TERMS, 1) : [], required_documents: some(DOCS, 1),
        referral_triggers: some(TERMS, 1), notes: null, source: "manual", source_document_id: "doc", is_active: true,
      });
    }
  }
  const sectionCount = next() < 0.5 ? 1 : 2 + Math.floor(next() * 2);
  const sectionKeys = shuffle(PRODUCTS).slice(0, sectionCount);
  const text = (key: string) => key.replace(/_/g, " ");
  const risk: MatchInputRisk = {
    product_candidates: [...sectionKeys.map(text), text(pick(PRODUCTS))],
    section_candidates: sectionKeys.map(text),
    risk_candidates: some(RISKS, 2).concat(pick(RISKS)),
    features: [
      ...some(TERMS, 3).map((value) => ({ text: value, source: pick(["endorsements", "exclusions", "business sector"]) })),
      ...(next() < 0.4 ? [{ text: pick(TERMS), source: "red flag", ai_inferred: true }] : []),
    ],
    available_documents: some(DOCS, 3),
    overall_confidence: Math.round(next() * 100) / 100,
    overall_confidence_available: next() > 0.1,
  };
  return { risk, sections: sectionCount, rules, names };
}

type Bucket = Record<ParityClass, number>;
const emptyBucket = (): Bucket => ({ identical: 0, order_only: 0, tie_rule: 0 });
const report = {
  A: { single_section: emptyBucket(), multi_section: emptyBucket() },
  B: { single_section: emptyBucket(), multi_section: emptyBucket() },
};
let unexpected = 0;
let invarianceFailures = 0;
let multiSectionEvaluated = 0;
const failures: string[] = [];

for (let index = 0; index < FIXTURES; index++) {
  const fixture = makeFixture(index);
  const klass = fixture.sections === 1 ? "single_section" : "multi_section";

  // ---- Corpus A: canonical rows, aligned names --------------------------
  const canonical = canonicalAppetiteOrder(fixture.rules);
  try {
    const v1 = matchInsurersV1(clone(fixture.risk), clone(canonical)) as unknown as MatchResult;
    const v2 = matchInsurers(clone(fixture.risk), clone(canonical));
    const result = classifyParity(v1, v2);
    report.A[klass][result.class]++;
    if (v2.insurers.some((insurer) => (insurer.section_evaluations?.length ?? 0) > 0)) multiSectionEvaluated++;
  } catch (error) {
    unexpected++;
    failures.push(`A#${index}: ${(error as Error).message}`);
  }

  // ---- Corpus B: shuffled rows, names unrelated to ids ------------------
  const ids = Object.keys(fixture.names);
  const permuted = shuffle(ids);
  const renamed = new Map(ids.map((id, position) => [id, `Insurer ${permuted[position]}`]));
  const withNames = fixture.rules.map((rule) => ({ ...rule, insurer_name: renamed.get(rule.insurer_id)! }));
  const shuffledRows = shuffle(withNames);
  try {
    const v1 = matchInsurersV1(clone(fixture.risk), clone(shuffledRows)) as unknown as MatchResult;
    const v2 = matchInsurers(clone(fixture.risk), clone(shuffledRows));
    report.B[klass][classifyParity(v1, v2).class]++;
    const reference = matchInsurers(clone(fixture.risk), clone(canonicalAppetiteOrder(withNames)));
    if (JSON.stringify(v2) !== JSON.stringify(reference)) {
      invarianceFailures++;
      failures.push(`B#${index}: live matcher result depends on row order`);
    }
  } catch (error) {
    unexpected++;
    failures.push(`B#${index}: ${(error as Error).message}`);
  }
}

const sum = (b: Bucket) => b.identical + b.order_only + b.tie_rule;
console.log(`Differential vs FROZEN production matcher v1 (${FIXTURES} randomised fixtures per corpus)`);
console.log("  corpus A — canonical rows, aligned names (scoring parity in isolation)");
for (const klass of ["single_section", "multi_section"] as const) {
  const b = report.A[klass];
  console.log(`    ${klass.padEnd(15)} n=${String(sum(b)).padStart(4)}  identical=${b.identical}  order_only=${b.order_only}  tie_rule=${b.tie_rule}`);
}
console.log("  corpus B — shuffled rows, names unrelated to ids (production's unspecified DB order)");
for (const klass of ["single_section", "multi_section"] as const) {
  const b = report.B[klass];
  console.log(`    ${klass.padEnd(15)} n=${String(sum(b)).padStart(4)}  identical=${b.identical}  order_only=${b.order_only}  tie_rule=${b.tie_rule}`);
}
console.log(`  unexpected differences: ${unexpected}`);
console.log(`  live-matcher order-invariance failures: ${invarianceFailures}`);

const problems: string[] = [];
for (const klass of ["single_section", "multi_section"] as const) {
  const a = report.A[klass];
  // Corpus A isolates scoring: every insurer's answer must equal v1. The only permitted variance is the
  // order of equal-score insurers (v1 appended portfolio-only insurers last; v2 uses the defined name/id key).
  if (a.tie_rule !== 0) problems.push(`corpus A ${klass}: a rule tie changed the answer even with canonical rows: ${JSON.stringify(a)}`);
  if (sum(a) === 0) problems.push(`corpus A ${klass}: no fixtures generated`);
}
if (unexpected !== 0) problems.push(`${unexpected} unexpected difference(s): ${failures.slice(0, 5).join(" | ")}`);
if (invarianceFailures !== 0) problems.push(`${invarianceFailures} order-invariance failure(s)`);
if (multiSectionEvaluated === 0) problems.push("no fixture produced section evaluations");
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
} else {
  console.log("ok - differential: zero unexpected differences; every insurer's answer equals v1 in corpus A; every corpus-B difference is a named, intentional class");
}
