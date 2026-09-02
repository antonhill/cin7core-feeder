"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireModuleAccess } from "@/lib/authorization";
import { PRICING_MODULE } from "@/app/module-nav";
import { requireWriteAllowed } from "@/lib/billing";
import { requireAal2 } from "@/lib/require-privileged";
import { logActivity } from "@/lib/activity-log";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllProductsForPricing, type PricingFetchResult } from "@/cin7/pricing";
import { applyProductFixes, type ProductFix, type ApplyFixesResult } from "@/audit/apply-fixes";
import type { PriceUpdateLine } from "@/pricing/build";

export interface PricingActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

/**
 * Fetches every product live from the chosen instance, including Category/
 * Suppliers/PriceTier1-10 — no canonical-DB detour, same "fix the account
 * you're actually looking at" reasoning Data Audit already established, and
 * the same "live-fetched, not DB-stored" reasoning as Replenish's
 * ReorderLevels (Cin7 pricing has no local sync/storage at all in this
 * app). Deliberately does NOT filter or compute proposed lines itself — the
 * client runs filterPriceableProducts/buildPriceUpdateLines directly, so
 * changing the category/supplier/search filters or the tier/mode/value
 * recomputes instantly with no extra round trip.
 */
export async function loadPricingPreviewAction(instanceId: string): Promise<PricingActionResult<PricingFetchResult>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  try {
    const { orgId } = await requireModuleAccess(PRICING_MODULE.href);
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);
    const result = await fetchAllProductsForPricing(creds);
    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Pushes the proposed price changes straight to Cin7 — one PUT /Product per
 * product (via the same `applyProductFixes` Data Audit's bulk fixes already
 * use), each carrying only the ID plus the single `PriceTierN` field being
 * changed.
 *
 * CCT-ADR-0015 classifies this as an ordinary-member action that also
 * requires a step-up (AAL2), so it uses `requireAal2` and deliberately NOT an
 * admin guard — the assurance sits on the action, not on the role. The check
 * runs before credentials are loaded and before any fix payload is built, so
 * a failed or unreadable assurance state can never reach a Cin7 write. It is
 * NOT pushed down into `applyProductFixes`: that helper is shared with Data
 * Audit bulk fixes and reorder-point edits, both of which ADR-0015 classifies
 * as needing no added assurance.
 */
export async function applyPriceUpdatesAction(
  instanceId: string,
  tierLabel: string,
  lines: PriceUpdateLine[]
): Promise<PricingActionResult<ApplyFixesResult>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  if (!lines.length) return { ok: false, error: "Nothing to apply." };
  try {
    const { orgId, userId, email } = await requireModuleAccess(PRICING_MODULE.href);
    await requireWriteAllowed(orgId);
    await requireAal2("apply bulk price updates");
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);

    const fixes: ProductFix[] = lines.map((line) => ({
      productId: line.productId,
      fields: { [`PriceTier${line.tierIndex + 1}`]: line.newValue },
    }));
    const result = await applyProductFixes(creds, fixes);

    await logActivity(db, {
      orgId,
      instanceId,
      actor: { userId, email },
      action: "pricing.bulk_update",
      summary: `Updated "${tierLabel}" on ${result.succeeded} product${result.succeeded === 1 ? "" : "s"}${
        result.failed.length ? ` (${result.failed.length} failed)` : ""
      }`,
      detail: { tierLabel, lines, failed: result.failed },
    });

    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
