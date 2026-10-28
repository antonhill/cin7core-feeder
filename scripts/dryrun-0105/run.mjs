// LOCAL, READ-ONLY-AGAINST-HOSTED dry run of migration 0105 on a representative copy of the hosted POC data shape.
//
//   npm i --no-save @electric-sql/pglite        (WASM Postgres, nothing to install system-wide)
//   node scripts/dryrun-0105/run.mjs
//
// It builds an in-memory Postgres with minimal stand-ins for the foundations the NewQuip migrations rely on (auth, organizations,
// org_members, is_org_member, cin7_instances, quotes), applies the REAL migrations 0101-0104, seeds a fixture that mirrors the hosted
// data (3 ACTIVE projects x 6 stages, 4 APPROVED claims, V001 approved with no schedule, 1 Sale link, the INV-00021 posting with
// AMOUNT_MISMATCH), snapshots every pre-existing row, applies the REAL 0105, and asserts that nothing changed and that the new guards
// work against that data. It never connects to Supabase and uses no credentials. The authoritative clean-bootstrap + RLS run stays in CI.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.REPO_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const mig = (n) => readFileSync(join(ROOT, "supabase/migrations", n), "utf8");
const db = new PGlite();
let passed = 0;
const ok = (cond, label) => { if (!cond) throw new Error(`FAILED: ${label}`); passed++; console.log(`  ok  ${label}`); };
const denied = async (sql, label) => { try { await db.exec(sql); } catch (e) { passed++; console.log(`  ok  denied: ${label}  [${String(e.message).replace(/\s+/g, " ").slice(0, 110)}]`); return; } throw new Error(`EXPECTED DENIAL: ${label}`); };
const noRows = async (sql, label) => { let n = 0; try { n = (await db.query(sql)).affectedRows ?? 0; } catch { passed++; console.log(`  ok  denied: ${label}`); return; } if (n > 0) throw new Error(`EXPECTED NO ROWS CHANGED: ${label} (${n})`); passed++; console.log(`  ok  no rows changed: ${label}`); };
const q = async (sql, params) => (await db.query(sql, params)).rows;

const A = "00000000-0000-0000-0000-00000000a001", B = "00000000-0000-0000-0000-00000000a002", UA = "00000000-0000-0000-0000-00000000b001", UB = "00000000-0000-0000-0000-00000000b002";
const INST = "00000000-0000-0000-0000-00000000c001";

// ── foundations (stand-ins) ─────────────────────────────────────────────────
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth; create table auth.users (id uuid primary key);
  create table organizations (id uuid primary key default gen_random_uuid(), name text, disabled_modules text[] not null default '{}');
  create table org_members (org_id uuid references organizations(id), user_id uuid, role text);
  create table cin7_instances (id uuid primary key default gen_random_uuid(), org_id uuid references organizations(id), name text, account_id text, application_key_encrypted text, active boolean default true);
  create table quotes (id uuid primary key default gen_random_uuid());
  create function is_org_member(p_org uuid) returns boolean language sql stable as $$
    select exists (select 1 from org_members where org_id = p_org and user_id = nullif(current_setting('request.uid', true), '')::uuid) $$;
  grant usage on schema public to authenticated, anon, service_role;
  insert into organizations (id, name) values ('${A}', 'POC Org'), ('${B}', 'Other Org');
  insert into org_members values ('${A}', '${UA}', 'member'), ('${B}', '${UB}', 'member');
  insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted) values ('${INST}', '${A}', 'NewQuip POC', 'acct', 'x');
