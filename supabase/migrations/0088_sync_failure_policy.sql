-- P1 of the LBL scale remediation programme: stop deterministic catalog-push
-- failures from consuming every sync invocation, without ever making them look
-- synced.
--
-- Production evidence (live, "I-Light and LBL", 2026-09-06, after P0's paging
-- fix landed as 925be77):
--
--   3,876 sync_state rows in `failed`
--   3,864 of them (99.7%) are pre-flight reference-book failures
--   311 DISTINCT missing reference values explain all of them
--   three chart-of-accounts codes alone — 6100/001, 2000/001, 1000/001 —
--     block ~3,200 products each, i.e. ~83% of the catalog
--
-- None of these advance synced_hash (correctly — they never reached Cin7), so
-- every one is re-validated on every 15-minute run. That work, plus a Cin7
-- reference lookup for each distinct missing value, consumes the invocation
-- budget: the 18:00 run on 2026-09-06 died at the ~300s ceiling having never
-- reached markAttempted, the customer phase or the supplier phase.
--
-- WHY NEW COLUMNS RATHER THAN REUSING synced_hash. synced_hash means exactly
-- one thing — "the canonical content that last reached Cin7 successfully" —
-- and advancing it to suppress a retry would assert a push that never
-- happened. That would be a data-integrity lie, not an optimisation. The
-- suppression state is therefore separate and additive, and a failed row's
-- synced_hash is still never written.
--
--   failure_class        which KIND of failure, decided structurally at the
--                        failure site (not by parsing an error string):
--                          reference_validation — pre-flight found a missing
--                            reference; no Cin7 call was made at all
--                          rejected            — Cin7 answered and declined,
--                            non-retryable (e.g. duplicate SKU)
--                          transient           — Cin7ApiError.retryable
--                            (429, 502, network); NEVER suppressed
--                          ambiguous           — Cin7ApiError.ambiguous, a
--                            possibly-committed non-idempotent write; NEVER
--                            suppressed, reconciliation is authoritative
--                          unknown             — anything unclassified;
--                            NEVER suppressed, because unrecognised must not
--                            mean ignorable
--   failure_fingerprint  the canonical content this failure was observed for.
--                        Different content = a genuinely different attempt, so
--                        suppression does not carry over.
--   consecutive_failures drives the backoff, reset on any success.
--   next_retry_at        the earliest re-attempt. NULL means "eligible now",
--                        which is what every pre-existing row keeps.
--
-- Only the two deterministic classes are ever suppressed, and only until
-- next_retry_at, so a mis-classification costs a delay rather than silence.
--
-- MIGRATION SAFETY: additive columns only. No existing row is rewritten, no
-- failure is reclassified, and next_retry_at defaults to NULL — so every
-- pre-existing failure remains immediately eligible and is classified by the
-- first run that observes it. This fails toward retry, never toward
-- suppression.

alter table sync_state add column if not exists failure_class        text;
alter table sync_state add column if not exists failure_fingerprint  text;
alter table sync_state add column if not exists consecutive_failures integer not null default 0;
alter table sync_state add column if not exists next_retry_at        timestamptz;

comment on column sync_state.failure_class is
  'Structural failure classification set at the failure site: reference_validation | rejected | transient | ambiguous | unknown. Only the first two may be suppressed.';
comment on column sync_state.failure_fingerprint is
  'products.content_hash observed at the time of the failure. Suppression applies only while the current content_hash still matches.';
comment on column sync_state.consecutive_failures is
  'Consecutive failed attempts for this (org, instance, sku). Reset to 0 on any success.';
comment on column sync_state.next_retry_at is
  'Earliest re-attempt for a suppressed deterministic failure. NULL means eligible now.';

-- No index. The catalog push reads this table by (org_id, instance_id) — a
-- prefix of the existing primary key — and evaluates the retry decision in
-- memory over the rows it already holds. There is no query that filters on
-- next_retry_at, so an index on it would cost writes and serve nothing.

-- RLS and grants are untouched: sync_state's existing policy continues to
-- apply unchanged, and these columns inherit it. The table is written only by
-- the service-role sync path, exactly as before.
