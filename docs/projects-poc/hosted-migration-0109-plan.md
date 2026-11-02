# Hosted migration 0109 — execution plan

**Status: NOT APPLIED.** Prepared on branch `feature/newquip-completion` (PR #126, draft). Applying needs the owner's explicit GO sentence (below).
Branch HEAD when written: `28953e0` (re-verify before applying; the migration file's checksum is what counts). `origin/main` = `09e1aba`.

## 1. File identity
| file | sha256 |
|---|---|
| `supabase/migrations/0109_newquip_package_mappings.sql` | `fe7fc02b44757edc23c2e4bfef7ed5c1930df84261f28080f095a28828498dbd` |
| `supabase/tests/0109_newquip_package_mappings.test.sql` (regression test) | `2e3ce451ac179912204eb1122aef4b88a060a5f03134671273c0c98d9d23315c` |

Version/name to use with `apply_migration`: name `newquip_package_mappings` (the platform assigns the version timestamp). Expected ledger afterwards: 122 entries, newest = this migration.

## 2. What it does
Reusable, version-controlled package -> cin7 sku mappings; the database assigns the version and supersedes the previous active one; history immutable.
Additive only. Nothing existing is altered, no data is backfilled, no Cin7 call is made.

## 3. Object inventory
- Tables: `newquip_package_mappings`
- Functions: `newquip_package_mappings_guard()`
- Triggers: newquip_package_mappings_guard_trg (insert/update/delete)
- Indexes (besides primary keys / unique constraints): newquip_package_mappings_one_active_idx (partial unique: one ACTIVE per org+package)

## 4. Dependencies
organizations; is_org_member(). Independent of 0107/0108.

## 5. RLS, grants and isolation
member SELECT via is_org_member(org_id); no write policy; anon holds nothing; authenticated holds SELECT only. All application writes go through the service role in server actions that re-check the NewQuip org and the caller's role. Cross-organisation isolation is enforced by RLS (SELECT) and, for the project tables, by composite foreign keys that stop a row naming another organisation's project.

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
`supabase/tests/0109_newquip_package_mappings.test.sql` runs in the CI job "Clean migration bootstrap + RLS/security test matrix" (`supabase db reset` + every `supabase/tests/*.test.sql`, BEGIN/ROLLBACK). It covers constraints, triggers (including the failure cases), immutability/append-only rules, cross-organisation and cross-project isolation, RLS (member/admin/other-org), least-privilege grants, and cascade. It was also executed on a real PostgreSQL engine (PGlite) with stub parent tables, and a deliberately broken copy of the migration was shown to FAIL the test.

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
> **GO: apply migration 0109 (sha256 fe7fc02b44757edc23c2e4bfef7ed5c1930df84261f28080f095a28828498dbd) to pnzwjqjovxxdikxtfngq.**