`);
for (const f of ["0101_newquip_projects.sql", "0102_newquip_quotes_and_variations.sql", "0103_project_opening_commitments.sql", "0104_project_cin7_claim_posting.sql"]) await db.exec(mig(f));
console.log("applied 0101-0104");

// ── fixture mirroring the hosted data shape (seeded with triggers off: these rows represent pre-existing history) ──
const STAGES = [["Deposit", 100000000], ["Manufacturing", 300000000], ["Equipment Ready", 200000000], ["Delivery", 200000000], ["Installation", 150000000], ["Commissioning", 50000000]];
const P = { golden: "00000000-0000-0000-0000-0000000d0001", c1: "00000000-0000-0000-0000-0000000d0002", c2: "00000000-0000-0000-0000-0000000d0003" };
await db.exec(`set session_replication_role = replica;`);
for (const [ref, id] of [["PRJ-NQ-Q-0001", P.golden], ["NQ-POC-MVB55T7T", P.c1], ["NQ-POC-MVQWWSNB", P.c2]]) {
  await db.exec(`insert into projects (id, org_id, project_reference, name, customer_name, original_contract_cents, tax_rate_bps, tax_rule, status) values ('${id}', '${A}', '${ref}', 'n', 'Cust', 1000000000, 1500, 'VAT 15% (NewQuip POC)', 'ACTIVE')`);
  let i = 0;
  for (const [n, v] of STAGES) await db.exec(`insert into project_stages (id, org_id, project_id, sort_order, name, value_cents) values (gen_random_uuid(), '${A}', '${id}', ${++i}, '${n}', ${v})`);
}
// claims (APPROVED), lines, progress events, opening commitments, V001, the Sale link and the INV-00021 posting
const stage = async (proj, name) => (await q(`select id from project_stages where project_id = $1 and name = $2`, [proj, name]))[0].id;
let seq = 0;
for (const [proj, num, sub, tax, line] of [[P.golden, "PRJ-NQ-Q-0001-C01", 95000000, 14250000, "Manufacturing"], [P.c1, "NQ-POC-MVB55T7T-C01", 250000000, 37500000, "Deposit"], [P.c2, "NQ-POC-MVQWWSNB-C02", 95000000, 14250000, "Manufacturing"]]) {
  const id = `00000000-0000-0000-0000-0000000e000${++seq}`;
  await db.exec(`insert into project_claims (id, org_id, project_id, claim_seq, claim_number, claim_date, status, tax_rate_bps, subtotal_cents, tax_cents, total_cents, snapshot_hash, baseline_hash, idempotency_key, author_email, approver_email, approved_at)
    values ('${id}', '${A}', '${proj}', 1, '${num}', current_date, 'APPROVED', 1500, ${sub}, ${tax}, ${sub + tax}, 'h', 'b', 'k${seq}', 'a@x', 'm@x', now())`);
  const sid = await stage(proj, line);
  await db.exec(`insert into project_claim_lines (org_id, project_id, claim_id, stage_id, stage_name, stage_value_cents, approved_bps, earned_to_date_cents, previously_committed_cents, current_claim_cents, tax_cents)
    values ('${A}', '${proj}', '${id}', '${sid}', '${line}', 300000000, 3167, ${sub}, 0, ${sub}, ${tax})`);
  await db.exec(`insert into project_progress_events (org_id, project_id, stage_id, reported_bps, approved_bps, recorded_by_email) values ('${A}', '${proj}', '${sid}', 6500, 6500, 'e@x')`);
}
await db.exec(`
  insert into project_variations (id, org_id, project_id, code, title, amount_cents, status, raised_by_email, decided_by_email, decided_at)
    values ('00000000-0000-0000-0000-0000000f0001', '${A}', '${P.golden}', 'V001', 'Additional Ventilation', 48000000, 'APPROVED', 'e@x', 'm@x', now());
  insert into project_cin7_sale_links (id, org_id, project_id, instance_id, cin7_sale_id, cin7_sale_number, tax_rule, revenue_account, linked_by_email)
    values ('00000000-0000-0000-0000-0000000f0002', '${A}', '${P.c2}', '${INST}', 'SALE-19', 'SO-00019', 'Standard Rate Sales', '200', 'm@x');
  insert into project_claim_cin7_postings (org_id, project_id, claim_id, sale_link_id, idempotency_key, request_fingerprint, memo, posting_state, amount_ex_vat_cents, tax_cents, total_cents, cin7_sale_id, cin7_invoice_number, cin7_task_id, cin7_status, requested_by_email, completed_at, last_error_code, last_error_message)
    values ('${A}', '${P.c2}', '00000000-0000-0000-0000-0000000e0003', '00000000-0000-0000-0000-0000000f0002', 'NEWQUIP:NQ-POC-MVQWWSNB:C02', 'fp', 'NEWQUIP-PROJECTS:NQ-POC-MVQWWSNB:NQ-POC-MVQWWSNB-C02', 'CREATED', 95000000, 14250000, 109250000, 'SALE-19', 'INV-00021', 'task', 'DRAFT', 'm@x', now(), 'AMOUNT_MISMATCH', 'R30 VAT');
