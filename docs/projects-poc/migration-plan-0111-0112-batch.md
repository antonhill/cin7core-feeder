# Migration batch 0111 + 0112 (project templates; roles, policies and staged approvals)

Status: **written and tested, NOT applied to hosted Supabase.** Apply only as one controlled batch after separate owner approval, in this order: 0111, then 0112. Both depend on 0110 (applied 2026-10-29, ledger 20261029064729).

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
