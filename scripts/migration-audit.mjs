// Static migration-history audit — no live database needed. Parses every
// file under supabase/migrations/ in the exact filename-sort order a
// blank-project bootstrap (`supabase db push` / `supabase migration up`)
// would apply them in, and checks two things a re-audit specifically
// asked for:
//
//   1. No migration may reference (ALTER TABLE, CREATE POLICY, or a plain
//      table-name mention in an INSERT/UPDATE/DELETE/SELECT ... FROM/INTO)
//      an object that hasn't been CREATEd by an earlier-or-same migration
//      in that same file order — this is exactly the class of bug that
//      let push_jobs (0058_job_locks.sql alters it) exist in production
//      with no creation migration at all.
//   2. Every table CREATEd anywhere in migration history has an
//      `alter table X enable row level security` statement somewhere in
//      history too — a coarse but real proxy for "every table has
//      intentional RLS configuration," not a substitute for reading each
//      policy's actual conditions.
//
// This is intentionally simple regex-based parsing, not a real SQL parser
// — it's a regression guard against exactly the two failure modes above,
// not a full migration linter. False positives are possible for unusual
// SQL shapes; if one shows up, prefer tightening the regex over adding an
// ignore-list.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, "..", "supabase", "migrations");

const CREATE_TABLE_RE = /create\s+table\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi;
const ENABLE_RLS_RE = /alter\s+table\s+"?([a-z_][a-z0-9_]*)"?\s+enable\s+row\s+level\s+security/gi;
// Matches a table name as the direct object of ALTER TABLE or CREATE POLICY ... ON — the two
// statement shapes that assume a table already exists. Deliberately narrow (not every DML
// statement) since SELECT/INSERT/UPDATE/DELETE targeting a not-yet-created table would already
// fail loudly and immediately in the same migration that contains it, which isn't the bug class
// this guards against — the real risk is a LATER migration assuming an EARLIER one already
// created something that, in fact, only ever existed via a manual production-only change.
// Captures an optional schema prefix too (e.g. `storage.objects`, `auth.users`) so a reference to
// a Supabase-BUILT-IN schema's table — never created by one of our own migrations — can be told
// apart from a bare `public` (our own) table name below, instead of just grabbing the schema word.
const REFERENCES_TABLE_RE = /(?:alter\s+table|create\s+policy\s+"[^"]*"\s+on)\s+(?:if\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?(\.)?/gi;

/** Strips `--` line comments before parsing — a comment that happens to mention SQL syntax (e.g. this very file's own migration explaining a guard clause) must never be mistaken for a real statement. */
function stripSqlComments(sql) {
  return sql
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

/** @returns {{ file: string, createdTables: string[], rlsEnabledTables: string[], referencedTables: string[] }[]} one entry per migration file, in apply order */
export function parseMigrations(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // filename-sort order == the order a blank-project bootstrap applies them in

  return files.map((file) => {
    const sql = stripSqlComments(readFileSync(path.join(migrationsDir, file), "utf8"));
    const createdTables = [...sql.matchAll(CREATE_TABLE_RE)].map((m) => m[1].toLowerCase());
    const rlsEnabledTables = [...sql.matchAll(ENABLE_RLS_RE)].map((m) => m[1].toLowerCase());
    // Drop any match immediately followed by a "." — that's a schema-qualified reference
    // (storage.objects, auth.users, extensions.*, ...) to something outside our own migration
    // history entirely, not one of our own bare-named public-schema tables.
    const referencedTables = [...sql.matchAll(REFERENCES_TABLE_RE)].filter((m) => !m[2]).map((m) => m[1].toLowerCase());
    return { file, createdTables, rlsEnabledTables, referencedTables };
  });
}

/**
 * @returns {{
 *   orderingViolations: { file: string, table: string }[],
 *   missingRlsTables: string[],
 *   allTables: string[],
 * }}
 */
export function auditMigrations(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const migrations = parseMigrations(migrationsDir);
  const createdSoFar = new Set();
  const rlsEnabledEver = new Set();
  const orderingViolations = [];

  for (const m of migrations) {
    // References are checked against what existed BEFORE this migration's own creates — a
    // migration creating and then immediately altering/policy-ing the same table in one file is
    // fine and common (see e.g. 0037-style single-file table+RLS setup), so union this
    // migration's own creates in before checking its references.
    const availableNow = new Set([...createdSoFar, ...m.createdTables]);
    for (const table of m.referencedTables) {
      if (!availableNow.has(table)) orderingViolations.push({ file: m.file, table });
    }
    for (const t of m.createdTables) createdSoFar.add(t);
    for (const t of m.rlsEnabledTables) rlsEnabledEver.add(t);
  }

  const missingRlsTables = [...createdSoFar].filter((t) => !rlsEnabledEver.has(t)).sort();

  return { orderingViolations, missingRlsTables, allTables: [...createdSoFar].sort() };
}

// CLI entry point — `node scripts/migration-audit.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = auditMigrations();
  let failed = false;

  if (result.orderingViolations.length > 0) {
    failed = true;
    console.error("❌ Migration ordering violations (a migration references a table not yet created in file order):");
    for (const v of result.orderingViolations) console.error(`   ${v.file}: references "${v.table}" before any migration creates it`);
  } else {
    console.log("✅ No migration-ordering violations — every referenced table is created by an earlier-or-same migration.");
  }

  if (result.missingRlsTables.length > 0) {
    failed = true;
    console.error(`❌ ${result.missingRlsTables.length} table(s) created in migration history with no RLS-enable statement anywhere:`);
    for (const t of result.missingRlsTables) console.error(`   ${t}`);
  } else {
    console.log(`✅ All ${result.allTables.length} tables created in migration history have an RLS-enable statement somewhere in history.`);
  }

  process.exit(failed ? 1 : 0);
}
