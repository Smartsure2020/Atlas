/**
 * Old-vs-new differential: the live matcher against the FROZEN production
 * matcher (tests/powerhouse/reference/matcher-v1.reference.ts), over thousands
 * of randomised single- and multi-section fixtures, now including insurers with
 * SEVERAL portfolio rules.
 *
 *   Corpus A — rows in canonical order, names aligned with ids. Scoring parity
 *              in isolation: EVERY insurer in EVERY fixture must equal v1
 *              exactly. Only the order of equal-score insurers may differ, and
 *              the ranking shape (ruled_out, score) must be identical.
 *   Corpus B — the same fixtures with rows shuffled and names unrelated to ids
 *              (what production's unspecified DB order looks like). Every
 *              difference must fall into a named class; anything else is
 *              UNEXPECTED and fails the run.
 *   Invariance — the live matcher's answer on B equals its answer on the
 *              canonical-ordered rows, for every fixture.
 *
 * Each fixture is filed under exactly one CATEGORY (precedence tied_rule >
 * multi_portfolio > ordinary) so the report separates:
 *   1. ordinary, non-tied cases           2. tied-rule cases
 *   3. multi-portfolio cases              4. shuffled vs canonical input
 * and, inside every category, single- vs multi-section.
 *
 * Allowed difference classes (see parity.ts): order_only, tie_rule,
 * portfolio_order. Categories constrain which classes may appear: an ordinary
 * fixture can only be identical/order_only; a multi-portfolio fixture (no tie)
 * only identical/order_only/portfolio_order.
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
  /** Active portfolio rules per insurer id. */
  portfolioRuleCounts: Map<string, number>;
}

function makeFixture(index: number): Fixture {
  const insurerCount = 2 + Math.floor(next() * 5);
  const rules: AppetiteRow[] = [];
  const names: Record<string, string> = {};
  const portfolioRuleCounts = new Map<string, number>();
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
    // 0–3 portfolio rules per insurer, so rule-order effects across several of them are exercised.
    const portfolioRules = Math.floor(next() * 4);
    for (let j = 0; j < portfolioRules; j++) {
      rules.push({
        id: `r-${index}-${i}-pf${j}`, insurer_id: id, insurer_name: names[id], product_line: "*", risk_type: "*",
        appetite_level: "standard", preferred_risks: [], caution_risks: some(TERMS, 2),
        declined_risks: next() < 0.25 ? some(TERMS, 1) : [], required_documents: some(DOCS, 1),
        referral_triggers: some(TERMS, 1), notes: null, source: "manual", source_document_id: "doc", is_active: true,
      });
    }
    portfolioRuleCounts.set(id, portfolioRules);
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
  return { risk, sections: sectionCount, rules, names, portfolioRuleCounts };
}

type Category = "ordinary" | "tied_rule" | "multi_portfolio";
const CATEGORIES: Category[] = ["ordinary", "tied_rule", "multi_portfolio"];
const CLASSES: ParityClass[] = ["identical", "order_only", "tie_rule", "portfolio_order"];
const KLASSES = ["single_section", "multi_section"] as const;
type Klass = (typeof KLASSES)[number];

type Bucket = Record<ParityClass, number>;
const emptyBucket = (): Bucket => ({ identical: 0, order_only: 0, tie_rule: 0, portfolio_order: 0 });
const table = (): Record<Category, Record<Klass, Bucket>> =>
  Object.fromEntries(CATEGORIES.map((c) => [c, { single_section: emptyBucket(), multi_section: emptyBucket() }])) as Record<Category, Record<Klass, Bucket>>;
const report = { A: table(), B: table() };

let unexpected = 0;
let invarianceFailures = 0;
let multiSectionEvaluated = 0;
let categoryViolations = 0;
const failures: string[] = [];

function categoryOf(fixture: Fixture, v2: MatchResult): Category {
  if (v2.insurers.some((insurer) => insurer.selection?.basis === "tie_broken_by_canonical_order")) return "tied_rule";
  if ([...fixture.portfolioRuleCounts.values()].some((count) => count >= 2)) return "multi_portfolio";
  return "ordinary";
}

const ALLOWED: Record<Category, ParityClass[]> = {
  ordinary: ["identical", "order_only"],
  tied_rule: ["identical", "order_only", "tie_rule", "portfolio_order"],
  multi_portfolio: ["identical", "order_only", "portfolio_order"],
};

