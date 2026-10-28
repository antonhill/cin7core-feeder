# Hosted migration execution plan: 0105 (+ 0106)

Status: **PREPARED, NOT EXECUTED.** Target: Supabase project `pnzwjqjovxxdikxtfngq` ("cin7toolbox", eu-west-1, PG 17.6). Prepared 2026-10-28 from integration head `d919766`+; preflight below was read-only (SELECT). **Execution needs the owner's written GO for each migration.** Never `supabase db push`, never an unrestricted migration run, never `apply_migration` with anything other than the exact file text below.

## 1. What is applied, exactly
| # | File | sha256 | Lines | Tested by |
|---|---|---|---|---|
| 1 | `supabase/migrations/0105_project_multi_sale_variation_billing.sql` | `1c65679ef1f560e2c1cd15928fcff47288021c3179537a8fc5f9af8dfea4c211` | 359 | CI clean-bootstrap + `0105_...test.sql` (pass at `0fab277`, file unchanged since), local dry run (63 assertions) |
| 2 | `supabase/migrations/0106_project_variation_safeguards.sql` | `e59ab2109742641d7280920d780e6f65c3f01c9cd7fc146d1f19f3c3dc67e9db` | 81 | `0106_...test.sql` (CI on the merge commit), dry run |

0106 depends on 0105 (billing_scope, creation table) and is a **separate** step so the owner can approve and verify them one at a time. The Supabase migration version is a generated timestamp; the migration **names** to use are `project_multi_sale_variation_billing` and `project_variation_safeguards`. Before sending, compute `shasum -a 256` of the file and of the exact text passed to the tool; the two must be equal to the value above. The app tolerates both migrations being absent (deploy-order safety), so the schema may be applied before or after the code.

## 2. Preflight (all read-only) and results on 2026-10-28
| Check | Expected | Result |
|---|---|---|
| Applied migrations | `20261016153001 newquip_projects`, `20261027133802 newquip_quotes_and_variations`, `20261027152905 project_opening_commitments`, `20261027163105 project_cin7_claim_posting` and nothing newer | **as expected** |
| No 0105/0106 object exists yet (3 tables, 4 new columns, 13 functions, 10 triggers, 5 constraints, 2 indexes) | none found | **none exist** |
| Prerequisite tables / functions / roles (`projects`, `project_stages`, `project_claims`, `project_progress_events`, `project_variations`, `project_cin7_sale_links`, `project_claim_cin7_postings`, `project_opening_commitments`, `cin7_instances`, `organizations`; `is_org_member`, `project_has_committed_claim`, `project_schedule_balanced`; roles `anon`, `authenticated`, `service_role`) | all present | **all present** |
| Hosted guard functions equal the repo's 0101-0104 (13 functions, md5 of comment-stripped, whitespace-collapsed `pg_get_functiondef`) | identical | **identical** (the hosted copies lack the files' inline comments; logic equal) - `scripts/dryrun-0105/run.mjs` asserts this on every run |
| Existing data | 3 ACTIVE projects, 18 stages, 26 allocations, 14 progress events, 4 APPROVED claims, 8 claim lines, 2 opening commitments, 1 variation (V001 APPROVED R480,000), 1 Sale link (SO-00019), 1 posting (INV-00021 CREATED/AMOUNT_MISMATCH), 1 quote | **recorded** |
| No row can violate a new constraint (new columns are nullable or default to BASE/NULL) | true | **true** (dry run on the hosted-shaped fixture) |
| Pre-migration data digests (md5 of all rows as text, new columns removed from the comparison) | recorded below | **recorded** |

Pre-migration digests (re-run the same query after each migration; they must be identical):
`newquip_quotes 1 246db282…` · `project_cin7_sale_links 1 80178a96…` · `project_claim_cin7_postings 1 4523c870…` · `project_claim_lines 8 89a6a089…` · `project_claims 4 5401e501…` · `project_opening_commitments 2 d2d516f8…` · `project_progress_events 14 1ea06850…` · `project_stage_allocations 26 6c35540d…` · `project_stages 18 5e2df76b…` · `project_variations 1 edd4a471…` · `projects 3 439241a7…`.
(The full 32-character digests are produced by the query in section 5; the prefixes above were recorded in the preparation session.)

**Do not proceed if**: any preflight row differs; a newer hosted migration exists; row counts changed in a way nobody explains; Preview/Production is mid-deploy; a Cin7 posting is `PENDING`; or the owner has not given the GO sentence.

