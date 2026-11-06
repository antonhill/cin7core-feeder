-- NewQuip customer quotation delivery: privilege hardening for the five tables created by 0115 (privileges only; no schema or data change). NOT applied to hosted Supabase.
--
-- Migration 0115 created its tables with Supabase's DEFAULT privileges, which give anon and authenticated every table privilege (including TRUNCATE, which ignores row-level
-- security and the row triggers). Migrations 0112 and 0113 set the NewQuip pattern: revoke everything from anon / authenticated, then grant authenticated SELECT only; all
-- writes go through service-role Server Actions. This migration brings 0115's tables into line, and takes direct EXECUTE away from the seven trigger functions
-- (a trigger function's EXECUTE privilege is checked when the trigger is CREATED, not each time it fires, so the existing triggers keep working).
-- Idempotent: REVOKE / GRANT can be repeated any number of times. No row is read or modified; the RLS policies from 0115 (SELECT for organisation members) are untouched.
-- Rollback: `grant all on <the five tables> to anon, authenticated;` restores the previous (over-broad) state; nothing depends on it.

revoke all on newquip_quote_customers, newquip_company_profiles, newquip_quote_documents, newquip_quote_sends, newquip_quote_responses from public, anon, authenticated;
grant select on newquip_quote_customers, newquip_company_profiles, newquip_quote_documents, newquip_quote_sends, newquip_quote_responses to authenticated;
-- the service role is what the authorised Server Actions use (and it bypasses RLS); state its needs explicitly so this does not depend on the platform's defaults
grant select, insert, update, delete on newquip_quote_customers, newquip_company_profiles, newquip_quote_documents, newquip_quote_sends, newquip_quote_responses to service_role;

revoke all on function
  newquip_quotes_acceptance_flag_guard(),
  newquip_company_profiles_version(),
  newquip_company_profiles_guard(),
  newquip_quote_customers_guard(),
  newquip_quote_documents_guard(),
  newquip_quote_sends_guard(),
  newquip_quote_responses_guard()
from public, anon, authenticated;
