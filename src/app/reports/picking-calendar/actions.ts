"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireModuleAccess } from "@/lib/authorization";
import { requireWriteAllowed } from "@/lib/billing";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { PICKING_CALENDAR_MODULE } from "@/app/module-nav";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { updateSaleShipBy } from "@/cin7/sales";
import { recordShipByChange } from "@/lib/ship-by-notifications";
import {
  getOrderFulfillmentReport,
  getOrderFulfillmentLines,
  getReportFilterOptions,
  type OrderFulfillmentRow,
  type OrderFulfillmentLineRow,
  type OrderFulfillmentFilters,
} from "@/reports/query";
import type { InstancePickerItem } from "@/actions/instances";

export interface PickingCalendarActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface PickingCalendarData {
  orders: OrderFulfillmentRow[];
  lines: OrderFulfillmentLineRow[];
  instances: InstancePickerItem[];
}

/**
 * Deliberately its own action, not a re-export of Shipping Calendar's
 * loadShippingCalendarOrdersAction, even though the body is identical —
 * that one is gated on REPORTS_MODULE.href, which stays enabled even for an
 * org that has Picking Calendar itself turned off. requireModuleAccess is
 * the per-Server-Action gate that can't be routed around (see
 * lib/authorization.ts); reusing the Shipping Calendar action verbatim
 * would silently bypass Picking Calendar's own off-by-default toggle.
 */
export async function loadPickingCalendarOrdersAction(filters: OrderFulfillmentFilters = {}): Promise<PickingCalendarActionResult<PickingCalendarData>> {
  try {
    const { orgId } = await requireModuleAccess(PICKING_CALENDAR_MODULE.href);
    const db = createServiceRoleClient();
    const [orders, lines, options] = await Promise.all([
      getOrderFulfillmentReport(db, orgId, filters),
      getOrderFulfillmentLines(db, orgId, filters),
      getReportFilterOptions(db, orgId),
    ]);
    return { ok: true, data: { orders, lines, instances: options.instances } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Same Cin7 write + local mirror as Shipping Calendar's updateOrderShipByAction (reused per the brief), re-gated to Picking Calendar's own module — see loadPickingCalendarOrdersAction's comment above for why. */
export async function updatePickingShipByAction(instanceId: string, saleId: string, shipBy: string): Promise<PickingCalendarActionResult<void>> {
  try {
    const { orgId, email } = await requireModuleAccess(PICKING_CALENDAR_MODULE.href);
    // Security re-audit P1-3: this writes to Cin7 (updateSaleShipBy below) —
    // requireModuleAccess alone only checks module visibility, not the org's
    // billing plan. Same gap Shipping Calendar's own updateOrderShipByAction
    // had (this function was copied from it, per the comment above).
    await requireWriteAllowed(orgId);
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);

    // Read before write — see Shipping Calendar's updateOrderShipByAction
    // for why (P4 needs the pre-change value for its notification email).
    const { data: existing } = await db
      .from("sales")
      .select("ship_by")
      .eq("org_id", orgId)
      .eq("instance_id", instanceId)
      .eq("cin7_sale_id", saleId)
      .maybeSingle();

    await updateSaleShipBy(creds, saleId, shipBy);

    const { error } = await db
      .from("sales")
      .update({ ship_by: shipBy })
      .eq("org_id", orgId)
      .eq("instance_id", instanceId)
      .eq("cin7_sale_id", saleId);
    if (error) throw new Error(`sales table mirror update: ${error.message}`);

    await recordShipByChange(db, {
      orgId,
      instanceId,
      cin7SaleId: saleId,
      oldShipBy: existing?.ship_by ?? null,
      newShipBy: shipBy,
      changedByEmail: email,
    });

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface PickingCalendarSettings {
  offsetDays: number;
}

// Not exported — a "use server" module may only export async functions, so
// this stays a private default the action falls back to internally.
const DEFAULT_PICKING_CALENDAR_OFFSET_DAYS = 1;

/** Every org member can read the org's saved offset — same read-access level as everything else on this board. */
export async function getPickingCalendarSettingsAction(): Promise<PickingCalendarActionResult<PickingCalendarSettings>> {
  try {
    const { orgId } = await requireModuleAccess(PICKING_CALENDAR_MODULE.href);
    const db = createServiceRoleClient();
    const { data } = await db.from("picking_calendar_settings").select("offset_days").eq("org_id", orgId).maybeSingle();
    return { ok: true, data: { offsetDays: data ? Number(data.offset_days) : DEFAULT_PICKING_CALENDAR_OFFSET_DAYS } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Gated to org owners/admins (requireOrgAdmin) — same reasoning as Purchase
 * Planner's savePurchasePlannerSettingsAction: this reshapes what every
 * user on the board sees, not a personal preference, so it shouldn't be
 * left open to any org member the way reading it is.
 */
export async function savePickingCalendarSettingsAction(offsetDays: number): Promise<PickingCalendarActionResult<null>> {
  try {
    const { orgId } = await requireOrgAdmin();
    const db = createServiceRoleClient();
    const { error } = await db.from("picking_calendar_settings").upsert(
      { org_id: orgId, offset_days: offsetDays, updated_at: new Date().toISOString() },
      { onConflict: "org_id" }
    );
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