## 3. Expected schema changes
**0105 (additive):** `projects` + `billing_scope` (default `BASE`), `parent_project_id`, `variation_id`, constraints `projects_billing_scope_check`, `projects_scope_shape_check`, FKs `projects_parent_fk`, `projects_variation_fk`, unique index `projects_one_billing_project_per_variation`, index `projects_parent_idx`, trigger `projects_billing_scope_guard_trg`; `project_variations` + `estimated_cost_cents` (nullable, >= 0); new tables `project_variation_stages`, `project_variation_schedule_amendments`, `project_cin7_sale_creations` (RLS on; read policies "org members read ..."; no write policies); functions `variation_stage_cents`, `amend_variation_schedule` (SECURITY DEFINER, execute revoked from public/anon/authenticated, granted to service_role), triggers on the new tables, `project_variations_schedule_guard_trg`; `project_cin7_sale_links` + `sale_role` (default `BASE`) with `project_cin7_sale_links_role_guard_trg` and `project_cin7_sale_links_creation_guard_trg`; `project_claim_cin7_postings` + `physical_lines` (nullable jsonb) with `..._physical_lines_check` and `project_claim_cin7_postings_lines_guard_trg`.
**0106:** function `project_unresolved_obligations`, `projects_closure_guard` + trigger `projects_closure_guard_trg` (before update of status), `project_opening_commitments_scope_guard` + trigger. No table or column changes.
**Not touched:** every existing row, 0101-0104 objects, policies, grants, data. Migration transactions are all-or-nothing.

## 4. Execution procedure (when the owner gives the GO)
1. Owner GO sentence for the step, e.g. `GO: apply migration 0105 (sha256 1c65679e…c211) to pnzwjqjovxxdikxtfngq.`
2. Re-run the section 2 preflight; paste results.
3. Capture the section 5 digest query output ("before").
4. Apply **only** that file by name with the Supabase `apply_migration` tool (single statement batch = one transaction). Do not run anything else in the same call.
5. Run every section 5 verification query; compare to expected. Re-run the digest query: must equal "before".
6. Smoke the app (Preview) read-only: project page loads, Variations tab loads, V001 shows "no schedule yet".
7. Stop. Repeat 1-6 for 0106 only after the owner reviews the 0105 evidence.

