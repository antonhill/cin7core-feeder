# Migration 0120: partial progress-claim amounts (UAT-013). NOT APPLIED.

Stack: PR-D, stacked on #136 (selective claims), #135 and #126. Owner approval is required before it is applied to hosted Supabase.

## What it changes
- `project_claim_lines.partial boolean not null default false` (additive).
- Replaces the table CHECK `current_claim_cents = earned_to_date_cents - previously_committed_cents` with
  `project_claim_lines_amount_rule`: non-partial lines keep the equality exactly; partial lines need `0 < current < earned - previously committed`.
- Unchanged: `previously_committed + current <= stage_value`, `current > 0`, the lines-frozen-after-draft trigger, the approval-time reservation/staleness comparison,
  RLS, grants, every other table. Existing rows keep `partial = false` and satisfy the first branch.

## Why the rest of the system is safe
- Reservations: the approval trigger compares `previously_committed_cents` to what OTHER reserving claims hold on the stage. That sum uses `current_claim_cents`, so a partial claim
  reserves only its own amount; the remainder stays claimable. Two partials cannot reserve the same room (the second is refused as stale).
- Snapshot hash: unchanged format (`partial` is not hashed), so no existing draft becomes stale.
- Before the migration: the application writes the `partial` column only on a partial line, and reads it with a fallback, so full claims work on a database without 0120.
  A partial claim attempted before 0120 is refused BEFORE any row is written: `createClaimDraft` probes for the `partial` column first, so no empty DRAFT claim is left behind.

## Pre-apply checks (read-only)
1. `select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid='public.project_claim_lines'::regclass and contype='c';` shows exactly ONE check whose definition contains `current_claim_cents = (earned_to_date_cents - previously_committed_cents)` (observed read-only on hosted on 2026-11-01 as `project_claim_lines_check`; re-run this at apply time, and stop if the count is not exactly one). The migration matches by definition, not by name.
2. `select count(*) from project_claim_lines;` and the current claims table state (record the count; nothing is expected to change).

## Apply
Owner-approved `apply_migration` of `0120_project_partial_claim_lines.sql` only. Idempotent: a second run drops and re-adds the same rule.

## Post-apply verification (read-only)
- The new constraint exists, the old one is gone, `partial` exists with default false, row counts unchanged, every existing row `partial = false`.
- `supabase/tests/0120_project_partial_claim_lines.test.sql` passes in CI (clean bootstrap). It is NOT run on hosted.

## Rollback
`alter table project_claim_lines drop constraint project_claim_lines_amount_rule;` then re-add the original equality CHECK; then drop the column. Only safe while no `partial = true` row exists (check first); once partial claims exist, rolling back needs the owner's decision.

## Ordering with other pending migrations
0114, 0118 (#127) and 0119 (#131) are also unapplied. 0120 has no dependency on them and they have none on it. Apply in numeric order if more than one is approved.
