# Migration batch 0111 + 0112 (project templates; roles, policies and staged approvals)

Status: **APPLIED to hosted Supabase (`pnzwjqjovxxdikxtfngq`) on 2026-10-29 and verified** - see "Applied record" at the end. Order: 0111, then 0112. Both depend on 0110 (applied 2026-10-29, ledger 20261029064729).

## What they add (all additive; no existing row is modified)
**0111_newquip_project_templates.sql** - `newquip_project_templates` (name, description, ACTIVE/RETIRED, at most one default per org), `newquip_project_template_versions` (immutable; version assigned by trigger; stages JSON validated in the database: unique names, positive whole basis points, total exactly 10,000). RLS: members read their own org; no client writes; no deletes.

**0112_newquip_roles_and_staged_approvals.sql** - `org_functional_roles` and `org_functional_role_events` (append-only), `approval_policies` and `approval_policy_events` (append-only), `approval_settings.roles_enforced` (default false), new columns on `approval_requests` (`stage`, `stage_role`, `originator_email`, `return_destination`) and `approval_events` (`stage`, `destination`), and the functions `org_role_assign`, `org_role_remove`, `approval_policy_save`, `approval_submit_staged`, `approval_decide_staged`. The guard `approval_requests_guard` is replaced (it now also freezes stage, stage role and originator). The 0110 functions are left in place.

## Backward compatibility
- New columns default to the existing single-manager behaviour (`stage = 'MANAGER'`).
- The deployed code works BEFORE and AFTER the batch: it detects 0112 (`org_functional_roles` present) and otherwise runs the Phase H paths unchanged. Project templates show "migration pending" and the built-in schedules stay available.
- Preview and Production share one database. Production (`main`) has no Phase G/H code, so the new objects are invisible to it. An older Preview (built before this branch) keeps working because the 0110 functions are untouched.
- Until roles are assigned (or strict roles is switched on) nobody's permissions change: a user with no explicit role keeps the tier behaviour (member = rep + estimator, owner/admin = also manager).

## Evidence (local; nothing was run against hosted)
- `supabase/tests/0111_...test.sql` and `supabase/tests/0112_...test.sql` pass in an in-memory Postgres after applying 0110, 0111, 0112 in order; the existing 0110 test still passes against the replaced guard.
- Mutation checks: removing the 100% total check, the originator separation rule, the return-destination rule, the digest check or the stage-aware idempotency each fails the SQL test.
- The authoritative clean-bootstrap + RLS run remains the CI SQL job on the pushed head.

## Hosted procedure (when approved)
1. Record the ledger and row counts of `approval_requests`, `approval_events`, `approval_notifications` (expected at the time of writing: 1, 2, 4).
2. Apply 0111, verify; apply 0112, verify (same session, by name via the migration tool, never `db push`).
3. Verify: ledger shows both; the new tables exist with RLS enabled; `anon`/`authenticated` hold SELECT only; the six new functions are not executable by `anon`/`authenticated`; the pre-existing approval rows are unchanged and have `stage = 'MANAGER'`; `get_advisors` shows no new security finding.
4. Run the hosted rolled-back SQL tests (begin/rollback) for 0111 and 0112.
5. Smoke on the Preview: `/approvals/roles` loads, `/newquip-grower/project-templates` loads.

## Recovery
Forward-only and additive. To undo before any data is written: drop the new functions, the four 0112 tables, the three 0112 columns on `approval_requests`/`approval_events`/`approval_settings`, then the two 0111 tables. After roles or staged requests exist, do not drop: switch the behaviour off by leaving strict roles off and not assigning roles (the staged flow reverts to Phase H only when the tables are absent, so after use prefer a forward fix).

## Go-live steps after applying (owner decisions)
1. Assign roles on `/approvals/roles` (at least one Manager and one Estimator), optionally name the stage approvers, then switch strict roles ON.
2. Create the project templates on `/newquip-grower/project-templates`; mark one default if wanted.
3. Email still needs `RESEND_API_KEY` and `RESEND_FROM_EMAIL` on the Vercel project (see the Delivery tab on `/approvals`).

## Applied record (2026-10-29)
- **Preflight (read-only, before applying):** ledger tail was `20261029064729 newquip_commercial_approvals`; none of the six new tables or eight new functions existed; `approval_requests`, `approval_events`, `approval_settings` had exactly the 0110 columns; row counts 1 / 2 / 4 (requests / events / notifications) and 0 settings rows. Exact-head CI was green on `4506573` (lint, typecheck, tests, build, clean bootstrap + RLS matrix, secret and dependency scans).
- **Applied by name:** `newquip_project_templates` (ledger `20261029115125`, file sha256 `db908373a049d2c881fba38cc141c1e658195c808209a54dffaa57c7a10cb541`), then `newquip_roles_and_staged_approvals` (ledger `20261029115228`, file sha256 `05a88d99baf101b509b947184af2de8b44dfedb6166424b9b90f35869387a3ad`). The text applied is the file on `4506573` (the header comments still say "NOT applied", deliberately unedited).
- **Verified after each:** RLS enabled on all six new tables; `anon` and `authenticated` hold SELECT only; none of the five new RPC functions or the 0112 guards is executable by `anon` or `authenticated`; the new columns exist (`stage` defaults to `'MANAGER'`); the pre-existing approval rows are unchanged (still 1 / 2 / 4, `stage = MANAGER`, `APPROVED`); all new tables are empty; the 0110 functions are still present; the security advisors report nothing on the new objects (the findings listed are pre-existing).
- **Hosted rolled-back SQL tests:** `0111` and `0112` both returned their OK row inside `begin ... rollback`; afterwards the counts were unchanged and no test organisation or user remained.
- Not done by this step: no role was assigned, strict roles is still off, no template exists, no Cin7 call was made.
