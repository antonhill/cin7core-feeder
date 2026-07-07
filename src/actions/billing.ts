"use server";

import { requireCurrentOrg } from "@/lib/current-org";
import { getBillingStatus, type BillingStatus } from "@/lib/billing";

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
