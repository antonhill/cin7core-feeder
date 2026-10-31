# Migration 0117 — customer response portal (NOT applied; owner approval required)

File: `supabase/migrations/0117_newquip_customer_response_portal.sql` — SHA-256 `f466c1836baeeb8caf9e8089b9ddabd3d9c225f2e1a9300475ae984caff516e4` (re-check with `shasum -a 256` before applying; the commit SHA is in the review report).
Test: `supabase/tests/0117_newquip_customer_response_portal.test.sql` (transactional, leaves no rows). CI runs it after a clean `supabase db reset`.

## Ledger refresh (read-only, re-taken 2026-10-30 during the final review)
Hosted ledger tail: `20261029204304 newquip_delivery_privilege_hardening` (= repo 0116, **applied**), then `20261029201206 newquip_customer_quotation_delivery` (0115), `20261029143222 newquip_fx_rates` (0113). So 0116 is applied and registered and the next number is **0117**. Migration **0114** (`SUPPRESSED` notification status) is a separate, still-outstanding item and is **not** a prerequisite of 0117.

## What it does (additive only)
- `newquip_quote_responses`: adds `origin` (default `STAFF`), `contact_email`, `contact_source`, `contact_company`, `exception_reason`, `authority_confirmed`, `document_hash`, `link_id`, `origin_hint`, plus CHECKs, a unique index on `link_id` (one response per link) and `unique (id, org_id)`. Existing rows become `origin = 'STAFF'` and are otherwise untouched.
- New tables `newquip_response_links`, `newquip_response_reviews`, `newquip_response_evidence` with RLS (SELECT for organisation members), guard triggers (append-only reviews / evidence; links change only by one-way revocation and the attempt counter), no client writes, no anon/PUBLIC privileges, **no TRUNCATE**, the token hash column unreadable by `authenticated`, and EXECUTE revoked on the four guard functions (including the replaced `newquip_quote_responses_guard`).
- `approval_notifications` (0110 outbox): `request_id` becomes **nullable** and a nullable `quote_id` (FK `(quote_id, org_id)` to `newquip_quotes`, `on delete cascade`) is added, with `check (request_id is not null or quote_id is not null)`. Existing rows keep their `request_id`; a customer-response notification on a quotation with no approval request (grandfathered) is anchored on the quotation, so the Rep is still notified. No approval request is invented.
- Least privilege (stricter than 0116): the three new tables are reset for `service_role` too (Supabase default privileges would give it TRUNCATE/REFERENCES/TRIGGER). `service_role` gets SELECT/INSERT/UPDATE on links (revocation + attempt counter) and SELECT/INSERT only on the append-only reviews and evidence.
- No storage change: evidence uses the existing private bucket `newquip-quote-documents` (service-role only; no storage policy) under `<org>/evidence/...`.

## Dormant until applied
Without 0117 the code fails closed: emails carry no response links; Stage 5 records responses exactly as before (name only, no files); the public `/quote-response` page answers "online responses are not available"; no verification state exists. Nothing in 0117 affects grandfathered quotations (their gate is unchanged).

## Preflight (read-only, run first)
```sql
select version, name from supabase_migrations.schema_migrations order by version desc limit 3;            -- expect 20261029204304 newquip_delivery_privilege_hardening on top
select count(*) from supabase_migrations.schema_migrations;                                                 -- expect 130 before, 131 after
select to_regclass('public.newquip_response_links') is null as links_absent, (select count(*) from information_schema.columns where table_name='newquip_quote_responses' and column_name='origin') = 0 as origin_absent;
select count(*) total, count(*) filter (where request_id is null) null_request from approval_notifications;  -- expect null_request = 0
select count(*) responses_before from newquip_quote_responses;
```

## Transaction handling
The SQL Editor runs the pasted script as one request; to be certain it is all-or-nothing, wrap it: `begin;` + the file + `commit;`. Every statement is DDL on new objects or additive, nothing needs `concurrently`, and a failure part-way (tested by forcing an error at the end inside a transaction) leaves no table, column or constraint behind. If it was run without `begin/commit` and failed part-way, simply re-run the whole file: it is repeat-safe (tested by applying it twice).

## Apply (SQL Editor, one run) and register
1. Paste the whole file and run it once. It is repeat-safe (`if not exists`, guarded `do` blocks, `drop trigger if exists`).
2. Register it in the ledger exactly as for 0115/0116 (a guarded insert, version = a UTC timestamp later than 20261029204304):
```sql
insert into supabase_migrations.schema_migrations (version, name)
select to_char(now() at time zone 'utc', 'YYYYMMDDHH24MISS'), 'newquip_customer_response_portal'
where not exists (select 1 from supabase_migrations.schema_migrations where name = 'newquip_customer_response_portal');
```

