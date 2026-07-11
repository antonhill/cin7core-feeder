-- Lemon Squeezy webhooks are not guaranteed to arrive in the order they were
-- generated (retries, a manual "Simulate event" test, ordinary network
-- reordering), and the webhook handler previously applied whatever status
-- arrived last with no check — confirmed live 2026-07-11: a stray event
-- overwrote a genuinely active subscription's status back to "canceled".
-- Storing the subscription resource's own updated_at lets the handler reject
-- any incoming event older than what's already stored, atomically, in the
-- same UPDATE.
alter table organizations
  add column subscription_event_at timestamptz;