## 5. Post-migration verification (SELECT only)
```sql
-- A. objects exist (expected counts in comments)
select count(*) from information_schema.columns where table_schema='public' and ((table_name='projects' and column_name in ('billing_scope','parent_project_id','variation_id')) or (table_name='project_cin7_sale_links' and column_name='sale_role') or (table_name='project_claim_cin7_postings' and column_name='physical_lines') or (table_name='project_variations' and column_name='estimated_cost_cents')); -- 6
select count(*) from information_schema.tables where table_schema='public' and table_name in ('project_variation_stages','project_variation_schedule_amendments','project_cin7_sale_creations'); -- 3
select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('project_variation_stages','project_variation_schedule_amendments','project_cin7_sale_creations') and c.relrowsecurity; -- 3 (RLS enabled)
select tablename, policyname from pg_policies where tablename in ('project_variation_stages','project_variation_schedule_amendments','project_cin7_sale_creations'); -- 3 rows, all "org members read ..." (select only)
-- B. defaults on existing data
select count(*) filter (where billing_scope='BASE' and parent_project_id is null and variation_id is null) b, count(*) t from projects; -- 3, 3
select (select count(*) from project_cin7_sale_links where sale_role='BASE'), (select count(*) from project_claim_cin7_postings where physical_lines is null), (select count(*) from project_variations where estimated_cost_cents is null); -- 1, 1, 1
select (select count(*) from project_variation_stages), (select count(*) from project_variation_schedule_amendments), (select count(*) from project_cin7_sale_creations); -- 0, 0, 0 (V001 has no schedule)
-- C. historical data unchanged: re-run the digest query (section 2 list) and compare
select 'projects', count(*), md5(coalesce(string_agg((to_jsonb(x) - 'billing_scope' - 'parent_project_id' - 'variation_id')::text, '|' order by x.id), '')) from projects x
union all select 'project_stages', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from project_stages x
union all select 'project_stage_allocations', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from project_stage_allocations x
union all select 'project_progress_events', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from project_progress_events x
union all select 'project_claims', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from project_claims x
union all select 'project_claim_lines', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from project_claim_lines x
union all select 'project_variations', count(*), md5(coalesce(string_agg((to_jsonb(x) - 'estimated_cost_cents')::text, '|' order by x.id), '')) from project_variations x
union all select 'project_opening_commitments', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from project_opening_commitments x
union all select 'project_cin7_sale_links', count(*), md5(coalesce(string_agg((to_jsonb(x) - 'sale_role')::text, '|' order by x.id), '')) from project_cin7_sale_links x
union all select 'project_claim_cin7_postings', count(*), md5(coalesce(string_agg((to_jsonb(x) - 'physical_lines')::text, '|' order by x.id), '')) from project_claim_cin7_postings x
union all select 'newquip_quotes', count(*), md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by x.id), '')) from newquip_quotes x order by 1;
-- D. function fingerprints equal the dry-run values (normalised md5)
select p.proname, md5(trim(regexp_replace(regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g'), '\s+', ' ', 'g'))) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('variation_stage_cents','amend_variation_schedule','project_unresolved_obligations','projects_billing_scope_guard','project_variation_stages_guard','project_variation_amendments_append_only','project_variations_schedule_guard','project_cin7_sale_links_role_guard','project_claim_cin7_postings_lines_guard','project_cin7_sale_creations_guard','project_cin7_sale_links_creation_guard','projects_closure_guard','project_opening_commitments_scope_guard') order by 1;
-- E. privileges: the amendment function is NOT executable by anon/authenticated
select has_function_privilege('anon','public.amend_variation_schedule(uuid,uuid,jsonb,text,text)','execute'), has_function_privilege('authenticated','public.amend_variation_schedule(uuid,uuid,jsonb,text,text)','execute'), has_function_privilege('service_role','public.amend_variation_schedule(uuid,uuid,jsonb,text,text)','execute'); -- false, false, true
```
Expected fingerprints (PG-version formatting could differ by a hair: if only fingerprints differ, compare `pg_get_functiondef` text, do not stop on md5 alone): `amend_variation_schedule 9596e892f0fabbab9c32f392fe3af75b`, `project_cin7_sale_creations_guard 39daf1f023385791b642437d78ef71c4`, `project_cin7_sale_links_creation_guard 39dcf526e63184cd6d7fed677b88a818`, `project_cin7_sale_links_role_guard bce5a7c36e17a7441d760c7a51153e9c`, `project_claim_cin7_postings_lines_guard cfd5de709a2cc87d14de93616fa65ba1`, `project_opening_commitments_scope_guard 3b69ce49c89937751866c8fb680e7e46`, `project_unresolved_obligations 1278043bc9fb448361a822dd85dda6dd`, `project_variation_amendments_append_only 54d241923c70a10e5318b30b504367d6`, `project_variation_stages_guard cf87b0fe49f352e2b27b402e8fb2285a`, `project_variations_schedule_guard 839a744f2e9a1d4a00d67771c2477942`, `projects_billing_scope_guard 8e5b2f41e53cbe09e27a667ab184c0b8`, `projects_closure_guard 52133664345e67091228b51339ccb6a4`, `variation_stage_cents 886b4ff37431ef02dbe20a97e2fc65ec` (the last two applied only after 0106 for `project_unresolved_obligations`, `projects_closure_guard`, `project_opening_commitments_scope_guard`).
**No hosted writes are used to verify** (no test rows, no calls to the amendment function). Behavioural proof is the CI/dry-run evidence; hosted verification is structural.

## 6. Stop conditions
Any preflight mismatch; checksum mismatch; the apply call returns an error (nothing is half-applied: single transaction; do not retry blindly, read the error); any post-check differs (especially a digest of historical data, V001, or the INV-00021 posting); an app smoke error; unexpected `ERROR` in Supabase logs for the project. On stop: change nothing further and report.

## 7. Forward recovery (no destructive down-migration)
- Both migrations are additive: if the app must not use them, simply do not call the new actions; columns default to BASE and are inert.
- A faulty trigger/function is fixed with a new migration (0107+) that `create or replace`s only that function, reviewed like this one. A trigger that must be disabled urgently: `alter table <t> disable trigger <name>` is a manual owner action with an incident note, then fix forward.
- A wrongly created billing project with no claims or progress can be set CANCELLED; claims and audit rows are never deleted. Never drop columns/tables holding data without a separate approved plan.
- Point-in-time recovery of the Supabase project exists as the last resort and needs the owner.
- The code is deploy-order tolerant, so rolling the Vercel deployment back does not require touching the schema.

## 8. Owner approvals this plan needs
(1) GO for 0105, (2) review of 0105 evidence, (3) GO for 0106. Neither is requested by this document.
