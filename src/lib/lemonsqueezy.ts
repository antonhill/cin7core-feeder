import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

const LEMONSQUEEZY_API_BASE = "https://api.lemonsqueezy.com/v1";

/** Read lazily (not at module load) so this file can be imported by tests without every var being set. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * Whether Lemon Squeezy has finished activating this store (tax
 * verification) — until then, both the hosted checkout and the customer
 * portal 404/403 for anyone who isn't already logged into the LS dashboard
 * as the store owner. Flip LEMONSQUEEZY_STORE_ACTIVE to "true" once that's
 * done; see checkoutAvailableFor in src/lib/billing.ts for how this gates
 * the Billing UI for orgs that haven't subscribed yet.
 */
export function isStoreActive(): boolean {
  return process.env.LEMONSQUEEZY_STORE_ACTIVE === "true";
}

/**
 * Security re-audit P1-4: generates a cryptographically random token and
 * persists it mapped to `orgId` (migration 0077's billing_checkout_tokens),
 * so the checkout URL below carries an unguessable, server-verified
 * reference instead of the raw org_id itself — which used to be fully
 * browser-editable (devtools/URL edit/network intercept) before checkout
 * completed, letting a malicious member attribute a payment to a different
 * org. The webhook handler looks org_id up by this token; it never trusts a
 * directly-supplied org_id from the webhook payload again.
 */
export async function createCheckoutToken(db: SupabaseClient, orgId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const { error } = await db.from("billing_checkout_tokens").insert({ token, org_id: orgId });
  if (error) throw new Error(`Failed to create checkout token: ${error.message}`);
  return token;
}

/**
 * Lemon Squeezy's hosted checkout — no API call needed, just a URL.
 * `checkout[custom][token]` is echoed back verbatim in every subsequent
 * webhook (`meta.custom_data.token`), which is how the webhook handler
 * (src/app/api/webhooks/lemonsqueezy/route.ts) knows which of our orgs a
 * subscription belongs to (via createCheckoutToken's mapping — see its own
 * comment for why this is a token, not the raw org_id).
 */
export function buildCheckoutUrl(checkoutToken: string, email: string | null): string {
  const storeSlug = requireEnv("LEMONSQUEEZY_STORE_SLUG");
  // Confirmed live 2026-07-11: this is the product's "Buy Link" ID (Products
  // > [product] > Share button in the LS dashboard), a UUID — NOT the
  // variant ID or product ID shown elsewhere in the dashboard UI, and the
  // path must include /checkout/. Both other combinations 404.
  const buyLinkId = requireEnv("LEMONSQUEEZY_BUY_LINK_ID");
  const url = new URL(`https://${storeSlug}.lemonsqueezy.com/checkout/buy/${buyLinkId}`);
  url.searchParams.set("checkout[custom][token]", checkoutToken);
  if (email) url.searchParams.set("checkout[email]", email);
  return url.toString();
}

/**
 * Lemon Squeezy signs every webhook body with HMAC-SHA256 (the `X-Signature`
 * header, hex-encoded) against the secret set when the webhook was created
 * in their dashboard. Verifying this is what stops anyone from POSTing a
 * fake "subscription active" event straight at the endpoint — the raw,
 * unparsed request body must be used (not a re-serialized JSON.stringify of
 * the parsed body, which can byte-for-byte differ from what was signed).
 */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!signatureHeader) return false;
  const secret = requireEnv("LEMONSQUEEZY_WEBHOOK_SECRET");
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  const expectedBuffer = Buffer.from(expected, "hex");
  const providedBuffer = Buffer.from(signatureHeader, "hex");
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

/** The customer's self-serve "manage subscription" portal link, fetched fresh from Lemon Squeezy — not stored locally since it's a short-lived signed URL, not a stable one. */
export async function fetchCustomerPortalUrl(subscriptionId: string): Promise<string> {
  const apiKey = requireEnv("LEMONSQUEEZY_API_KEY");
  const response = await fetch(`${LEMONSQUEEZY_API_BASE}/subscriptions/${subscriptionId}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/vnd.api+json",
    },
  });
  if (!response.ok) throw new Error(`Lemon Squeezy subscription lookup failed: ${response.status} ${await response.text().catch(() => "")}`.trim());
  const body = (await response.json()) as { data?: { attributes?: { urls?: { customer_portal?: string } } } };
  const url = body.data?.attributes?.urls?.customer_portal;
  if (!url) throw new Error("Lemon Squeezy response had no customer_portal URL");
  return url;
}

/**
 * Maps Lemon Squeezy's own subscription status vocabulary onto this app's
 * simpler enum (active/past_due/canceled — see src/lib/billing.ts). Our own
 * 7-day trial already runs independently of Lemon Squeezy and is tracked
 * separately (organizations.trial_ends_at), so "on_trial" here (a Lemon
 * Squeezy-side trial, not something configured on our variant) is treated
 * the same as active rather than introducing a second, redundant trial
 * concept.
 *
 * Security re-audit P1-4: returns null for anything NOT in this known
 * vocabulary (cancelled/expired/paused are explicitly recognized as
 * "canceled" — only a genuinely unrecognized string, e.g. a status Lemon
 * Squeezy adds later, falls through to null). Previously defaulted unknown
 * values straight to "canceled", which would silently cut off Cin7 write
 * access (see billing-status.ts's WRITE_ALLOWED_STATUSES) for a legitimately
 * active org the moment Lemon Squeezy sent a status string this mapping
 * didn't recognize. The webhook handler leaves the org's stored status
 * untouched on null rather than guessing.
 */
export function mapSubscriptionStatus(lsStatus: string): "active" | "past_due" | "canceled" | null {
  if (lsStatus === "active" || lsStatus === "on_trial") return "active";
  if (lsStatus === "past_due" || lsStatus === "unpaid") return "past_due";
  if (lsStatus === "cancelled" || lsStatus === "expired" || lsStatus === "paused") return "canceled";
  return null;
}
