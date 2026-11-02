# Hosted migration 0107 — execution plan

**Status: NOT APPLIED.** Prepared on branch `feature/newquip-completion` (PR #126, draft). Applying needs the owner's explicit GO sentence (below).
Branch HEAD when written: `28953e0` (re-verify before applying; the migration file's checksum is what counts). `origin/main` = `09e1aba`.

## 1. File identity
| file | sha256 |
|---|---|
| `supabase/migrations/0107_project_delivery_allocation_and_milestones.sql` | `ac72615f95162e621d955f2219d2288032a3002730ede04697303566398177ce` |
| `supabase/tests/0107_project_delivery_allocation_and_milestones.test.sql` (regression test) | `02b142d8332ad2c61cf3301e244f37620859271a5d38b536179ee25baf00145e` |

Version/name to use with `apply_migration`: name `project_delivery_allocation_and_milestones` (the platform assigns the version timestamp). Expected ledger afterwards: 122 entries, newest = this migration.

## 2. What it does
Planned deliveries and sku allocations per billing project (base and each variation independent), append-only allocation audit, informational milestone confirmations.
Additive only. Nothing existing is altered, no data is backfilled, no Cin7 call is made.

## 3. Object inventory
- Tables: `project_milestone_confirmations`, `project_deliveries`, `project_delivery_allocations`, `project_delivery_events`
- Functions: `project_append_only_guard()`, `project_delivery_allocations_guard()`
- Triggers: project_delivery_events_append_only_trg (update/delete); project_milestone_confirmations_append_only_trg (update/delete); project_delivery_allocations_guard_trg (insert/update)
- Indexes (besides primary keys / unique constraints): project_milestone_confirmations_stage_idx; project_delivery_allocations_project_idx; project_delivery_events_project_idx

## 4. Dependencies
projects UNIQUE (id, org_id); project_stages UNIQUE (id, project_id, org_id); organizations; is_org_member(); delivery tables reference each other by composite (delivery_id, project_id, org_id).

## 5. RLS, grants and isolation
member SELECT via is_org_member(org_id) on all four tables; no INSERT/UPDATE/DELETE policy; anon holds nothing; authenticated holds SELECT only. All application writes go through the service role in server actions that re-check the NewQuip org and the caller's role. Cross-organisation isolation is enforced by RLS (SELECT) and, for the project tables, by composite foreign keys that stop a row naming another organisation's project.

## Fresh hosted read-only preflight (project pnzwjqjovxxdikxtfngq, SELECT only)
- Ledger ends at **20261028144224 (0106)**, 121 entries. No migration after 0106 exists.
- **No name collisions**: none of the new tables, functions, indexes or triggers exist (checked by name in pg_class / pg_proc / pg_trigger).
- Foreign-key / helper prerequisites present: `projects UNIQUE (id, org_id)`, `project_stages UNIQUE (id, project_id, org_id)`, `is_org_member()` and `is_org_admin()` (both SECURITY DEFINER).
- In flight: Sale creations PENDING/CREATED/FAILED_UNCERTAIN = **0**; postings PENDING/FAILED_UNCERTAIN = **0**; postings CREATED-but-not-RECONCILED = **1** (an invoice awaiting reconciliation, not a failure; unaffected by this migration).
- Every existing `project_*` table has RLS enabled (0 without). Existing project tables carry Supabase's default broad client grants with RLS as the guard; the new tables are stricter (SELECT only for `authenticated`, nothing for `anon`).
- Baseline row counts / md5 digests (md5 of row text ordered by id), captured 2026-10-28 before any apply:

| table | rows | digest |
|---|---:|---|
| projects | 10 | e41069d9c749bb63ef14d9ca6895f618 |
| project_stages | 46 | b5247e21a4e98af3f2eb91afc693e38a |
| project_claims | 8 | 470ab45a2713ae60c479e632bbd54568 |
| project_claim_cin7_postings | 4 | 9dad7f848ad261ad485a45144d4584ae |
| project_cin7_sale_links | 3 | 798a643c0553d2f2ba71aea62cfc2653 |
| project_cin7_sale_creations | 2 | a05c6a927dac15ba520318188ab37876 |
| project_variations | 2 | 893ff9d684ffea85929ed1c05c4db0f5 |

## 6. Compatibility with existing data
New tables start empty and reference existing rows only through foreign keys they do not modify. No existing constraint, trigger or function is replaced. Historical invoices (INV-00021, 27, 28, 29), SO-00023 and all claims/postings are untouched.

## 7. Tests
`supabase/tests/0107_project_delivery_allocation_and_milestones.test.sql` runs in the CI job "Clean migration bootstrap + RLS/security test matrix" (`supabase db reset` + every `supabase/tests/*.test.sql`, BEGIN/ROLLBACK). It covers constraints, triggers (including the failure cases), immutability/append-only rules, cross-organisation and cross-project isolation, RLS (member/admin/other-org), least-privilege grants, and cascade. It was also executed on a real PostgreSQL engine (PGlite) with stub parent tables, and a deliberately broken copy of the migration was shown to FAIL the test.

## 8. Procedure
1. Re-run the section 5 preflight (all SELECT). **Stop** if the ledger moved past 0106, any new object name now exists, the file checksum differs, any in-flight creation/posting count rose, or any baseline digest changed.
2. Apply the exact file text with `apply_migration`.
3. Verify (all SELECT): ledger newest entry is this migration (122 entries); each table exists with RLS enabled and exactly the policies in section 5; triggers/functions present; `anon` has no privilege and `authenticated` only SELECT; all new tables empty; every baseline digest in section 5 is **identical** (no existing row changed); `get_advisors` (security) shows no new finding for the new objects.
4. Run no Cin7 call, no deploy.

## 9. Stop conditions
Any preflight mismatch (step 1); an apply error (the migration is one transaction: nothing is left half-applied; report and stop); any post-check difference, any changed baseline digest, or any new security advisory. Do not retry blindly.

## 10. Recovery and forward-fix
Before any use, rollback is safe because nothing depends on the new objects: drop the tables then the functions listed above (`drop table ... cascade; drop function ...`), then remove the ledger row only if the platform tooling requires it. After use, do not drop: forward-fix with a new migration instead (the data in these tables is audit/history). The application tolerates the tables being absent (the features report "unavailable"/"unknown", never zero), so a rollback does not break the rest of Toolbox.

## 11. Exact GO instruction
> **GO: apply migration 0107 (sha256 ac72615f95162e621d955f2219d2288032a3002730ede04697303566398177ce) to pnzwjqjovxxdikxtfngq.**
