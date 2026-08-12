"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireModuleAccess } from "@/lib/authorization";
import { REPORTS_MODULE } from "@/app/module-nav";
import { getOrderFulfillmentReport, getReportFilterOptions } from "@/reports/query";
import type { OrderFulfillmentRow, OrderFulfillmentFilters } from "@/reports/query";
import type { InstancePickerItem } from "@/actions/instances";

export interface InvoicingSchedulerActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface InvoicingSchedulerData {
  orders: OrderFulfillmentRow[];
  instances: InstancePickerItem[];
}

/** Read-only — nothing here writes to Cin7, so unlike every write feature in this app there's no requireWriteAllowed gate. No per-SKU line detail either (unlike shipping-calendar's equivalent action) — this page is display + link only. */
export async function loadInvoicingSchedulerOrdersAction(filters: OrderFulfillmentFilters = {}): Promise<InvoicingSchedulerActionResult<InvoicingSchedulerData>> {
  try {
    const { orgId } = await requireModuleAccess(REPORTS_MODULE.href);
    const db = createServiceRoleClient();
    const [orders, options] = await Promise.all([getOrderFulfillmentReport(db, orgId, filters), getReportFilterOptions(db, orgId)]);
    return { ok: true, data: { orders, instances: options.instances } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface InstanceOrigin {
  instanceId: string;
  /** Cin7's web app origin (not the API base URL) — same `new URL(base_url).origin` derivation shipping-calendar/actions.ts already uses for its "open Cin7 Core" link. base_url itself isn't a secret (unlike the account/application key), so this is a plain DB read, no credential decryption needed. */
  origin: string;
}

export async function loadInstanceOriginsAction(): Promise<InvoicingSchedulerActionResult<InstanceOrigin[]>> {
  try {
    const { orgId } = await requireModuleAccess(REPORTS_MODULE.href);
    const db = createServiceRoleClient();
    const { data, error } = await db.from("cin7_instances").select("id, base_url").eq("org_id", orgId);
    if (error) return { ok: false, error: error.message };
    const origins = (data ?? []).map((row) => ({ instanceId: row.id as string, origin: new URL(row.base_url as string).origin }));
    return { ok: true, data: origins };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
