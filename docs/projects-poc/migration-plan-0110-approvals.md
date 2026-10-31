# Migration 0110: NewQuip commercial approvals (APPLIED 2026-10-29)

Additive. Creates `approval_settings`, `approval_requests`, `approval_events`, `approval_notifications` and the functions `approval_submit`,
`approval_decide`, `approval_reassign`, `approval_mark_viewed`, `approval_record_reminder` (+ internal helpers). Modifies no existing table or row.

## Why a migration
Quotes, claims and variations have no return/reject state, no per-revision record of what was submitted, no history and no notifications. The
documents keep their own tables and actions; 0110 holds the canonical approval state and an append-only history, written transactionally.

## Hosted preflight (read-only)
1. `select count(*) from information_schema.tables where table_name like 'approval\_%'` must be 0.
2. Ledger head is 0109 (`list_migrations`).
3. `is_org_member`, `is_org_admin`, `organizations` exist.

## Apply, then verify
- All four tables exist with RLS enabled; `select` granted to `authenticated` only; no INSERT/UPDATE/DELETE grants.
- `has_function_privilege('authenticated','approval_decide(...)','execute')` is false for every approval_* function (revoked from public/anon/authenticated).
- Triggers: `approval_requests_guard_trg`, `approval_events_append_only_trg`, `approval_notifications_guard_trg`.
- Unique partial index `approval_requests_one_pending_idx` present.
- Existing row counts of projects / project_claims / project_variations / newquip_quotes unchanged.

## Rollback
Nothing depends on the tables until used. If needed: `drop table approval_notifications, approval_events, approval_requests, approval_settings cascade;`
then drop the functions. Documents already approved through the framework stay approved (their own tables hold their state).

## Behaviour before it is applied
Every caller checks `approvalsAvailable()`. Until 0110 exists, quotes / claims / variations keep their previous approve buttons and the Approvals page says migration pending.

## Applied record
- Applied to hosted project `pnzwjqjovxxdikxtfngq` on 2026-10-29 as ledger entry `newquip_commercial_approvals` (version 20261029064729), on owner approval. Only 0110 was applied.
- The SQL applied is byte-identical to `supabase/migrations/0110_newquip_commercial_approvals.sql` (sha256 `a75cf3684b42253d944a416ce5c26081f5a14d95dfebd9520d458e11d27cb3a0`, commit 2de1264). The header comment in that file still says "NOT applied"; it was left unedited so the file matches what was applied.
- Preview and Production share this database. Production runs `main`, which has no Phase H code and does not reference the new tables, so nothing was activated there.
- Verified after applying: 4 tables with RLS, 10 functions, 3 guard triggers, 4 SELECT-only policies, the one-pending index; no client role can execute an approval function; client table grants are SELECT only; existing row counts unchanged (projects 12, claims 8, variations 2, quotes 7, organisations 5); 0 approval rows.
- The recovery script was dry-run inside a rolled-back transaction (all objects dropped cleanly, then confirmed still present).
- The full SQL test script was run against the hosted database inside a rolled-back transaction with synthetic organisations: PASS, and afterwards 0 approval rows and no test organisations or users remained.

## Known limitations at release
- Email: no mail provider is configured (no RESEND_* variables). In-app notifications work; emails queue and show as failed until a provider and recipients are approved.
- Due dates count Monday to Friday (SAST); public holidays are not modelled.
- The delivery/reminder cron (`/api/approvals-deliver`) runs only on Production deployments. **Not currently scheduled** (removed from `vercel.json` after the 2026-10-31 review: the notification queue has no environment tag); see docs/security-incident-2026-10-31-portal-env-disclosure.md section 8.
- A manager approving their own submission needs the explicit override with a written reason (Approvals page).
