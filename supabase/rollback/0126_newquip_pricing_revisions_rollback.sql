-- ROLLBACK for 0126_newquip_pricing_revisions.sql. Run only with owner approval.
--
-- Removes ONLY the objects 0126 created: the atomic apply function, the append-only guard function and the immutable revision table (its guard trigger, indexes and RLS go with the table).
-- It does NOT touch newquip_quotes or any quotation draft (a quotation's `estimator.pricing` lives inside its own draft JSON, never in the dropped table), and it does not touch 0122, 0123 or 0127.
--
-- IMPORTANT (data): dropping newquip_pricing_revisions DELETES every recorded pricing revision (the audit history of who changed which supplier cost / rate / evidence, when and why).
-- Before 0126 has been used (no quotation has `estimator.pricing`), this is lossless. After pricing has been enabled on any quotation, EXPORT the table first (service role: select * from newquip_pricing_revisions)
-- and consider switching pricing off per quotation instead: without the table and function the application reports "pricing revisions are not available" and refuses every pricing change (it fails closed).
--
-- The 0126 file header documents a drop signature with 15 argument types; the function has 14 (below is the correct one). Idempotent: re-running is safe.

drop function if exists newquip_apply_pricing_revision(uuid, uuid, integer, text, jsonb, text, text, text, text, jsonb, jsonb, jsonb, text, text);
drop table if exists newquip_pricing_revisions;
drop function if exists newquip_pricing_revisions_guard();
