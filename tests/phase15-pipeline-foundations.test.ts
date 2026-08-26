/**
 * Phase 15 (Quote Pipeline foundation) — migration structural tests
 * ---------------------------------------------------------------------------
 * Atlas's phase test harness runs in-process without a database. The honest
 * assertions available at this layer are structural: we read migration 0023
 * from disk and verify it commits to the Phase 1 contract — the enum has the
 * approved values, the five new atlas_submissions columns are added NULLABLE
 * with no ADD-time DEFAULT (so historical rows remain NULL by Postgres
 * semantics), defaults are installed by a SEPARATE later ALTER COLUMN block
 * (so they apply to future inserts only), CHECK constraints exist, the three
 * approved indexes exist, atlas_underwriter_profiles is created with the
 * expected shape, and no existing enum, column, or table is altered.
 *
 * The one-controlled backfill lives in Phase 6. This test enforces that no
 * backfill or synthetic history slipped into Phase 1.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  QUOTE_PIPELINE_STAGES,
  QUOTE_PIPELINE_TERMINAL_STAGES,
  QUOTE_SOURCE_TYPES,
  QUOTE_COMPLEXITIES,
  isOpenPipelineStage,
} from "../worker/src/quote-pipeline-types.js";

const tests: { name: string; fn: () => void | Promise<void> }[] = [];

function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Load the migration once. Atlas's test harness always runs from the repo
// root via npm scripts (see package.json's test:phaseN entries), so
// process.cwd() reliably points at the repo root. Compiled tests live under
// .test-dist/, so a file-URL-relative resolution would need "../..".
// ---------------------------------------------------------------------------

const MIGRATION_PATH = resolve(
  process.cwd(),
  "supabase",
  "migrations",
  "0023_pipeline_stage_and_underwriter_profiles.sql"
);
const MIGRATION_SQL_RAW = readFileSync(MIGRATION_PATH, "utf8");
const MIGRATION_SQL = MIGRATION_SQL_RAW.toLowerCase();

// Strip SQL line comments and slash-star block comments so token-presence
// guards only inspect executable DDL and not descriptive prose.
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "");
}

const MIGRATION_SQL_CODE = stripSqlComments(MIGRATION_SQL);

// ---------------------------------------------------------------------------
// Enum
// ---------------------------------------------------------------------------

test("migration 0023 exists and is non-empty", () => {
  assert(MIGRATION_SQL_RAW.length > 0, "migration file must not be empty");
});

test("atlas_pipeline_stage enum declares exactly the eight approved values", () => {
  const match = MIGRATION_SQL.match(
    /create type atlas_pipeline_stage as enum\s*\(([^)]+)\)/s
  );
  assert(match, "enum CREATE TYPE clause must be present");
  const values = match![1]
    .split(",")
    .map((v) => v.trim().replace(/^'/, "").replace(/'$/, ""))
    .filter(Boolean);
  const expected = [
    "new",
    "triaged",
    "assigned",
    "in_progress",
    "quoted",
    "bound",
    "declined",
    "lost",
  ];
  assertEqual(values.length, expected.length, "enum value count");
  for (const v of expected) {
    assert(values.includes(v), `enum missing value: ${v}`);
  }
});

test("TypeScript pipeline-stage vocabulary matches the SQL enum", () => {
  assertEqual(
    QUOTE_PIPELINE_STAGES.length,
    8,
    "QUOTE_PIPELINE_STAGES value count"
  );
  for (const v of QUOTE_PIPELINE_STAGES) {
    assert(
      MIGRATION_SQL.includes(`'${v}'`),
      `SQL enum missing TS-declared stage: ${v}`
    );
  }
});

test("TypeScript terminal stages match Atlas's terminal set", () => {
  assertEqual(QUOTE_PIPELINE_TERMINAL_STAGES.length, 3, "terminal count");
  for (const v of ["bound", "declined", "lost"]) {
    assert(
      (QUOTE_PIPELINE_TERMINAL_STAGES as readonly string[]).includes(v),
      `TS terminal set missing ${v}`
    );
  }
});

test("isOpenPipelineStage rejects null/terminal, accepts non-terminal", () => {
  assertEqual(isOpenPipelineStage(null), false, "null is not open");
  assertEqual(isOpenPipelineStage(undefined), false, "undefined is not open");
  assertEqual(isOpenPipelineStage("bound"), false, "bound is terminal");
  assertEqual(isOpenPipelineStage("declined"), false, "declined is terminal");
  assertEqual(isOpenPipelineStage("lost"), false, "lost is terminal");
  assertEqual(isOpenPipelineStage("new"), true, "new is open");
  assertEqual(isOpenPipelineStage("in_progress"), true, "in_progress is open");
  assertEqual(isOpenPipelineStage("quoted"), true, "quoted is open");
});

// ---------------------------------------------------------------------------
// atlas_submissions additive columns
// ---------------------------------------------------------------------------

const REQUIRED_SUBMISSION_COLUMNS = [
  { name: "pipeline_stage", sqlType: "atlas_pipeline_stage" },
  { name: "received_at", sqlType: "timestamptz" },
  { name: "source_type", sqlType: "text" },
  { name: "complexity", sqlType: "text" },
  { name: "last_pipeline_stage_changed_at", sqlType: "timestamptz" },
] as const;

test("all five new columns are added on atlas_submissions", () => {
  for (const col of REQUIRED_SUBMISSION_COLUMNS) {
    // The migration uses "add column if not exists <name> <type>" — assert
    // the pair is present. Sqltype is asserted loosely to allow either the
    // primitive form or the enum reference in-place.
    const re = new RegExp(
      `add column if not exists\\s+${col.name}\\s+${col.sqlType}`,
      "i"
    );
    assert(
      re.test(MIGRATION_SQL_RAW),
      `atlas_submissions column missing: ${col.name} ${col.sqlType}`
    );
  }
});

test("no new column is NOT NULL or defaulted at ADD-COLUMN time", () => {
  // Slice out the atlas_submissions ADD COLUMN block(s) and inspect them
  // rather than scanning the whole file (defaults are legitimately set
  // afterwards for atlas_underwriter_profiles).
  const addBlockRe =
    /alter table atlas_submissions\s+add column if not exists[\s\S]*?;/gi;
  const blocks = [...MIGRATION_SQL_RAW.matchAll(addBlockRe)];
  assert(blocks.length > 0, "expected at least one ADD COLUMN block on atlas_submissions");

  for (const block of blocks) {
    const text = block[0].toLowerCase();
    for (const col of REQUIRED_SUBMISSION_COLUMNS) {
      if (!text.includes(col.name)) continue;
      const colFragmentRe = new RegExp(
        `add column if not exists\\s+${col.name}\\s+[^,;]*`,
        "i"
      );
      const fragment = text.match(colFragmentRe)?.[0] ?? "";
      assert(
        !/\bnot\s+null\b/.test(fragment),
        `column ${col.name} must not be NOT NULL at ADD time`
      );
      assert(
        !/\bdefault\b/.test(fragment),
        `column ${col.name} must not carry a DEFAULT at ADD time`
      );
    }
  }
});

test("defaults are installed in a SET DEFAULT block AFTER the ADD COLUMN block", () => {
  const firstAdd = MIGRATION_SQL.indexOf("add column if not exists pipeline_stage");
  const firstSetDefault = MIGRATION_SQL.indexOf(
    "alter column pipeline_stage                 set default 'new'"
  );
  assert(firstAdd >= 0, "ADD COLUMN pipeline_stage line must be present");
  assert(firstSetDefault >= 0, "SET DEFAULT 'new' for pipeline_stage must be present");
  assert(
    firstSetDefault > firstAdd,
    "SET DEFAULT must appear AFTER ADD COLUMN so historical rows keep NULL"
  );
});

test("defaults installed for pipeline_stage, source_type, complexity, last_pipeline_stage_changed_at only", () => {
  assert(
    /alter column pipeline_stage\s+set default 'new'/i.test(MIGRATION_SQL_RAW),
    "pipeline_stage default must be 'new'"
  );
  assert(
    /alter column source_type\s+set default 'manual'/i.test(MIGRATION_SQL_RAW),
    "source_type default must be 'manual'"
  );
  assert(
    /alter column complexity\s+set default 'standard'/i.test(MIGRATION_SQL_RAW),
    "complexity default must be 'standard'"
  );
  assert(
    /alter column last_pipeline_stage_changed_at\s+set default now\(\)/i.test(
      MIGRATION_SQL_RAW
    ),
    "last_pipeline_stage_changed_at default must be now()"
  );
});

test("received_at has NO default in Phase 1", () => {
  assert(
    !/alter column received_at\s+set default/i.test(MIGRATION_SQL_RAW),
    "received_at must NOT be given a default in Phase 1"
  );
});

test("check constraints installed for source_type and complexity", () => {
  assert(
    MIGRATION_SQL.includes("atlas_submissions_source_type_check"),
    "source_type check constraint missing"
  );
  assert(
    /check\s*\(\s*source_type is null or source_type in\s*\(\s*'manual'\s*,\s*'email'\s*,\s*'api'\s*\)\s*\)/i.test(
      MIGRATION_SQL_RAW
    ),
    "source_type check predicate must allow NULL and the three approved values only"
  );

  assert(
    MIGRATION_SQL.includes("atlas_submissions_complexity_check"),
    "complexity check constraint missing"
  );
  assert(
    /check\s*\(\s*complexity is null or complexity in\s*\(\s*'standard'\s*,\s*'complex'\s*\)\s*\)/i.test(
      MIGRATION_SQL_RAW
    ),
    "complexity check predicate must allow NULL and the two approved values only"
  );
});

test("TypeScript source_type and complexity vocabularies mirror the SQL CHECKs", () => {
  for (const v of QUOTE_SOURCE_TYPES) {
    assert(MIGRATION_SQL.includes(`'${v}'`), `SQL missing source_type value: ${v}`);
  }
  for (const v of QUOTE_COMPLEXITIES) {
    assert(MIGRATION_SQL.includes(`'${v}'`), `SQL missing complexity value: ${v}`);
  }
});

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

test("pipeline_stage dwell-time index exists with the correct predicate", () => {
  const idxRe =
    /create index if not exists atlas_submissions_pipeline_stage_idx\s+on atlas_submissions\s*\(\s*pipeline_stage\s*,\s*last_pipeline_stage_changed_at desc\s*\)\s+where pipeline_stage is not null/i;
  assert(idxRe.test(MIGRATION_SQL_RAW), "pipeline_stage index missing or wrong shape");
});

test("owner + open pipeline_stage index exists with the correct partial predicate", () => {
  const idxRe =
    /create index if not exists atlas_submissions_owner_open_pipeline_idx\s+on atlas_submissions\s*\(\s*assigned_to\s*,\s*pipeline_stage\s*\)\s+where pipeline_stage is not null\s+and pipeline_stage not in\s*\(\s*'bound'\s*,\s*'declined'\s*,\s*'lost'\s*\)/i;
  assert(
    idxRe.test(MIGRATION_SQL_RAW),
    "owner+open pipeline_stage index missing or wrong shape"
  );
});

test("received_at reverse-chronological index exists with the correct predicate", () => {
  const idxRe =
    /create index if not exists atlas_submissions_received_at_idx\s+on atlas_submissions\s*\(\s*received_at desc\s*\)\s+where received_at is not null/i;
  assert(idxRe.test(MIGRATION_SQL_RAW), "received_at index missing or wrong shape");
});

// ---------------------------------------------------------------------------
// atlas_underwriter_profiles
// ---------------------------------------------------------------------------

test("atlas_underwriter_profiles is created with expected columns and defaults", () => {
  const createRe = /create table if not exists atlas_underwriter_profiles\s*\(([\s\S]*?)\)\s*;/i;
  const match = MIGRATION_SQL_RAW.match(createRe);
  assert(match, "CREATE TABLE atlas_underwriter_profiles missing");
  const body = match![1].toLowerCase();

  const required: { column: string; expect: RegExp; description: string }[] = [
    {
      column: "user_id",
      expect: /user_id\s+uuid\s+primary key references auth\.users\(id\) on delete cascade/,
      description: "user_id uuid PK FK to auth.users(id) ON DELETE CASCADE",
    },
    {
      column: "active_for_assignment",
      expect: /active_for_assignment\s+boolean\s+not null\s+default true/,
      description: "active_for_assignment boolean NOT NULL default true",
    },
    {
      column: "can_take_personal",
      expect: /can_take_personal\s+boolean\s+not null\s+default true/,
      description: "can_take_personal boolean NOT NULL default true",
    },
    {
      column: "can_take_commercial",
      expect: /can_take_commercial\s+boolean\s+not null\s+default false/,
      description: "can_take_commercial boolean NOT NULL default false",
    },
    {
      column: "can_take_complex_commercial",
      expect: /can_take_complex_commercial\s+boolean\s+not null\s+default false/,
      description: "can_take_complex_commercial boolean NOT NULL default false",
    },
    {
      column: "weight",
      expect: /weight\s+numeric\(4,2\)\s+not null\s+default 1\.0/,
      description: "weight numeric(4,2) NOT NULL default 1.0",
    },
    {
      column: "last_assigned_at",
      expect: /last_assigned_at\s+timestamptz\s*,/,
      description: "last_assigned_at timestamptz (nullable)",
    },
    {
      column: "created_at",
      expect: /created_at\s+timestamptz\s+not null\s+default now\(\)/,
      description: "created_at timestamptz NOT NULL default now()",
    },
    {
      column: "updated_at",
      expect: /updated_at\s+timestamptz\s+not null\s+default now\(\)/,
      description: "updated_at timestamptz NOT NULL default now()",
    },
  ];
  for (const req of required) {
    assert(req.expect.test(body), `atlas_underwriter_profiles missing: ${req.description}`);
  }
});

test("atlas_underwriter_profiles has the updated_at maintenance trigger", () => {
  assert(
    /create trigger atlas_underwriter_profiles_touch[\s\S]*?atlas_touch_updated_at/i.test(
      MIGRATION_SQL_RAW
    ),
    "atlas_underwriter_profiles_touch trigger missing"
  );
});

// ---------------------------------------------------------------------------
// Existing schema guarantees — nothing existing is altered or removed
// ---------------------------------------------------------------------------

test("no existing enum type is altered", () => {
  assert(!/alter type\b/i.test(MIGRATION_SQL_RAW), "ALTER TYPE must not appear in Phase 1");
});

test("no column, table, index, constraint, policy, or type is dropped", () => {
  const forbidden = [
    /drop\s+table\b/i,
    /drop\s+column\b/i,
    /drop\s+index\b/i,
    /drop\s+constraint\b/i,
    /drop\s+policy\b/i,
    /drop\s+type\b/i,
  ];
  for (const pat of forbidden) {
    assert(!pat.test(MIGRATION_SQL_RAW), `forbidden clause matched: ${pat.source}`);
  }
});

test("no backfill or historical fabrication in Phase 1", () => {
  // Backfill smells: any INSERT/UPDATE on atlas_submissions, any UPDATE that
  // sets pipeline_stage, and any DELETE anywhere.
  assert(
    !/update\s+atlas_submissions\b/i.test(MIGRATION_SQL_RAW),
    "UPDATE on atlas_submissions is forbidden in Phase 1"
  );
  assert(
    !/insert\s+into\s+atlas_submissions\b/i.test(MIGRATION_SQL_RAW),
    "INSERT INTO atlas_submissions is forbidden in Phase 1"
  );
  assert(
    !/set\s+pipeline_stage\s*=/i.test(MIGRATION_SQL_RAW),
    "explicit assignment of pipeline_stage on existing rows is forbidden"
  );
  assert(!/delete\s+from\b/i.test(MIGRATION_SQL_RAW), "DELETE FROM must not appear");
});

test("no auto-population of atlas_underwriter_profiles", () => {
  assert(
    !/insert\s+into\s+atlas_underwriter_profiles\b/i.test(MIGRATION_SQL_RAW),
    "atlas_underwriter_profiles must not be seeded automatically"
  );
});

test("no existing role helper is redefined", () => {
  const forbidden = [
    /create or replace function atlas_role\b/i,
    /create or replace function atlas_is_staff\b/i,
    /create or replace function atlas_can_manage\b/i,
    /create or replace function atlas_can_write\b/i,
    /create or replace function atlas_is_admin\b/i,
    /create or replace function atlas_can_access_submission\b/i,
    /create or replace function atlas_touch_updated_at\b/i,
  ];
  for (const pat of forbidden) {
    assert(
      !pat.test(MIGRATION_SQL_RAW),
      `must not redefine existing helper: ${pat.source}`
    );
  }
});

test("Phase 1 is silent on all deferred concepts in executable DDL (broker, intake, assignment)", () => {
  // Scan executable DDL only — descriptive comments naming what Phase 1
  // deliberately does NOT do are fine.
  const forbiddenTokens = [
    "broker",
    "graph",
    "conversation_id",
    "delta_link",
    "requested_insurer",
    "targeted_insurer",
    "atlas_assign_submission",
    "assignment_events",
    "pipeline_events",
    "holidays",
    "team_id",
    // Table names for the deferred intake pipeline.
    "atlas_submission_intake",
    "atlas_intake_graph_state",
  ];
  for (const token of forbiddenTokens) {
    assert(
      !MIGRATION_SQL_CODE.includes(token),
      `Phase 1 executable DDL must not mention: ${token}`
    );
  }
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ ${t.name}: ${(e as Error).message}`);
      failed++;
    }
  }
  console.log(`\nPhase 15 foundations: ${passed} passed, ${failed} failed out of ${tests.length}`);
  if (failed > 0 && typeof process !== "undefined") process.exitCode = 1;
})();