for (let index = 0; index < FIXTURES; index++) {
  const fixture = makeFixture(index);
  const klass: Klass = fixture.sections === 1 ? "single_section" : "multi_section";

  // ---- Corpus A: canonical rows, aligned names --------------------------
  const canonical = canonicalAppetiteOrder(fixture.rules);
  try {
    const v1 = matchInsurersV1(clone(fixture.risk), clone(canonical)) as unknown as MatchResult;
    const v2 = matchInsurers(clone(fixture.risk), clone(canonical));
    const result = classifyParity(v1, v2, { portfolioRuleCounts: fixture.portfolioRuleCounts });
    const category = categoryOf(fixture, v2);
    report.A[category][klass][result.class]++;
    if (!ALLOWED[category].includes(result.class)) {
      categoryViolations++;
      failures.push(`A#${index}: class ${result.class} is not allowed for category ${category}`);
    }
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
    const result = classifyParity(v1, v2, { portfolioRuleCounts: fixture.portfolioRuleCounts });
    const category = categoryOf(fixture, v2);
    report.B[category][klass][result.class]++;
    if (!ALLOWED[category].includes(result.class)) {
      categoryViolations++;
      failures.push(`B#${index}: class ${result.class} is not allowed for category ${category}`);
    }
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

const sum = (b: Bucket) => CLASSES.reduce((total, c) => total + b[c], 0);
const line = (label: string, b: Bucket) =>
  `      ${label.padEnd(15)} n=${String(sum(b)).padStart(4)}  ` + CLASSES.map((c) => `${c}=${b[c]}`).join("  ");
const CATEGORY_LABEL: Record<Category, string> = {
  ordinary: "1. ordinary (non-tied, <2 portfolio rules)",
  tied_rule: "2. tied-rule cases",
  multi_portfolio: "3. multi-portfolio cases (no tie)",
};

console.log(`Differential vs FROZEN production matcher v1 (${FIXTURES} randomised fixtures per corpus; up to 3 portfolio rules per insurer)`);
for (const [corpus, title] of [
  ["A", "corpus A — canonical rows, aligned names (scoring parity in isolation)"],
  ["B", "corpus B — shuffled rows, names unrelated to ids (4. shuffled vs canonical candidate input)"],
] as const) {
  console.log(`  ${title}`);
  for (const category of CATEGORIES) {
    console.log(`    ${CATEGORY_LABEL[category]}`);
    for (const klass of KLASSES) console.log(line(klass, report[corpus][category][klass]));
  }
}
console.log(`  unexpected authoritative differences: ${unexpected}`);
console.log(`  category/class violations: ${categoryViolations}`);
console.log(`  live-matcher order-invariance failures: ${invarianceFailures}`);

const problems: string[] = [];
for (const category of CATEGORIES) {
  for (const klass of KLASSES) {
    const a = report.A[category][klass];
    // Corpus A isolates scoring: canonical rows mean v1 and v2 process rules in the same order, so NO
    // tie_rule or portfolio_order difference may appear; only equal-score insurer order may differ.
    if (a.tie_rule !== 0 || a.portfolio_order !== 0) problems.push(`corpus A ${category}/${klass}: rule-order effect with canonical rows: ${JSON.stringify(a)}`);
  }
}
for (const category of CATEGORIES) {
  const total = KLASSES.reduce((n, k) => n + sum(report.A[category][k]), 0);
  if (total === 0) problems.push(`corpus A: no fixtures in category ${category}`);
}
if (unexpected !== 0) problems.push(`${unexpected} unexpected difference(s): ${failures.slice(0, 5).join(" | ")}`);
if (categoryViolations !== 0) problems.push(`${categoryViolations} category violation(s): ${failures.slice(0, 5).join(" | ")}`);
if (invarianceFailures !== 0) problems.push(`${invarianceFailures} order-invariance failure(s)`);
if (multiSectionEvaluated === 0) problems.push("no fixture produced section evaluations");
if (CATEGORIES.some((c) => KLASSES.every((k) => report.B[c][k].portfolio_order + report.B[c][k].tie_rule + report.B[c][k].order_only === 0) && c !== "ordinary")) {
  problems.push("corpus B never exercised the intended difference classes");
}
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
} else {
  console.log("ok - differential: zero unexpected differences; every insurer's answer equals v1 in corpus A; every corpus-B difference is a named, intentional class within its category");
}
