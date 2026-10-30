# Migration 0117 — customer response portal (NOT applied; owner approval required)

File: `supabase/migrations/0117_newquip_customer_response_portal.sql` — SHA-256 `d4fdce0b839927839b5457267b86ea0b567fd7c923096418bac532b661c2afc9` (re-check with `shasum -a 256` before applying).
Test: `supabase/tests/0117_newquip_customer_response_portal.test.sql` (transactional, leaves no rows). CI runs it after a clean `supabase db reset`.

## Ledger refresh (read-only, taken 2026-10-30 before numbering)
Hosted ledger tail: `20261029204304 newquip_delivery_privilege_hardening` (= repo 0116, **applied**), then `20261029201206 newquip_customer_quotation_delivery` (0115), `20261029143222 newquip_fx_rates` (0113). So 0116 is applied and registered and the next number is **0117**. Migration **0114** (`SUPPRESSED` notification status) is a separate, still-outstanding item and is **not** a prerequisite of 0117.

## What it does (additive only)
- `newquip_quote_responses`: adds `origin` (default `STAFF`), `contact_email`, `contact_source`, `contact_company`, `exception_reason`, `authority_confirmed`, `document_hash`, `link_id`, `origin_hint`, plus CHECKs, a unique index on `link_id` (one response per link) and `unique (id, org_id)`. Existing rows become `origin = 'STAFF'` and are otherwise untouched.
- New tables `newquip_response_links`, `newquip_response_reviews`, `newquip_response_evidence` with RLS (SELECT for organisation members), guard triggers (append-only reviews / evidence; links change only by one-way revocation and the attempt counter), no client writes, no anon/PUBLIC privileges, **no TRUNCATE**, the token hash column unreadable by `authenticated`, and EXECUTE revoked on the four guard functions (including the replaced `newquip_quote_responses_guard`).
- No storage change: evidence uses the existing private bucket `newquip-quote-documents` (service-role only; no storage policy) under `<org>/evidence/...`.

## Dormant until applied
Without 0117 the code fails closed: emails carry no response links; Stage 5 records responses exactly as before (name only, no files); the public `/quote-response` page answers "online responses are not available"; no verification state exists. Nothing in 0117 affects grandfathered quotations (their gate is unchanged).

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
-- 7 bucket still private
select id, public from storage.buckets where id = 'newquip-quote-documents';
```

## Rollback
`drop table newquip_response_evidence, newquip_response_reviews, newquip_response_links cascade;` then drop the added `newquip_quote_responses` columns/constraints (`alter table newquip_quote_responses drop constraint newquip_quote_responses_link_fk, ...`). Remove any evidence objects under `<org>/evidence/` in the bucket. The application keeps working without the tables (it detects their absence).

## Owner-controlled settings (not changed by this work)
`NEXT_PUBLIC_SITE_URL` must be an `https://` address for the emailed links to be generated; `NEWQUIP_RESPONSE_LINK_DAYS` (optional, 1–30, default 14) sets the link lifetime. The Preview recipient allowlist, `[PREVIEW]` marking and Resend configuration are untouched. Per-IP rate limiting in the application is best-effort and per instance; a platform firewall rule on `/quote-response` and `/api/quote-response` is the owner's decision.
