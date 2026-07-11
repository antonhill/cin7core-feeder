import { NextResponse } from "next/server";
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

interface LemonSqueezyWebhookPayload {
  meta: {
    event_name: string;
    custom_data?: { org_id?: string };
  };
  data: {
    id: string;
    type: string;
    attributes: {
      status: string;
      customer_id: number;
      renews_at: string | null;
      ends_at: string | null;
      updated_at: string;
    };
  };
}

/**
 * Confirms this request genuinely came from Lemon Squeezy (HMAC signature
 * check) before touching anything, then updates the one org named in
 * `custom_data.org_id` (set at checkout time — see buildCheckoutUrl) to
 * match whatever Lemon Squeezy now says the subscription's status is.
 * Everything else this app already gates on subscription_status (see
 * src/lib/billing.ts) picks up the change on its next read — no other
 * plumbing needed.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get("x-signature");

  if (!verifyWebhookSignature(rawBody, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: LemonSqueezyWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const eventName = payload.meta?.event_name;
  if (!eventName || !SUBSCRIPTION_EVENTS.has(eventName)) {
    return NextResponse.json({ ok: true, ignored: eventName ?? "(no event_name)" });
  }

  const orgId = payload.meta.custom_data?.org_id;
  if (!orgId) {
    return NextResponse.json({ error: "No org_id in custom_data" }, { status: 400 });
  }

  if (!SUBSCRIPTION_TYPED_EVENTS.has(eventName)) {
    return NextResponse.json({ ok: true, ignored: `${eventName} (not a subscription-typed payload)` });
  }

  const status = mapSubscriptionStatus(payload.data.attributes.status);
  const eventAt = payload.data.attributes.updated_at;
  const db = createServiceRoleClient();
  // Guards against an out-of-order delivery (retry, or a "Simulate event"
  // test click) silently clobbering a newer real status — the WHERE clause
  // makes the freshness check atomic with the write instead of a separate
  // read-then-write that could itself race.
  const { data: updated, error } = await db
    .from("organizations")
    .update({
      subscription_status: status,
      billing_provider: "lemonsqueezy",
      billing_customer_id: String(payload.data.attributes.customer_id),
      billing_subscription_id: payload.data.id,
      subscription_current_period_end: payload.data.attributes.renews_at ?? payload.data.attributes.ends_at,
      subscription_event_at: eventAt,
    })
    .eq("id", orgId)
    .or(`subscription_event_at.is.null,subscription_event_at.lt.${eventAt}`)
    .select("id");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!updated || updated.length === 0) {
    return NextResponse.json({ ok: true, skipped: "stale event" });
  }
  return NextResponse.json({ ok: true });
}
