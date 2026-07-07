-- Self-serve signup + 7-day trial, Phase 1: schema.
--
-- Trial state and subscription state are two separate systems that meet at
-- exactly one moment (clicking "Subscribe", built in a later phase) — this
-- migration only adds the trial half. billing_provider/billing_customer_id/
-- billing_subscription_id are deliberately generic (no "paystack_"/"stripe_"
-- prefix) since the payment provider is not decided yet; whichever is chosen
-- later populates these without a schema rework.
create type subscription_status as enum ('trialing', 'active', 'past_due', 'canceled');

alter table organizations
  add column subscription_status subscription_status not null default 'trialing',
  add column trial_ends_at timestamptz not null default (now() + interval '7 days'),
  add column max_instances int not null default 1,
  add column billing_provider text,
  add column billing_customer_id text,
  add column billing_subscription_id text,
  add column subscription_current_period_end timestamptz;

-- Every org that already exists is a real, already-onboarded client, not a
-- new trial — without this, the two ADD COLUMN defaults above would
-- otherwise "expire" every current client the moment this migration applies.
update organizations set subscription_status = 'active', max_instances = 2147483647;
