"use server";

import { requireCurrentOrg } from "@/lib/current-org";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { getBillingStatus, type BillingStatus } from "@/lib/billing";
import { buildCheckoutUrl, createCheckoutToken, fetchCustomerPortalUrl } from "@/lib/lemonsqueezy";
import { createServiceRoleClient } from "@/supabase/server";

export interface BillingStatusResult {
  ok: boolean;
  error?: string;
  data?: BillingStatus;
}

/** Read-only — lets a page know whether to disable its write actions and show "Available on a paid plan," without duplicating the billing lookup per page. */
export async function getBillingStatusAction(): Promise<BillingStatusResult> {
  try {
    const { orgId } = await requireCurrentOrg();
    const data = await getBillingStatus(orgId);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface BillingUrlResult {
  ok: boolean;
  error?: string;
  url?: string;
}

/**
 * Lemon Squeezy's hosted checkout — the actual subscription state only changes
 * once its webhook fires (see src/app/api/webhooks/lemonsqueezy/route.ts), not
 * on redirect back here.
 *
 * Owner/admin only (requireOrgAdmin): committing the org to a paid plan is a
 * billing decision, not something an ordinary member should be able to trigger.
 * getBillingStatusAction above stays member-readable so the page still renders
 * for everyone — only the money-moving buttons are gated.
 */
export async function getCheckoutUrlAction(): Promise<BillingUrlResult> {
  try {
    const { orgId, email } = await requireOrgAdmin("manage billing");
    const db = createServiceRoleClient();
    const token = await createCheckoutToken(db, orgId);
    return { ok: true, url: buildCheckoutUrl(token, email) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Only available once a subscription actually exists (billing_subscription_id
 * set by the webhook) — an org still on trial has nothing to manage yet.
 *
 * Owner/admin only (requireOrgAdmin): the customer-portal link exposes payment
 * method, invoices, plan changes and cancellation — all owner/admin territory.
 */
export async function getManageSubscriptionUrlAction(): Promise<BillingUrlResult> {
  try {
    const { orgId } = await requireOrgAdmin("manage billing");
    const db = createServiceRoleClient();
    const { data, error } = await db.from("organizations").select("billing_subscription_id").eq("id", orgId).single();
    if (error) throw new Error(error.message);
    if (!data?.billing_subscription_id) throw new Error("No active subscription to manage yet.");
    const url = await fetchCustomerPortalUrl(data.billing_subscription_id);
    return { ok: true, url };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