## Verify (read-only)
```sql
-- 1 ledger
select version, name from supabase_migrations.schema_migrations order by version desc limit 3;
-- 2 objects and the new response columns
select table_name from information_schema.tables where table_schema='public' and table_name in ('newquip_response_links','newquip_response_reviews','newquip_response_evidence');
select column_name from information_schema.columns where table_name='newquip_quote_responses' and column_name in ('origin','contact_email','contact_source','contact_company','exception_reason','authority_confirmed','document_hash','link_id','origin_hint');
-- 3 existing responses untouched (all STAFF)
select origin, count(*) from newquip_quote_responses group by 1;
-- 4 privileges: all four rows must be false; token_hash false
select has_table_privilege('anon','public.newquip_response_links','SELECT') anon_select, has_table_privilege('authenticated','public.newquip_response_links','TRUNCATE') auth_truncate,
       has_table_privilege('authenticated','public.newquip_response_evidence','INSERT') auth_insert, has_column_privilege('authenticated','public.newquip_response_links','token_hash','SELECT') token_hash_readable;
-- 5 RLS on and triggers present
select relname, relrowsecurity from pg_class where relname in ('newquip_response_links','newquip_response_reviews','newquip_response_evidence');
select tgname from pg_trigger where tgname in ('newquip_response_links_guard_trg','newquip_response_reviews_guard_trg','newquip_response_evidence_guard_trg','newquip_quote_responses_guard_trg') and not tgisinternal;
-- 6 guard functions not executable by clients (expect no rows)
select proname from pg_proc where proname in ('newquip_response_links_guard','newquip_response_reviews_guard','newquip_response_evidence_guard','newquip_quote_responses_guard')
  and (has_function_privilege('anon', oid, 'EXECUTE') or has_function_privilege('authenticated', oid, 'EXECUTE'));
-- 6b service role: no TRUNCATE / DELETE on the new tables, no UPDATE on reviews / evidence (all false)
select has_table_privilege('service_role','public.newquip_response_links','TRUNCATE') a, has_table_privilege('service_role','public.newquip_response_reviews','DELETE') b,
       has_table_privilege('service_role','public.newquip_response_evidence','UPDATE') c;
-- 6c notifications: the anchor column and constraint exist; request_id nullable; no existing row changed (null_request still 0)
select is_nullable from information_schema.columns where table_name='approval_notifications' and column_name='request_id';   -- YES
select conname from pg_constraint where conname in ('approval_notifications_quote_fk','approval_notifications_anchor_chk');   -- 2 rows
select count(*) filter (where request_id is null) null_request from approval_notifications;                                   -- 0
-- 6d data integrity: legacy responses all STAFF with unchanged counts; no orphan links / reviews / evidence
select count(*) = (select count(*) from newquip_quote_responses where origin='STAFF') all_staff from newquip_quote_responses;
select (select count(*) from newquip_response_links) links, (select count(*) from newquip_response_reviews) reviews, (select count(*) from newquip_response_evidence) evidence;   -- 0,0,0
-- 7 bucket still private
select id, public from storage.buckets where id = 'newquip-quote-documents';
```

## Rollback
(first `alter table approval_notifications drop constraint approval_notifications_anchor_chk, drop constraint approval_notifications_quote_fk, drop column quote_id;` and, only if no row has a null request_id, `alter column request_id set not null`), then `drop table newquip_response_evidence, newquip_response_reviews, newquip_response_links cascade;` then drop the added `newquip_quote_responses` columns/constraints (`alter table newquip_quote_responses drop constraint newquip_quote_responses_link_fk, ...`). Remove any evidence objects under `<org>/evidence/` in the bucket. The application keeps working without the tables (it detects their absence).

## Owner-controlled settings (not changed by this work)
`NEXT_PUBLIC_SITE_URL` must be an `https://` address for the emailed links to be generated; `NEWQUIP_RESPONSE_LINK_DAYS` (optional, 1–30, default 14) sets the link lifetime. The Preview recipient allowlist, `[PREVIEW]` marking and Resend configuration are untouched. Per-IP rate limiting in the application is best-effort and per instance; a platform firewall rule on `/quote-response` and `/api/quote-response` is the owner's decision.

## Compatibility with Production code
Production (main) ignores every added column and table. One shared-database caveat: once Preview creates a quotation-anchored notification (`request_id` null) a user who opens the Production approvals page would see that row's link as `/approvals/null` until this branch ships; the row is only ever created by this branch's code and only for the five allowlisted Preview recipients.

## Public endpoint protection (recommendation, nothing enabled)
Hosted state checked read-only: the project has **no custom Vercel firewall configuration** (config lookup returns not-found). Layers today: 256-bit unguessable token (brute force is infeasible), per-link attempt lock (25), one response per link (DB unique index), POST-only business actions, per-instance in-memory per-IP limiter. Smallest reliable addition using existing Vercel capability (owner decision, no new service): one **Vercel Firewall custom rule** (available on the current plan, no extra product) for paths `/quote-response*` and `/api/quote-response*` with a rate limit of roughly 20 requests/minute per IP, action "Rate limit"/429, applied to Production first in "Log" mode for a week. The `/api/quote-response/document` route is the only heavy one (PDF stream) and benefits most. Remaining risk until then: a distributed flood is limited only per instance; it cannot guess a link or record a response, but it can consume function invocations.
