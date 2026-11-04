# NewQuip database-level Rep isolation (migration 0122) - design and pre-apply package

Status: IMPLEMENTED IN FILES ONLY. Nothing has been applied to any hosted database. Applying needs separate owner approval.
Branch `feature/newquip-rep-isolation`, base `feature/newquip-completion` (#126). Single migration owner for this stream: this branch.

## 1. Finding (read-only inspection of production catalogue, project `pnzwjqjovxxdikxtfngq`, SELECT on pg_catalog/information_schema only)

* Every NewQuip / approval / Project / claim / functional-role table has RLS on and exactly one SELECT policy `is_org_member(org_id)` (a few: `is_org_admin`; notifications: recipient). So any signed-in member, including a Rep, can read `newquip_quotes.draft` (cost basis, physical costs, overrides), `accepted_baseline` (internal margin sheet), approval digests/reasons, `project_cost_entries` (admin only), roles and policies directly through PostgREST with the anon key and their own JWT. App-layer redaction (`redactInternalFinancials`, `canSeeCosts`) cannot stop that.
* Privileges were wider than the policies: `newquip_quotes`, `projects` and 13 `project_*` tables (e.g. `project_claims`, `project_claim_lines`, `project_stages`) grant anon AND authenticated the Supabase default ALL (SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER). RLS blocks row access for anon (is_org_member is false) and there are no write policies, so this is not exploitable through PostgREST today (PostgREST cannot issue TRUNCATE), but it is one mis-added policy away from exposure and TRUNCATE is outside RLS. `activity_log` grants authenticated ALL as well.
* `activity_log` (shared with Toolbox modules) is member-readable and holds 227 `newquip.*`, 56 `approvals.*`, 98 `projects.*` rows (return reasons, approvals audit, cost entries).
* Out of scope but found (owner decision D6): generic Toolbox tables are member-readable and hold cost/margin columns: `quotes`/`quote_lines` (estimated_cost, margin_pct, overall_margin_pct), `products` (average_cost, supplier_fixed_price), `sale_lines` (average_cost), `assembly_*`/`production_*` costs. They belong to other modules and are NOT touched.

## 2. Current database access model (verified in code)

* `src/supabase/server.ts` `createServiceRoleClient()` is the only data client. All 137 server files that touch data use it. Every NewQuip/approval/Project/claim store (`src/lib/newquip-quotes`, `approvals`, `projects`, `newquip-portal`) takes a `db` handed in from a service-role caller; all writes go through the service role and the SECURITY INVOKER `approval_*`, `org_role_*`, `amend_variation_schedule` functions (executable by service_role only).
* The user-JWT session client (`createSessionClient`, middleware, browser auth client) is used only for `auth.getUser`, `org_members` and `organizations` lookups (`current-org`, `active-org`, `middleware`, `require-privileged`, `require-super-admin`, signup/login). The browser client is auth-only ("never for data queries"). No Supabase Realtime publication exists in the project (`pg_publication_tables` empty).
* The public customer portal (`portal/`) uses `createServiceRoleClient()` plus an emailed token; its tables are already service-role-only in practice.
* Role resolution (`resolveRoles`, `canSeeCosts`, `authoriseActor`) lives in the app. In SQL there is only `is_org_member` / `is_org_admin` and the `org_functional_roles` table; strict-roles-off tier defaults (every member is implicitly REP + ESTIMATOR) are an app setting. A SQL policy cannot reproduce that, and cost secrets are inside jsonb columns, so row policies cannot redact columns anyway.

Consequence: no legitimate path reads these tables with a member JWT, so nothing breaks if client access is removed. This is enforced by a new unit test (`src/supabase/__tests__/rep-isolation-client-boundary.test.ts`).

## 3. Design and why (candidates considered)

| Candidate | Verdict |
|---|---|
| (b) role-aware policies (`has_functional_role(...)`) | Rejected. Needs SQL to mirror the app's role resolution (tier defaults, strict mode); the tier default makes every member an Estimator, so a "role-aware" policy either leaks to Reps or must read the settings; cannot hide jsonb sub-fields; gives Estimators/Managers a second, unaudited read path. |
| (c) column grants / redacted view | Rejected. Needs a view per table (+ jsonb redaction function), new objects and a new maintenance burden, for a path nothing uses. |
| held 0119 (switch + role policies + `newquip_*_scope_ok`) | Superseded for cost isolation. Its policies re-create member read paths gated by an OFF-by-default switch and explicit roles; it protects nothing until enabled and still exposes jsonb to Estimators/Managers/admins. Customer-assignment row scoping stays an app concern (`src/lib/newquip-assignments/access.ts`, service role). |
| **(a) selected**: revoke all client privileges + drop all policies, RLS stays ON, app is service-role-only | Two independent fail-closed layers (privilege layer: SQLSTATE 42501; RLS layer: no policy = no rows), no new objects, zero application change, trivially auditable, trivially reversible. |

Migration `0122_newquip_database_level_rep_isolation.sql` (idempotent; tables not yet present are skipped), for the 40 family tables listed in section 4: `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`; `REVOKE ALL ON TABLE ... FROM PUBLIC, anon, authenticated` (this also removes column-level grants, e.g. 0117's `newquip_response_links` metadata columns); drop every policy on the table. `activity_log` (shared, not revoked): `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER` from PUBLIC/anon/authenticated, `REVOKE ALL FROM anon`, and replace its policy with `is_org_member(org_id) AND action !~ '^(newquip|approvals|projects)\.'`. No table, column, function, trigger, index or row is created/altered/deleted. `service_role` (BYPASSRLS) is untouched.

Estimator and Manager are intentionally NOT given direct database read: their authority is enforced by the app (`authoriseActor`, approval stages), which has the role context, and every UI needs the same redaction/stage logic. The database's job is to make the Rep (and any member, admin, other organisation, anon) unable to bypass the app.

## 4. Affected objects (40 tables + activity_log) and ACCESS MATRIX

Tables: `newquip_quotes, newquip_quote_customers, newquip_quote_documents, newquip_quote_sends, newquip_quote_responses, newquip_response_links, newquip_response_reviews, newquip_response_evidence, newquip_company_profiles, newquip_fx_rates, newquip_package_mappings, newquip_project_templates, newquip_project_template_versions, approval_requests, approval_events, approval_notifications, approval_policies, approval_policy_events, approval_settings, org_functional_roles, org_functional_role_events, projects, project_variations, project_variation_stages, project_variation_schedule_amendments, project_stages, project_stage_allocations, project_progress_events, project_opening_commitments, project_milestone_confirmations, project_deliveries, project_delivery_allocations, project_delivery_events, project_cin7_links, project_cin7_sale_creations, project_cin7_sale_links, project_claims, project_claim_lines, project_claim_cin7_postings, project_cost_entries` (+ `customer_rep_assignments` if/when the held 0118 is applied).

Direct database access (PostgREST/psql with the role's JWT), BEFORE -> AFTER 0122:

| Actor | SELECT (family tables, incl. `draft`, `accepted_baseline`) | INSERT/UPDATE/DELETE | TRUNCATE etc. | activity_log `newquip/approvals/projects.*` rows | activity_log Toolbox rows | activity_log writes |
|---|---|---|---|---|---|---|
| anon | no rows (policy) -> **permission denied** | privilege on 15 tables (blocked by RLS) -> **denied** | privilege on 15 tables -> **denied** | no -> no | no -> no | no -> no |
| Rep (member) | **all org rows** -> **denied** | blocked by RLS -> **denied** | privilege on 15 tables -> **denied** | **visible** -> **hidden** | visible -> visible | privilege (RLS-blocked) -> **denied** |
| Estimator / Manager (member) | all org rows -> **denied (use the app)** | -> denied | -> denied | visible -> hidden | visible -> visible | -> denied |
| Org admin | all rows -> **denied (use the app)** | -> denied | -> denied | visible -> hidden | visible -> visible | -> denied |
| Member of another org | none (policy) -> denied | -> denied | -> denied | none -> none | none -> none | -> denied |
| service_role (application, portal) | all -> all | all -> all | unchanged | all -> all | all -> all | all -> all |

Application-level matrix is unchanged (that is the point): Rep sees redacted quotation data, Estimator costs and mappings, Manager approvals, enforced by `authoriseActor` / `redactInternalFinancials` in the service-role code path.

## 5. Existing-data compatibility

* No row, column, constraint, trigger or function body changes; existing data is read/written exactly as before by the service role. Triggers and SECURITY INVOKER functions run as service_role (BYPASSRLS) or the table owner, so they are unaffected; FK checks run as owner.
* `is_org_member` / `is_org_admin` (SECURITY DEFINER, executable by anon/authenticated) stay; still used by non-family tables.
* No view, materialised view or Realtime publication depends on the family tables (catalogue checked; the only public view is `scorecard_bottleneck_orders_v`, warehouse).
* Storage: NewQuip buckets have no `storage.objects` policy for client roles (0115/0117); unchanged.
* Existing SQL tests 0101-0105, 0107-0113, 0115-0117 asserted the old member-read behaviour; they are updated to assert denial (diff in this PR). Files 0101-0105 re-grant SELECT inside their own transaction to keep exercising the RLS-only layer (default deny).
* Customer portal: service role + token; no client-role dependency.
* Held 0118/0119 (branch `feature/newquip-rep-customer-isolation`, e5cca7f): not in #126 and not applied. 0118 (assignments table) is independent. 0119 would re-create member SELECT policies behind its switch; privileges stay revoked by 0122 so those policies could never grant access, but they become dead code (see decision D2).

## 6. Impact on quotation, approval and claim workflows

Every flow runs server-side on the service role, so none changes: quote create/save/handoff/sign-off/return/accept (`src/lib/newquip-quotes/*`, `src/app/newquip-grower/*`), customer documents/sends/responses/evidence/links (document-store, send-store, response-*, `/api/newquip-*` routes, portal), approvals submit/decide/reassign/notify/reminders (`src/lib/approvals/*`, `src/app/approvals/*`, `/api/approvals-deliver`), roles and policies (`role-store`, `role-actions`), Projects/variations/claims/Cin7 postings/costs/deliveries/templates/FX/package mappings (`src/lib/projects/*`, `src/app/projects/*`). Verified by: (1) static scan - 40 stores/actions use `.from(<family table>)` and none is reachable from a user-JWT client file (new vitest guard); (2) the SQL suite exercising the service role after the migration (0122 test section 4, plus the full existing suite for 0101-0120 which writes through the owner/service paths).
Required application change: **none**. No code in this PR changes behaviour.
Not verified end to end: a live browser run against a database with 0122 applied (it is not applied anywhere); do that on a Supabase preview branch before Production (checklist below).

## 7. Tests (direct database access, real roles and JWT claims)

`supabase/tests/0122_newquip_database_level_rep_isolation.test.sql` (runs in CI job "Clean migration bootstrap + RLS/security test matrix", real Postgres + Supabase Auth): as Rep, Estimator, Manager (real `org_functional_roles` rows), org admin, other-org member and anon it asserts SQLSTATE 42501 for SELECT/DELETE/TRUNCATE on every family table and for the exact secrets (`draft`, `accepted_baseline`, `project_cost_entries.amount_cents`), update/insert on quotes; catalogue guard over ALL tables matching the family name patterns (no client privilege incl. column grants, no PUBLIC, RLS on, no policy, service_role keeps SELECT) so a future migration adding an unprotected family table fails CI; defence in depth (SELECT re-granted -> still 0 rows for Rep, admin, anon); service_role still reads/writes (draft, costs, roles, activity_log); activity_log hides `newquip|approvals|projects` rows, keeps Toolbox rows, no client writes/TRUNCATE, other org sees nothing; unrelated tables (`products, customers, quotes, quote_lines, sale_lines, org_members, organizations`) keep authenticated SELECT.
Local evidence (PGlite, real Postgres engine; 120 migrations replayed, Supabase roles/`auth` schema stubbed): all 45 SQL files run; 4 fail identically on the unmodified base (0052, 0057, 0058, 0059: PGlite json/time quirks, not related). Mutation proofs (test must fail on a broken implementation): without the migration -> 0122, 0116, 0101 fail; migration missing `approval_events` -> 0122 fails ("authenticated holds SELECT on approval_events"); migration that does not drop policies -> 0122 fails ("newquip_quotes must carry no policy"). Vitest `rep-isolation-client-boundary.test.ts` (5 tests) fails if any user-JWT client file references a protected table or imports a store (mutation proven).

## 8. Rollback (tested)

`supabase/rollback/0122_newquip_database_level_rep_isolation_rollback.sql`: re-creates the exact pre-0122 policies and `SELECT` to authenticated (admin-only policies for `approval_settings`, `approval_policy_events`, `project_cost_entries`, `org_functional_role_events`; recipient policy for notifications; column-only grants for `newquip_response_links`, token hash never exposed) and restores the activity_log policy. It deliberately does not restore the accidental TRUNCATE/DML privileges (step C is a commented option). Evidence (PGlite): after 0122 only activity_log is member-readable (1 policy); after rollback all 41 tables member-readable with 41 policies, anon SELECT none, a member reads their quote again, `token_hash` denied, link metadata readable; rollback re-run is idempotent; 0122 re-applied twice -> identical to first apply. No data is touched in either direction; rollback is instant and needs no downtime.

## 9. Numbering and apply order

Hosted has 0001-0117 + 0121 (warehouse). #126 carries 0107-0120 (0120 held/unapplied). Held branch has 0118/0119 (unapplied). **0122** is the next free number across main, #126 and every origin branch (checked). Order: 0120 (if/when #126 ships) -> 0121 (main, independent) -> **0122**; 0118/0119 are optional and independent. 0122 is safe before 0120 (skips absent tables; 0120 only adds a column to `project_claim_lines`, whose revoked grants persist). Supabase will report 0118/0119 as out-of-order if they are ever applied after 0122 (apply with `--include-all` or via the MCP by name; they only add objects/policies and cannot re-grant privileges).

## 10. Pre-apply checklist

1. Owner approves applying 0122 (Production) separately; decide D1-D6 below.
2. **Preview and Production share ONE Supabase database in the current setup** (see `docs/newquip-ux006-hosted-uat-runsheet.md`, rows 7 and 11). Therefore "apply to preview" means applying to the shared production database UNLESS a separate Supabase branch database is used. Procedure: (a) create a Supabase branch database (`create_branch`, which replays all migrations on an isolated copy), (b) apply 0122 only to that branch, (c) point a Vercel Preview deployment at the branch (override `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, anon and service keys for that Preview only; branch must exist before overrides, see the branch-isolation gotchas), (d) run the smoke below, (e) delete the branch. If no branch database is used, do not describe the step as a preview: it is a Production apply and needs the Production approval. On the branch: apply 0122, run `supabase/tests/*.test.sql` (CI does on a clean bootstrap), then smoke the app as Rep, Estimator, Manager, admin: open a quotation, save, hand off, sign off, approve, create a claim, open the portal link. Confirm PostgREST as a Rep JWT returns 401/403/"permission denied" for `/rest/v1/newquip_quotes?select=draft`.
3. Confirm `SUPABASE_SERVICE_ROLE_KEY` is set in every deployment (it already must be).
4. Take a catalogue snapshot (`information_schema.role_table_grants` + `pg_policies`) before applying; keep the rollback file open.
5. After applying: re-run the read-only catalogue query, run the Rep JWT probe, watch Vercel/Supabase logs for `42501` from the app (would indicate an unreviewed user-JWT read).

## 11. Risks

* An unreviewed future code path reading a family table with a user JWT would fail with 42501 (fail closed). Guarded by the vitest boundary test and the CI catalogue guard.
* New Supabase tables get default anon/authenticated grants (`ALTER DEFAULT PRIVILEGES`); the CI guard catches family-named tables, other names are not covered (cross-cutting, see D6).
* Applying while a request is mid-flight: privilege changes are transactional; service-role paths are unaffected.
* `activity_log` hides prefixes by regex on `action`; a new NewQuip action named outside `newquip|approvals|projects` would remain member-visible.
* Rep/Estimator/Manager are enforced by the app only; a service-role key leak bypasses everything (unchanged, unavoidable with this architecture).

## 12. Owner decisions

* D1 Approve 0122 as the isolation mechanism (option a). Estimator/Manager/admin get no direct DB read; they use the app.
* D2 Fate of held 0119: recommend superseding it (do not apply; if the switch/audit table is wanted, re-cut it without the policy section). 0118 can proceed independently.
* D3 `org_functional_roles` is also revoked (nothing reads it with a JWT; it reveals who holds which role). Confirm.
* D4 `activity_log`: hide `newquip.*|approvals.*|projects.*` from client roles and remove client write privileges. Confirm (alternative: leave untouched).
* D5 Rollback restores read access but not the accidental TRUNCATE/DML grants. Confirm.
* D6 (made concrete in section 13, P2-3) Cross-cutting follow-up: Toolbox `quotes`, `quote_lines`, `products`, `sale_lines`, assembly/production tables are member-readable with cost/margin columns. Same pattern applies (all app reads are service role) but touches other modules; separate stream and approval.

## 13. Review findings and owner decisions (independent review of fa08972: no P1; safe to apply to a Supabase BRANCH database after owner approval)

### P2-1 Held migration 0119 CONTRADICTS 0122
Migration 0119 (`feature/newquip-rep-customer-isolation`, e5cca7f, unapplied) conflicts with 0122 if it is ever applied AFTER 0122:
* it re-creates member SELECT policies on the family tables (grants stay revoked, so access stays denied, but its `newquip_*_scope_ok` helpers become dead code);
* it OVERWRITES 0122's narrowed `activity_log` policy (`drop policy ... "org members read activity_log"; create policy ... newquip_quote_scope_ok(...)`), which for a member with isolation switched OFF (default) is effectively `is_org_member(org_id)`: it RE-EXPOSES the `newquip.* / approvals.* / projects.*` audit rows to every member;
* it creates `newquip_access_settings` and `newquip_access_setting_events`, which get the default anon/authenticated ACL (0119 only revokes them explicitly, but any other creation path would not) and are NOT in 0122's family array or covered by the CI name guard (`newquip_` prefix matches the guard, so the CI test would fail on them unless 0119 revokes; it does revoke, so they pass, but they stay outside the migration's own array).
**Recommended resolution: do not apply 0119; supersede it with 0122; 0118 (assignments) is independent and can proceed.**
If the owner prefers to keep 0119, the exact required rebase is: (1) renumber 0122 to run AFTER 0119 (e.g. 0122 stays, 0119 applied first, never after); (2) add `newquip_access_settings` and `newquip_access_setting_events` to the `fam` array in 0122 (revoke + drop policies); (3) in 0122 re-assert the `activity_log` policy after everything else (it already is the last statement) and add a test that the policy qual still contains `newquip|approvals|projects`; (4) remove or neutralise 0119's policy-recreation section so the final policies are none. The 0122 CI guard would catch (2) and (4) as failures.

### P2-2 Future-table protection is name-pattern based; default privileges are not altered
0122 does not change default privileges. The CI guard covers only tables named `newquip_*`, `approval_*`, `project_*`, `projects`, `org_functional_*`, `customer_rep_*`. A new table with another name gets the Supabase default ACL (anon and authenticated: ALL).
Optional hardening, an explicit OWNER DECISION and NOT included: `ALTER DEFAULT PRIVILEGES FOR ROLE postgres, supabase_admin IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;`. Blast radius: it affects EVERY future table in `public` for EVERY module (Toolbox, warehouse, RWTSA, NewQuip): each new table would need an explicit `grant select ... to authenticated` where a client read is genuinely intended; existing tables are unaffected; migrations that rely on defaults (or tests that omit grants, as 0101-0105 re-grant explicitly) could behave differently on a clean bootstrap, so it needs its own stream, a full CI bootstrap run and a rollback (`ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon, authenticated`).

### P2-3 OUT OF SCOPE: cost/margin-bearing Toolbox tables readable by any member (D6, made concrete)
Hosted catalogue check (read-only). `authenticated` has SELECT on all below, and the sensitive columns are:
| Table | Sensitive columns | anon |
|---|---|---|
| `quotes` | estimated_cost, overall_margin_pct, margin_revenue_ex_tax, costed_line_count, excluded_from_margin_count, margin_scope | **ALL incl. TRUNCATE** |
| `quote_lines` | average_cost, estimated_cost, margin_pct, margin_included, unit_price, cost_snapshot_at | **ALL incl. TRUNCATE** |
| `quote_creation_claims` | creation-claim keys/payloads | **ALL incl. TRUNCATE** |
| `products` | average_cost, costing_method, supplier_fixed_price, supplier_product_code/name, drop_ship_supplier | none |
| `sale_lines` | average_cost, price | none |
| `assembly_bom_lines`, `assembly_consumption_lines`, `assembly_builds` | estimated_unit_cost, cost_percentage, unit_cost | none |
| `production_bom_items`, `production_operations`, `production_orders`, `production_bom_operations`, `production_bom_versions` | cost_of_wastage, resource_cost_type, actual_material_cost, actual_resource_cost, wip_actual_cost | none |
| `purchases`, `purchase_order_lines`, `purchase_receipt_lines`, `suppliers` | supplier names, purchase prices/costs | none |
| `po_creation_claims` | claim keys | none |
| `scorecard_actions/definitions/metric_definitions/metric_results/reviews/sections`, `scorecard_bottleneck_orders_v` | warehouse performance data | **ALL incl. TRUNCATE** (view: ALL) |
RLS still blocks anon rows (is_org_member is false), and PostgREST cannot TRUNCATE, so the anon grants are defence-in-depth debt, but any member (including a Rep) can read the cost/margin columns of the Toolbox Quotes module directly. Same pattern applies (revoke client privileges, no policy) provided the other modules also read only via the service role (the session client reads only org_members/organizations, so very likely). It touches other modules, so it needs its own stream, per-module compatibility review and owner approval. Recommended first slice: `quotes`, `quote_lines`, `quote_creation_claims`, `products` (cost columns), then the rest.

### P3 activity_log narrowing is prefix-based
Hidden: `newquip.*`, `approvals.*`, `projects.*`. Still member-readable: `sync.*` (33k rows, sync run summaries), `audit.*` (Data Audit apply actions: `audit.apply_fixes`, `audit.apply_attribute_template`, `audit.apply_supplier_assignment` - product/supplier changes written to Cin7, may name SKUs, supplier assignments), `pricing.*` (`pricing.bulk_update`: price changes, may carry old/new prices), `supplier_planner.*`, `replenish.*`, `instance.*`, `order_fulfillment.*`. These are Toolbox rows, left as before. A NEW NewQuip action written under any other prefix would be member-readable: keep NewQuip audit actions under the three hidden prefixes (add a lint/test), or move the policy to an allow-list of Toolbox prefixes (owner decision).

### P3 Limits of the vitest client-boundary guard
`rep-isolation-client-boundary.test.ts` is a static heuristic. It catches literal `.from("<table>")` with a protected table name in files that use a user-JWT client, new user-JWT client files not on the reviewed list, and user-JWT files importing the stores. It does NOT catch: `.rpc(...)` calls, dynamically built table names, a user-JWT client created in one file and passed to a store in another (the import check only covers files that create the client), a Supabase client created with the anon key directly via `createClient` from `@supabase/supabase-js` (not matched by its client-name regex), or client-side code outside `src/` and `portal/app/`. The authoritative protection is the database (SQLSTATE 42501, plus the CI SQL guard); the unit test is an early-warning aid, not a proof.

### Decision list additions
* D7 (P2-1) Supersede 0119 with 0122 (recommended) or keep 0119 and rebase as specified.
* D8 (P2-2) Whether to alter default privileges for all future tables (not included).
* D9 (P2-3) Open a separate stream for the Toolbox cost/margin tables, starting with `quotes`, `quote_lines`, `quote_creation_claims`, `products`.
* D10 (P3) activity_log: keep the prefix block-list, or switch to an allow-list.
* D11 Preview vs Production: use a Supabase branch database for the smoke test; otherwise treat the apply as Production.
