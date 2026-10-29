-- NewQuip approval emails: a distinct SUPPRESSED delivery status (additive; applies after 0113). NOT applied to hosted Supabase.
--
-- On a Preview, the outbound email policy withholds mail to anyone outside the test allowlist. That is neither a success nor a provider failure, so it gets its
-- own status. Until this migration is applied the code records such rows as ABANDONED with a "SUPPRESSED:" marker in last_error, which the Delivery screen
-- already shows as Suppressed; nothing breaks either way. Existing rows and constraints are untouched except the status list; no data is modified.

alter table approval_notifications drop constraint if exists approval_notifications_status_check;
alter table approval_notifications add constraint approval_notifications_status_check
  check (status in ('PENDING', 'SENT', 'FAILED', 'ABANDONED', 'SUPPRESSED'));
-- the existing (status = 'SENT') = (sent_at is not null) check already forbids a SUPPRESSED row from carrying a sent_at.
