import crypto from "node:crypto";

const LEMONSQUEEZY_API_BASE = "https://api.lemonsqueezy.com/v1";

/** Read lazily (not at module load) so this file can be imported by tests without every var being set. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/**
 * Lemon Squeezy's hosted checkout — no API call needed, just a URL.
 * `checkout[custom][org_id]` is echoed back verbatim in every subsequent
 * webhook (`meta.custom_data.org_id`), which is how the webhook handler
 * (src/app/api/webhooks/lemonsqueezy/route.ts) knows which of our orgs a
 * subscription belongs to.
 */
export function buildCheckoutUrl(orgId: string, email: string | null): string {
  const storeSlug = requireEnv("LEMONSQUEEZY_STORE_SLUG");
  // Confirmed live 2026-07-11: this is the product's "Buy Link" ID (Products
  // > [product] > Share button in the LS dashboard), a UUID — NOT the
  // variant ID or product ID shown elsewhere in the dashboard UI, and the
  // path must include /checkout/. Both other combinations 404.
  const buyLinkId = requireEnv("LEMONSQUEEZY_BUY_LINK_ID");
  const url = new URL(`https://${storeSlug}.lemonsqueezy.com/checkout/buy/${buyLinkId}`);
  url.searchParams.set("checkout[custom][org_id]", orgId);
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
 */
export function mapSubscriptionStatus(lsStatus: string): "active" | "past_due" | "canceled" {
  if (lsStatus === "active" || lsStatus === "on_trial") return "active";
  if (lsStatus === "past_due" || lsStatus === "unpaid") return "past_due";
  return "canceled"; // cancelled, expired, paused
}
