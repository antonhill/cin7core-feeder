-- Security re-audit P1-4: replace browser-editable custom_data.org_id
-- authority with a server-persisted checkout token.
--
-- buildCheckoutUrl used to put the raw org_id straight into the hosted
-- checkout URL (checkout[custom][org_id]), which Lemon Squeezy echoes back
-- verbatim on every subsequent webhook. That URL is fully browser-editable
-- before checkout completes (devtools/URL edit/network intercept), so a
-- malicious org member could substitute any other org's UUID and have their
-- payment (or someone else's) attributed to a different org.
--
-- getCheckoutUrlAction now generates a cryptographically random token
-- server-side, stores it here mapped to the real org_id, and puts the TOKEN
-- (not the org_id) in custom_data. The webhook handler looks up org_id from
-- this table by token instead of trusting custom_data directly.
--
-- Rows are NOT deleted/expired after first use: Lemon Squeezy echoes the
-- SAME custom_data on every event for that subscription's entire lifecycle
-- (created, updated, cancelled, resumed, ...), potentially over months or
-- years — this is a durable checkout-session -> org mapping, not a one-time
-- CSRF-style token.

create table if not exists billing_checkout_tokens (
  token      text primary key,
  org_id     uuid not null references organizations (id) on delete cascade,
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists billing_checkout_tokens_org_id_idx on billing_checkout_tokens (org_id);

alter table billing_checkout_tokens enable row level security;
-- No policies: only the service-role client (which bypasses RLS) ever touches this —
-- getCheckoutUrlAction (creates) and the Lemon Squeezy webhook handler (reads).

comment on table billing_checkout_tokens is
  'Security re-audit P1-4 — maps a random checkout token (put in Lemon Squeezy custom_data instead of a raw org_id) to the org that initiated checkout. Service-role only.';
