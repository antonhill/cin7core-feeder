# Hosted migration 0107 — readiness, preflight and verification plan

**Status: NOT APPLIED.** Applying needs the owner's explicit "GO: apply migration 0107 (sha256 7fb864c7e268f122a67292cd51db856ff69c4b700b8f63c7583131fd4478adae) to pnzwjqjovxxdikxtfngq".
File: `supabase/migrations/0107_project_delivery_allocation_and_milestones.sql`. Additive only: 4 new tables, 2 trigger functions, 2 append-only triggers,
1 allocation guard trigger, RLS (member SELECT only). No existing table, column, row or function is altered. No Cin7 call.

## Evidence so far
- **Real PostgreSQL execution:** the migration and `supabase/tests/0107_*.test.sql` were run on PostgreSQL (PGlite) against stub parent tables
  (organizations, org_members, projects, project_stages, is_org_member, auth.uid): **ALL 0107 ... TESTS PASSED**. This proves syntax, constraints, composite-FK
  isolation, the cancelled-delivery guard, append-only audit, RLS (member read / cross-org denial / no member writes) and cascade. It does NOT exercise the
  real earlier migrations; the repo CI job (`supabase db reset` + every `supabase/tests/*.test.sql`) is the full proof and runs on the PR.
- **Read-only hosted preflight (pnzwjqjovxxdikxtfngq):** ledger ends at 20261028144224 (0106), 121 entries; none of the 4 tables or 2 functions exist;
  `projects UNIQUE (id, org_id)` and `project_stages UNIQUE (id, project_id, org_id)` exist (the FK targets); `is_org_member` exists.
  Baseline counts: projects 10, project_stages 46, project_claims 8, project_claim_cin7_postings 4.
  Baseline digests (md5 of row text ordered by id): projects `e41069d9c749bb63ef14d9ca6895f618`, postings `9dad7f848ad261ad485a45144d4584ae`.

## Preflight to re-run immediately before applying (all SELECT)
1. Ledger still ends at 20261028144224; no 0107 entry.
2. The 4 tables and 2 functions are still absent; the FK targets and `is_org_member` still exist.
3. Re-take the counts and digests above (any change means another stream wrote; investigate before applying).
4. File sha256 equals the approved value.

## Apply
`apply_migration` with the exact file text, name `project_delivery_allocation_and_milestones`. One transaction; no data backfill.

## Verification after applying (all SELECT)
1. Ledger has the new version as the newest entry.
2. 4 tables exist with RLS enabled (`relrowsecurity`), and exactly one SELECT policy each, no INSERT/UPDATE/DELETE policy.
3. Triggers present: 2 append-only, 1 allocation guard. Functions have no PUBLIC/anon EXECUTE.
4. All 4 tables are empty. projects / project_stages / project_claims / postings counts and digests are UNCHANGED from the baseline (no historical data touched).
5. `get_advisors` (security) shows no new finding for these tables.
6. Rollback (only if needed, before any use): drop the 4 tables then the 3 functions — no other object depends on them.

## Risks
- Low. New tables only; the one behavioural coupling is application code reading them, which is already deployed-safe because it only runs on the NewQuip-only Products & Fulfilment tab.
- Until applied, the Delivery allocation panel will show an error on load (tables absent). That is expected and is why the Preview must not be demoed before applying.