`);
await db.exec(`set session_replication_role = origin;`);

// ── snapshot every pre-existing row (as text, per table) ────────────────────
const TABLES = ["projects", "project_stages", "project_progress_events", "project_claims", "project_claim_lines", "project_variations", "project_opening_commitments", "project_cin7_sale_links", "project_claim_cin7_postings"];
const snap = async () => {
  const out = {};
  for (const t of TABLES) {
    const cols = (await q(`select column_name from information_schema.columns where table_name = $1 and table_schema = 'public' order by ordinal_position`, [t])).map((c) => c.column_name);
    out[t] = { cols, rows: await q(`select to_jsonb(x) j from ${t} x order by 1::text`).catch(() => []) };
  }
  return out;
};
const before = {};
for (const t of TABLES) before[t] = (await q(`select to_jsonb(x)::text j from ${t} x order by j`)).map((r) => r.j);
console.log("seeded:", Object.fromEntries(TABLES.map((t) => [t, before[t].length])));

// ── APPLY 0105 ──────────────────────────────────────────────────────────────
await db.exec(mig("0105_project_multi_sale_variation_billing.sql"));
console.log("applied 0105 to existing data without error");

console.log("\nExisting records survive unchanged");
for (const t of TABLES) {
  const after = (await q(`select to_jsonb(x)::text j from ${t} x order by j`)).map((r) => JSON.parse(r.j));
  const was = before[t].map((s) => JSON.parse(s));
  const sorted = (a) => a.map((o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort()))).sort();
  const added = new Set(["billing_scope", "parent_project_id", "variation_id", "sale_role", "physical_lines", "estimated_cost_cents"]);
  const stripped = after.map((o) => Object.fromEntries(Object.entries(o).filter(([k]) => !added.has(k))));
  ok(JSON.stringify(sorted(stripped)) === JSON.stringify(sorted(was)), `${t}: ${was.length} row(s) identical apart from the new columns`);
}
ok((await q(`select count(*)::int n from projects where billing_scope = 'BASE' and parent_project_id is null and variation_id is null`))[0].n === 3, "all 3 existing projects are BASE");
ok((await q(`select sale_role from project_cin7_sale_links`))[0].sale_role === "BASE", "the existing Sale link is BASE");
ok((await q(`select physical_lines from project_claim_cin7_postings`))[0].physical_lines === null, "the INV-00021 posting has no physical lines");
ok((await q(`select estimated_cost_cents from project_variations`))[0].estimated_cost_cents === null, "V001 estimated cost is unknown (null), not 0");
ok((await q(`select count(*)::int n from project_variation_stages`))[0].n === 0, "V001 has NO schedule (so it is not billable)");
ok((await q(`select count(*)::int n from project_variation_schedule_amendments`))[0].n === 0, "no amendments yet");

console.log("\nHistorical guards still hold on existing data");
await denied(`update project_claims set subtotal_cents = 1 where claim_number = 'PRJ-NQ-Q-0001-C01'`, "change an approved historical claim");
await denied(`update project_claim_cin7_postings set memo = 'x'`, "change the INV-00021 posting memo");
await denied(`update project_claim_cin7_postings set cin7_invoice_number = 'INV-9'`, "change the INV-00021 invoice number");
await denied(`delete from project_claim_cin7_postings`, "delete the INV-00021 posting");
await denied(`update project_variations set amount_cents = 1 where code = 'V001'`, "change approved V001");
await denied(`update project_stages set value_cents = 1 where project_id = '${P.golden}'`, "change frozen stages of a project with an approved claim");

console.log("\nV001 (approved, no schedule) is unbillable until a manager assigns an audited schedule");
await denied(`insert into project_variation_stages (org_id, variation_id, sort_order, name, bps) values ('${A}', '00000000-0000-0000-0000-0000000f0001', 1, 'Direct', 10000)`, "insert a schedule directly on an approved variation");
await denied(`select amend_variation_schedule('${A}', '00000000-0000-0000-0000-0000000f0001', '[{"name":"x","bps":9000}]'::jsonb, 'r', 'm@x')`, "amend to 90%");
await denied(`select amend_variation_schedule('${A}', '00000000-0000-0000-0000-0000000f0001', '[{"name":"x","bps":10000}]'::jsonb, '  ', 'm@x')`, "amend without a reason");
await db.exec(`select amend_variation_schedule('${A}', '00000000-0000-0000-0000-0000000f0001', '[{"name":"Order","bps":3000},{"name":"Delivery","bps":7000}]'::jsonb, 'First schedule for V001', 'm@x')`);
ok((await q(`select count(*)::int n from project_variation_stages where variation_id = '00000000-0000-0000-0000-0000000f0001'`))[0].n === 2, "manager-assigned schedule is stored");
const au = (await q(`select before_stages, amended_by_email, reason from project_variation_schedule_amendments`))[0];
ok(au.before_stages.length === 0 && au.amended_by_email === "m@x" && au.reason === "First schedule for V001", "the amendment is audited (empty before-schedule, who, why)");
await denied(`update project_variation_schedule_amendments set reason = 'x'`, "edit the audit");
ok(JSON.stringify(before.project_variations.map((s) => JSON.parse(s).amount_cents)) === "[48000000]", "V001 amount untouched");

console.log("\nNew variation schedules cannot bypass approval, freeze or claim limits");
await db.exec(`insert into project_variations (id, org_id, project_id, code, title, amount_cents, raised_by_email) values ('00000000-0000-0000-0000-0000000f0010', '${A}', '${P.golden}', 'V002', 'New', 1000001, 'e@x')`);
await db.exec(`insert into project_variation_stages (org_id, variation_id, sort_order, name, bps) values ('${A}', '00000000-0000-0000-0000-0000000f0010', 1, 'A', 5000)`);
await denied(`update project_variations set status = 'APPROVED', decided_by_email = 'm', decided_at = now() where code = 'V002'`, "approve a 50% schedule");
await db.exec(`insert into project_variation_stages (org_id, variation_id, sort_order, name, bps) values ('${A}', '00000000-0000-0000-0000-0000000f0010', 2, 'B', 5000)`);
await db.exec(`update project_variations set status = 'APPROVED', decided_by_email = 'm', decided_at = now() where code = 'V002'`);
await denied(`update project_variation_stages set bps = 1 where variation_id = '00000000-0000-0000-0000-0000000f0010'`, "edit a frozen schedule");
await denied(`delete from project_variation_stages where variation_id = '00000000-0000-0000-0000-0000000f0010'`, "delete a frozen schedule");
ok((await q(`select variation_stage_cents(1000001, array[5000,5000]) c`))[0].c.join() === "500001,500000", "deterministic split (remainder to the earliest stage)");
// billing project for V002, then a claim beyond the stage value is refused by the unmodified 0101 guards
const V2 = "00000000-0000-0000-0000-0000000d0010";
await db.exec(`insert into projects (id, org_id, project_reference, name, customer_name, original_contract_cents, tax_rate_bps, tax_rule, billing_scope, parent_project_id, variation_id)
  values ('${V2}', '${A}', 'PRJ-NQ-Q-0001-V002', 'n', 'Cust', 1000001, 1500, 'VAT 15% (NewQuip POC)', 'VARIATION', '${P.golden}', '00000000-0000-0000-0000-0000000f0010')`);
await db.exec(`insert into project_stages (org_id, project_id, sort_order, name, value_cents) values ('${A}', '${V2}', 1, 'A', 500001), ('${A}', '${V2}', 2, 'B', 500000)`);
await db.exec(`update projects set status = 'ACTIVE' where id = '${V2}'`);
ok((await q(`select project_schedule_balanced('${V2}') b`))[0].b === true, "variation billing project balances to the approved amount");
await denied(`insert into projects (org_id, project_reference, name, customer_name, original_contract_cents, tax_rate_bps, billing_scope, parent_project_id, variation_id) values ('${A}', 'dup', 'n', 'Cust', 1000001, 1500, 'VARIATION', '${P.golden}', '00000000-0000-0000-0000-0000000f0010')`, "a second billing project for V002 (no duplicate commitment)");
await denied(`insert into projects (org_id, project_reference, name, customer_name, original_contract_cents, tax_rate_bps, billing_scope, parent_project_id, variation_id) values ('${A}', 'wrong', 'n', 'Cust', 999999, 1500, 'VARIATION', '${P.golden}', '00000000-0000-0000-0000-0000000f0010')`, "a billing project whose contract differs from the approved amount");
const V2C = "00000000-0000-0000-0000-0000000e0099";
await db.exec(`insert into project_claims (id, org_id, project_id, claim_seq, claim_number, claim_date, tax_rate_bps, subtotal_cents, tax_cents, total_cents, snapshot_hash, baseline_hash, idempotency_key, author_email)
  values ('${V2C}', '${A}', '${V2}', 1, 'PRJ-NQ-Q-0001-V002-C01', current_date, 1500, 500001, 75000, 575001, 'h', 'b', 'kv2', 'a@x')`);
const v2s1 = (await q(`select id from project_stages where project_id = $1 and sort_order = 1`, [V2]))[0].id;
await denied(`insert into project_claim_lines (org_id, project_id, claim_id, stage_id, stage_name, stage_value_cents, approved_bps, earned_to_date_cents, previously_committed_cents, current_claim_cents, tax_cents)
  values ('${A}', '${V2}', '${V2C}', '${v2s1}', 'A', 500001, 10000, 500001, 0, 900000, 0)`, "a claim line above the stage's approved value (variation cannot be over-claimed)");
await denied(`insert into project_claim_lines (org_id, project_id, claim_id, stage_id, stage_name, stage_value_cents, approved_bps, earned_to_date_cents, previously_committed_cents, current_claim_cents, tax_cents)
  values ('${A}', '${V2}', '${V2C}', (select id from project_stages where project_id = '${P.golden}' limit 1), 'A', 500001, 10000, 500001, 0, 500001, 0)`, "a variation claim line pointing at a BASE stage (cross-scope)");

console.log("\nOwnership, isolation (RLS) and audit");
await db.exec(`grant select, insert, update, delete on all tables in schema public to authenticated`);
const asUser = async (uid, fn) => { await db.exec(`set role authenticated; select set_config('request.uid', '${uid}', false);`); try { return await fn(); } finally { await db.exec(`reset role;`); } };
ok((await asUser(UA, () => q(`select count(*)::int n from projects`)))[0].n === 4, "member of the owning org sees its projects (3 + billing project)");
ok((await asUser(UB, () => q(`select count(*)::int n from projects`)))[0].n === 0, "another org sees none");
for (const t of ["project_variation_stages", "project_variation_schedule_amendments", "project_cin7_sale_creations"]) ok((await asUser(UB, () => q(`select count(*)::int n from ${t}`)))[0].n === 0, `another org sees no ${t}`);
await asUser(UA, async () => {
  await noRows(`update projects set name = 'hacked'`, "a member writing projects");
  await denied(`insert into project_variation_stages (org_id, variation_id, sort_order, name, bps) values ('${A}', '00000000-0000-0000-0000-0000000f0010', 9, 'x', 1)`, "a member writing schedules");
  await denied(`select amend_variation_schedule('${A}', '00000000-0000-0000-0000-0000000f0001', '[{"name":"x","bps":10000}]'::jsonb, 'r', 'm@x')`, "a member calling the amendment function");
});
await denied(`insert into project_cin7_sale_creations (org_id, project_id, instance_id, sale_role, external_id, request_fingerprint, plan, contract_ex_vat_cents, requested_by_email) values ('${A}', '${P.c2}', '${INST}', 'BASE', 'x', 'f', '{}', 1, 'm')`, "a Sale creation intent for a project that already has a linked Sale");
await denied(`insert into project_cin7_sale_links (org_id, project_id, instance_id, cin7_sale_id, tax_rule, revenue_account, linked_by_email, sale_role) values ('${A}', '${V2}', '${INST}', 'SALE-X', 'r', '200', 'm', 'BASE')`, "a BASE Sale on a variation billing project");
ok((await q(`select count(*)::int n from project_cin7_sale_links`))[0].n === 1, "still exactly one Sale link (INV-00021's)");

console.log("\nMigration 0106 (variation safeguards) on top of the migrated data");
const rowsBefore106 = {};
for (const t of TABLES) rowsBefore106[t] = (await q(`select to_jsonb(x)::text j from ${t} x order by j`)).map((r) => r.j);
await db.exec(mig("0106_project_variation_safeguards.sql"));
for (const t of TABLES) ok(JSON.stringify((await q(`select to_jsonb(x)::text j from ${t} x order by j`)).map((r) => r.j)) === JSON.stringify(rowsBefore106[t]), `0106 left ${t} untouched`);
await denied(`update projects set status = 'CLOSED' where id = '${P.golden}'`, "close the parent while its variation scope is open");
await denied(`update projects set status = 'CLOSED' where id = '${V2}'`, "close the variation scope while it has a DRAFT claim");
const v2stage = (await q(`select id from project_stages where project_id = $1 and sort_order = 1`, [V2]))[0].id;
await denied(`insert into project_opening_commitments (org_id, project_id, stage_id, amount_cents, reason, recorded_by_email) values ('${A}', '${V2}', '${v2stage}', 100, 'x', 'm')`, "an opening commitment on a variation billing project (also frozen by its claim)");
ok((await q(`select project_unresolved_obligations('${V2}') o`))[0].o.join("|") === "claim PRJ-NQ-Q-0001-V002-C01 is DRAFT", "the unresolved-items helper names the blocker");
await db.exec(`update projects set status = 'CLOSED' where id = '${P.c1}'`);
ok(true, "a BASE project with no variation scopes still closes exactly as before");
ok((await q(`select count(*)::int n from project_variations where code = 'V001' and amount_cents = 48000000 and status = 'APPROVED'`))[0].n === 1, "V001 unchanged by 0106");

console.log(`\nALL ${passed} DRY-RUN ASSERTIONS PASSED`);
