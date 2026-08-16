import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email/resend";
import { cin7SaleUrl } from "@/cin7/web-url";
import { CIN7_API_ORIGIN } from "@/cin7/api-origin";

export interface RecordShipByChangeInput {
  orgId: string;
  instanceId: string;
  cin7SaleId: string;
  oldShipBy: string | null;
  newShipBy: string;
  changedByEmail: string | null;
}

/**
 * Called right after a successful Toolbox-originated ShipBy write (drag or
 * Move-to, either calendar) — see updateOrderShipByAction/
 * updatePickingShipByAction. Org-flagged off by default: a no-op unless
 * ship_by_notification_settings.enabled is true for this org. Fails open —
 * a notification-recording problem must never affect the Cin7 write it's
 * reporting on, which has already succeeded by the time this runs (same
 * "never block the real operation" reasoning as logActivity).
 */
export async function recordShipByChange(db: SupabaseClient, input: RecordShipByChangeInput): Promise<void> {
  try {
    const { data: settings } = await db
      .from("ship_by_notification_settings")
      .select("enabled, debounce_minutes")
      .eq("org_id", input.orgId)
      .maybeSingle();
    if (!settings?.enabled) return;

    const { error } = await db.rpc("record_ship_by_change_pending", {
      p_org_id: input.orgId,
      p_instance_id: input.instanceId,
      p_cin7_sale_id: input.cin7SaleId,
      p_old_ship_by: input.oldShipBy,
      p_new_ship_by: input.newShipBy,
      p_changed_by_email: input.changedByEmail,
      p_debounce_minutes: settings.debounce_minutes,
    });
    if (error) console.error(`recordShipByChange rpc failed (sale ${input.cin7SaleId}):`, error.message);
  } catch (e) {
    console.error(`recordShipByChange failed (sale ${input.cin7SaleId}):`, e instanceof Error ? e.message : e);
  }
}

interface PendingRow {
  org_id: string;
  instance_id: string;
  cin7_sale_id: string;
  original_ship_by: string | null;
  latest_ship_by: string;
  changed_by_email: string | null;
}

export interface FlushShipByNotificationsResult {
  processed: number;
  sent: number;
  skippedNoRecipients: number;
  failed: number;
}

/**
 * Cron entry point (/api/notify-ship-by-changes) — processes every pending
 * row whose debounce window has elapsed (send_after <= now), one at a time.
 * A single row's failure (bad recipient data, Resend outage) is logged and
 * the row still gets cleared — Phase 1 has no retry queue; a stuck row
 * would otherwise sit blocking nothing, but would also never resolve on
 * its own. Revisit if the deliverability test surfaces real transient
 * failures worth retrying.
 */
export async function flushPendingShipByNotifications(db: SupabaseClient): Promise<FlushShipByNotificationsResult> {
  const result: FlushShipByNotificationsResult = { processed: 0, sent: 0, skippedNoRecipients: 0, failed: 0 };

  const { data: pending, error } = await db
    .from("ship_by_change_pending")
    .select("org_id, instance_id, cin7_sale_id, original_ship_by, latest_ship_by, changed_by_email")
    .lte("send_after", new Date().toISOString());
  if (error) throw new Error(`ship_by_change_pending select: ${error.message}`);

  for (const row of (pending ?? []) as PendingRow[]) {
    result.processed++;
    try {
      const outcome = await processOnePendingNotification(db, row);
      if (outcome === "sent") result.sent++;
      else if (outcome === "no_recipients") result.skippedNoRecipients++;
      else result.failed++;
    } catch (e) {
      result.failed++;
      console.error(`flushPendingShipByNotifications failed for sale ${row.cin7_sale_id}:`, e instanceof Error ? e.message : e);
    } finally {
      await db
        .from("ship_by_change_pending")
        .delete()
        .eq("org_id", row.org_id)
        .eq("instance_id", row.instance_id)
        .eq("cin7_sale_id", row.cin7_sale_id);
    }
  }

  return result;
}

async function processOnePendingNotification(db: SupabaseClient, row: PendingRow): Promise<"sent" | "no_recipients" | "failed"> {
  const [{ data: sale }, { data: instance }, { data: settings }] = await Promise.all([
    db
      .from("sales")
      .select("order_number, customer_name, sales_rep")
      .eq("org_id", row.org_id)
      .eq("instance_id", row.instance_id)
      .eq("cin7_sale_id", row.cin7_sale_id)
      .maybeSingle(),
    db.from("cin7_instances").select("name").eq("id", row.instance_id).maybeSingle(),
    db.from("ship_by_notification_settings").select("cc_emails").eq("org_id", row.org_id).maybeSingle(),
  ]);

  const ccEmails = ((settings?.cc_emails as string[] | null) ?? []).filter(Boolean);

  let repEmail: string | null = null;
  if (sale?.sales_rep) {
    const { data: mapping } = await db
      .from("ship_by_notification_reps")
      .select("email")
      .eq("org_id", row.org_id)
      .eq("rep_name", sale.sales_rep)
      .maybeSingle();
    repEmail = mapping?.email ?? null;
  }

  // Rep gets the primary `to`, CC list rides along as `cc` — unless the rep
  // never resolved (no mapping entry for this rep_name), in which case the
  // CC list becomes the `to` so a change with an unmapped rep still notifies
  // someone rather than silently going nowhere.
  const to = repEmail ? [repEmail] : ccEmails;
  const cc = repEmail ? ccEmails : undefined;
  const allRecipients = [...new Set([...to, ...(cc ?? [])])];

  if (allRecipients.length === 0) {
    await db.from("ship_by_change_notifications").insert({
      org_id: row.org_id,
      instance_id: row.instance_id,
      cin7_sale_id: row.cin7_sale_id,
      old_ship_by: row.original_ship_by,
      new_ship_by: row.latest_ship_by,
      changed_by_email: row.changed_by_email,
      recipients: [],
      sent_at: null,
    });
    return "no_recipients";
  }

  const orderLabel = sale?.order_number ?? row.cin7_sale_id;
  const deepLink = cin7SaleUrl(new URL(CIN7_API_ORIGIN).origin, row.cin7_sale_id);
  const subject = `Ship By changed: ${orderLabel}`;
  const text = [
    `Order: ${orderLabel}`,
    `Customer: ${sale?.customer_name ?? "Unknown"}`,
    `Ship By: ${row.original_ship_by ?? "(none)"} → ${row.latest_ship_by}`,
    `Changed by: ${row.changed_by_email ?? "Unknown"}`,
    `Instance: ${instance?.name ?? "Unknown"}`,
    `View in Cin7: ${deepLink}`,
  ].join("\n");

  const sendResult = await sendEmail({ to, cc, subject, text });

  await db.from("ship_by_change_notifications").insert({
    org_id: row.org_id,
    instance_id: row.instance_id,
    cin7_sale_id: row.cin7_sale_id,
    old_ship_by: row.original_ship_by,
    new_ship_by: row.latest_ship_by,
    changed_by_email: row.changed_by_email,
    recipients: allRecipients,
    sent_at: sendResult.ok ? new Date().toISOString() : null,
    provider_message_id: sendResult.messageId ?? null,
    error: sendResult.ok ? null : sendResult.error,
  });

  return sendResult.ok ? "sent" : "failed";
}
