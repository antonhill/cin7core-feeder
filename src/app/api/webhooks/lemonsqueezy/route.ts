import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/supabase/server";
import { verifyWebhookSignature, mapSubscriptionStatus } from "@/lib/lemonsqueezy";

/**
 * Every event Lemon Squeezy sends for a subscription lifecycle. Payment
 * events (success/failed/recovered) are handled by re-reading the
 * subscription's own `status` field rather than branching on the event name
 * itself — Lemon Squeezy already rolls a failed/recovered payment into the
 * subscription's status (past_due/active), so there's one mapping to keep
 * in sync (mapSubscriptionStatus), not one per event type.
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

interface LemonSqueezyWebhookPayload {
  meta: {
    event_name: string;
    custom_data?: { org_id?: string };
  };
  data: {
    id: string;
    attributes: {
      status: string;
      customer_id: number;
      renews_at: string | null;
      ends_at: string | null;
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

  const status = mapSubscriptionStatus(payload.data.attributes.status);
  const db = createServiceRoleClient();
  const { error } = await db
    .from("organizations")
    .update({
      subscription_status: status,
      billing_provider: "lemonsqueezy",
      billing_customer_id: String(payload.data.attributes.customer_id),
      billing_subscription_id: payload.data.id,
      subscription_current_period_end: payload.data.attributes.renews_at ?? payload.data.attributes.ends_at,
    })
    .eq("id", orgId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
