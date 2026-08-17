import { NextResponse } from "next/server";
import { z } from "zod";
import { createServiceRoleClient } from "@/supabase/server";
import { verifyWebhookSignature, mapSubscriptionStatus } from "@/lib/lemonsqueezy";

/**
 * Every event Lemon Squeezy sends for a subscription lifecycle. Confirmed
 * live 2026-07-11: the lifecycle events (created/updated/cancelled/etc.)
 * carry the actual `subscriptions` resource in `data`, but the payment
 * events (success/failed/recovered) instead carry a `subscription-invoices`
 * resource — a different shape entirely (its `id` is the invoice's own ID,
 * not the subscription's, and it has no `renews_at`/`ends_at`, and its
 * `status` means paid/refunded/etc., not active/cancelled/etc.). Treating
 * every event the same way previously overwrote a real subscription ID with
 * an invoice ID, and fed an invoice status through mapSubscriptionStatus
 * (which doesn't recognize it, so it silently fell through to "canceled").
 * Payment events are still listened for (so the endpoint doesn't 404 them),
 * but only SUBSCRIPTION_TYPED_EVENTS below actually update our stored
 * status — Lemon Squeezy always pairs a payment event with its own
 * subscription_updated event carrying the resulting status, so nothing is
 * lost by ignoring the invoice payload itself.
 */
const SUBSCRIPTION_EVENTS = new Set([
  "subscription_created",
  "subscription_updated",
  "subscription_cancelled",
  "subscription_resumed",
  "subscription_expired",
  "subscription_paused",
  "subscription_unpaused",
  "subscription_payment_failed",
  "subscription_payment_success",
  "subscription_payment_recovered",
]);

const SUBSCRIPTION_TYPED_EVENTS = new Set([
  "subscription_created",
  "subscription_updated",
  "subscription_cancelled",
  "subscription_resumed",
  "subscription_expired",
  "subscription_paused",
  "subscription_unpaused",
]);

// Security re-audit P1-4: runtime-validated instead of a bare TS interface
// cast — an unexpected/malformed payload now gets a clean 400 instead of
// either an unhandled exception or silently writing garbage into
// `organizations`. Two stages, matching the code's own existing two-stage
// trust model: `basePayloadSchema` covers what EVERY event (including the
// differently-shaped payment/invoice events) genuinely has; `data` uses
// .passthrough() so `attributes`' actual shape rides along unvalidated at
// this stage. `subscriptionAttributesSchema` is only applied once the event
// is confirmed to be one of SUBSCRIPTION_TYPED_EVENTS (a real `subscriptions`
// resource, not an invoice) — validating it eagerly for every event would
// reject legitimate payment-event payloads before they even reach the
// "ignored, not typed" branch.
const basePayloadSchema = z.object({
  meta: z.object({
    event_name: z.string(),
    // Security re-audit P1-4: `token`, not `org_id` — see createCheckoutToken.
    custom_data: z.object({ token: z.string().optional() }).optional(),
  }),
  data: z
    .object({
      id: z.string(),
      type: z.string(),
    })
    .passthrough(),
});

const subscriptionAttributesSchema = z.object({
  status: z.string(),
  customer_id: z.number(),
  renews_at: z.string().nullable(),
  ends_at: z.string().nullable(),
  updated_at: z.string(),
});

/**
 * Confirms this request genuinely came from Lemon Squeezy (HMAC signature
 * check) before touching anything, then updates the one org whose checkout
 * token matches `custom_data.token` (set at checkout time — see
 * createCheckoutToken/buildCheckoutUrl) to match whatever Lemon Squeezy now
 * says the subscription's status is. Everything else this app already gates
 * on subscription_status (see src/lib/billing.ts) picks up the change on its
 * next read — no other plumbing needed.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-signature");

  if (!verifyWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const basePayload = basePayloadSchema.safeParse(rawJson);
  if (!basePayload.success) {
    return NextResponse.json({ error: `Invalid webhook payload: ${basePayload.error.message}` }, { status: 400 });
  }
  const { meta, data } = basePayload.data;

  const eventName = meta.event_name;
  if (!SUBSCRIPTION_EVENTS.has(eventName)) {
    return NextResponse.json({ ok: true, ignored: eventName });
  }

  const token = meta.custom_data?.token;
  if (!token) {
    return NextResponse.json({ error: "No token in custom_data" }, { status: 400 });
  }

  const db = createServiceRoleClient();

  // Security re-audit P1-4: resolves org_id from the server-persisted
  // token mapping (migration 0077) — the webhook payload's custom_data is
  // otherwise attacker-influenceable (an org member controls what's sent at
  // checkout time), so it must never be trusted as an org identifier
  // directly. An unrecognized token means either a very old checkout (before
  // this mapping existed) or a forged request; either way, there's no real
  // org to attribute this event to.
  const { data: tokenRow, error: tokenError } = await db
    .from("billing_checkout_tokens")
    .select("org_id")
    .eq("token", token)
    .maybeSingle();
  if (tokenError) return NextResponse.json({ error: tokenError.message }, { status: 500 });
  if (!tokenRow) return NextResponse.json({ error: "Unrecognized checkout token" }, { status: 400 });
  const orgId = tokenRow.org_id;

  if (!SUBSCRIPTION_TYPED_EVENTS.has(eventName)) {
    return NextResponse.json({ ok: true, ignored: `${eventName} (not a subscription-typed payload)` });
  }

  const attributesResult = subscriptionAttributesSchema.safeParse(data.attributes);
  if (!attributesResult.success) {
    return NextResponse.json({ error: `Invalid subscription payload: ${attributesResult.error.message}` }, { status: 400 });
  }
  const attributes = attributesResult.data;

  // Security re-audit P1-4: mapSubscriptionStatus now returns null for a
  // status outside its known vocabulary, instead of silently defaulting to
  // "canceled" — an unrecognized status must not cut off a legitimately
  // active org's Cin7 write access. subscription_status is only included in
  // the update below when it's actually known; every other field (customer
  // id, subscription id, renewal date, event timestamp) is safe to record
  // regardless of whether the status itself was understood.
  const status = mapSubscriptionStatus(attributes.status);
  const eventAt = attributes.updated_at;

  const update: Record<string, unknown> = {
    billing_provider: "lemonsqueezy",
    billing_customer_id: String(attributes.customer_id),
    billing_subscription_id: data.id,
    subscription_current_period_end: attributes.renews_at ?? attributes.ends_at,
    subscription_event_at: eventAt,
  };
  if (status) update.subscription_status = status;

  // Guards against an out-of-order delivery (retry, or a "Simulate event"
  // test click) silently clobbering a newer real status — the WHERE clause
  // makes the freshness check atomic with the write instead of a separate
  // read-then-write that could itself race.
  const { data: updated, error } = await db
    .from("organizations")
    .update(update)
    .eq("id", orgId)
    .or(`subscription_event_at.is.null,subscription_event_at.lt.${eventAt}`)
    .select("id");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated || updated.length === 0) {
    return NextResponse.json({ ok: true, skipped: "stale event" });
  }
  if (!status) {
    console.error(`Lemon Squeezy webhook: unrecognized subscription status "${attributes.status}" for org ${orgId} — left subscription_status untouched`);
  }
  return NextResponse.json({ ok: true });
}
