"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import { requireOrgAdmin } from "@/lib/require-org-admin";

export interface NotificationsActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface ShipByNotificationSettings {
  enabled: boolean;
  ccEmails: string[];
  debounceMinutes: number;
}

const DEFAULT_SETTINGS: ShipByNotificationSettings = { enabled: false, ccEmails: [], debounceMinutes: 15 };

/** Every org member can read — same read-access level as Purchase Planner/Picking Calendar's own settings. */
export async function getShipByNotificationSettingsAction(): Promise<NotificationsActionResult<ShipByNotificationSettings>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const { data } = await db
      .from("ship_by_notification_settings")
      .select("enabled, cc_emails, debounce_minutes")
      .eq("org_id", orgId)
      .maybeSingle();
    if (!data) return { ok: true, data: DEFAULT_SETTINGS };
    return {
      ok: true,
      data: { enabled: data.enabled, ccEmails: data.cc_emails ?? [], debounceMinutes: Number(data.debounce_minutes) },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Gated to org owners/admins — same reasoning as every other settings table
 * here (Purchase Planner, Picking Calendar): this reshapes a shared,
 * org-wide policy (who gets emailed, whether the feature runs at all), not
 * a personal preference.
 */
export async function saveShipByNotificationSettingsAction(settings: ShipByNotificationSettings): Promise<NotificationsActionResult<null>> {
  try {
    const { orgId } = await requireOrgAdmin();
    const db = createServiceRoleClient();
    const { error } = await db.from("ship_by_notification_settings").upsert(
      {
        org_id: orgId,
        enabled: settings.enabled,
        cc_emails: settings.ccEmails,
        debounce_minutes: settings.debounceMinutes,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "org_id" }
    );
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface RepMapping {
  repName: string;
  email: string;
}

export async function listShipByNotificationRepsAction(): Promise<NotificationsActionResult<RepMapping[]>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const { data, error } = await db
      .from("ship_by_notification_reps")
      .select("rep_name, email")
      .eq("org_id", orgId)
      .order("rep_name");
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: (data ?? []).map((r) => ({ repName: r.rep_name, email: r.email })) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Every distinct SalesRepresentative string actually seen on this org's
 * synced sales — offered as a pick-list so mapping a rep doesn't mean
 * guessing/retyping Cin7's own free-text value (same reasoning as the
 * carrier pick-list on Shipping Calendar's Mark-as-Shipped form). Read-only,
 * derived straight from `sales`, no separate table.
 */
export async function listKnownSalesRepsAction(): Promise<NotificationsActionResult<string[]>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const { data, error } = await db.from("sales").select("sales_rep").eq("org_id", orgId).not("sales_rep", "is", null);
    if (error) return { ok: false, error: error.message };
    const names = [...new Set((data ?? []).map((r) => r.sales_rep as string))].sort();
    return { ok: true, data: names };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function saveShipByNotificationRepAction(repName: string, email: string): Promise<NotificationsActionResult<null>> {
  try {
    const { orgId } = await requireOrgAdmin();
    const db = createServiceRoleClient();
    const { error } = await db.from("ship_by_notification_reps").upsert(
      { org_id: orgId, rep_name: repName, email, updated_at: new Date().toISOString() },
      { onConflict: "org_id,rep_name" }
    );
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function deleteShipByNotificationRepAction(repName: string): Promise<NotificationsActionResult<null>> {
  try {
    const { orgId } = await requireOrgAdmin();
    const db = createServiceRoleClient();
    const { error } = await db.from("ship_by_notification_reps").delete().eq("org_id", orgId).eq("rep_name", repName);
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface BomAlertSettings {
  enabled: boolean;
  warehouseManagerEmail: string;
}

const DEFAULT_BOM_ALERT_SETTINGS: BomAlertSettings = { enabled: false, warehouseManagerEmail: "" };

/** P5.1: every org member can read — same read-access level as the Ship By notification settings above. */
export async function getBomAlertSettingsAction(): Promise<NotificationsActionResult<BomAlertSettings>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const { data } = await db.from("bom_alert_settings").select("enabled, warehouse_manager_email").eq("org_id", orgId).maybeSingle();
    if (!data) return { ok: true, data: DEFAULT_BOM_ALERT_SETTINGS };
    return { ok: true, data: { enabled: data.enabled, warehouseManagerEmail: data.warehouse_manager_email ?? "" } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Gated to org owners/admins — same reasoning as the Ship By notification settings above. */
export async function saveBomAlertSettingsAction(settings: BomAlertSettings): Promise<NotificationsActionResult<null>> {
  try {
    const { orgId } = await requireOrgAdmin();
    const db = createServiceRoleClient();
    const { error } = await db.from("bom_alert_settings").upsert(
      {
        org_id: orgId,
        enabled: settings.enabled,
        warehouse_manager_email: settings.warehouseManagerEmail || null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "org_id" }
    );
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
