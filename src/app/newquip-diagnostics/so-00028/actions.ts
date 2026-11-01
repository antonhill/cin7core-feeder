"use server";

// TEMPORARY (UAT-027): one read-only look at the existing Cin7 Sale SO-00028. Takes NO arguments - the Sale, organisation and Cin7 instance are pinned
// in code. Owner/admin only. Exactly one Cin7 GET (fetchSaleDetailOnce: no retries); no Cin7 write, no database write, no audit payload, no retry, no reconciliation.
// Credentials are loaded and decrypted by the existing server-side loader and never leave this function. This file may export ONLY async functions.

import { requireOrgAdmin } from "@/lib/require-org-admin";
import { createServiceRoleClient } from "@/supabase/server";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchSaleDetailOnce } from "@/cin7/sales";
import { singleActiveInstanceId } from "@/lib/projects/cin7-adapter";
import { INSPECTED_SALE, inspectSale, type SaleInspection } from "@/lib/projects/sale-inspection";

/** A refusal this diagnostic raises itself: the only messages shown to the browser verbatim. Anything else is logged server-side and shown generically. */
class Refusal extends Error {}

export async function inspectSaleSo00028Action(): Promise<{ ok: boolean; error?: string; data?: SaleInspection }> {
  try {
    const { orgId } = await requireOrgAdmin("inspect a Cin7 Sale");
    if (orgId !== INSPECTED_SALE.orgId) throw new Refusal("This diagnostic is not available for this organisation.");
    const db = createServiceRoleClient();
    if ((await singleActiveInstanceId(db, orgId)) !== INSPECTED_SALE.instanceId) throw new Refusal("This diagnostic is pinned to a different Cin7 instance.");

    // Read-only: the Sale must be the one the Toolbox itself recorded creating for this organisation (a SELECT; nothing is written).
    const known = await db.from("project_cin7_sale_creations").select("id").eq("org_id", orgId).eq("cin7_sale_id", INSPECTED_SALE.saleId).eq("cin7_sale_number", INSPECTED_SALE.saleNumber);
    if (known.error) throw new Refusal("The Sale could not be checked against the creation records.");
    if ((known.data ?? []).length !== 1) throw new Refusal("The pinned Sale is not recorded as created by this organisation.");

    // The one Cin7 GET (/sale?ID=), with no retries: a rate-limit or network error is reported, never repeated.
    const detail = await fetchSaleDetailOnce(await loadCin7Credentials(db, orgId, INSPECTED_SALE.instanceId), INSPECTED_SALE.saleId);
    if (detail.ID !== INSPECTED_SALE.saleId) throw new Refusal("Cin7 returned a different Sale than the pinned one; nothing is shown.");
    return { ok: true, data: inspectSale(detail) };
  } catch (e) {
    if (e instanceof Refusal || (e instanceof Error && e.message.startsWith("Only an org owner or admin"))) return { ok: false, error: e.message };
    console.error("UAT-027 diagnostic failed:", e instanceof Error ? e.message.slice(0, 300) : "unknown"); // server log only
    return { ok: false, error: "The read failed. Nothing was changed. See the server log for the reason." };
  }
}
