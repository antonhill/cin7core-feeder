# Migration 0110: NewQuip commercial approvals (NOT applied)

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
