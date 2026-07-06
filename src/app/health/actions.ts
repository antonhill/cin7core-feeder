"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllProductsWithBom } from "@/cin7/products";
import { fetchAllSalesList } from "@/cin7/sales";
import { fetchAllPurchasesList } from "@/cin7/purchases";
import { fetchAllStockTransfersList } from "@/cin7/stock-transfers";
import { fetchAllFinishedGoodsList } from "@/cin7/finished-goods";
import { fetchAllProductionOrdersList } from "@/cin7/production-orders";
import { runProductAudit } from "@/audit/product-audit";
import { runSystemHealth, type SystemHealthResult } from "@/health/system-health";

export interface HealthActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

/** Pulls every relevant record live from the chosen instance and scores it across all 6 System Health dimensions — read-only, nothing is written. */
export async function runSystemHealthAction(instanceId: string): Promise<HealthActionResult<SystemHealthResult>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);

    const [products, sales, purchases, transfers, finishedGoods, productionOrders] = await Promise.all([
      fetchAllProductsWithBom(creds),
      fetchAllSalesList(creds),
      fetchAllPurchasesList(creds),
      fetchAllStockTransfersList(creds),
      fetchAllFinishedGoodsList(creds),
      fetchAllProductionOrdersList(creds),
    ]);

    const productAudit = runProductAudit(products);
    return { ok: true, data: runSystemHealth({ sales, purchases, transfers, finishedGoods, productionOrders, productAudit }) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
