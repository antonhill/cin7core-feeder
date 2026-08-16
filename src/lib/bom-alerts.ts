import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Cin7Credentials } from "@/cin7/types";
import { findBomSkus } from "@/cin7/products";
import { sendEmail } from "@/lib/email/resend";
import { cin7SaleUrl } from "@/cin7/web-url";
import { CIN7_API_ORIGIN } from "@/cin7/api-origin";

/**
 * P5.1 (LBL brief): called from syncSalesList (src/sync/sync-sales.ts)
 * right after it detects one or more sales transitioning INTO Cin7's
 * AUTHORISED order_status this sync run. Org-flagged off by default — a
 * no-op unless bom_alert_settings.enabled is true and a recipient is set.
 * Fails open per sale (one sale's failure — a bad SKU lookup, a Resend
 * outage — is logged and doesn't stop the rest of the batch or the sync
 * run itself, same "never let a notification problem affect the real
 * operation" reasoning as recordShipByChange).
 */
export async function processBomAlerts(
  db: SupabaseClient,
  orgId: string,
  instanceId: string,
  creds: Cin7Credentials,
  transitionedSaleIds: string[]
): Promise<void> {
  if (!transitionedSaleIds.length) return;

  try {
    const { data: settings } = await db
      .from("bom_alert_settings")
      .select("enabled, warehouse_manager_email")
      .eq("org_id", orgId)
      .maybeSingle();
    if (!settings?.enabled || !settings.warehouse_manager_email) return;

    for (const saleId of transitionedSaleIds) {
      await processOneSale(db, orgId, instanceId, creds, saleId, settings.warehouse_manager_email);
    }
  } catch (e) {
    console.error(`processBomAlerts failed (org ${orgId}, instance ${instanceId}):`, e instanceof Error ? e.message : e);
  }
}

async function processOneSale(
  db: SupabaseClient,
  orgId: string,
  instanceId: string,
  creds: Cin7Credentials,
  saleId: string,
  recipient: string
): Promise<void> {
  try {
    const { data: sale } = await db
      .from("sales")
      .select("order_number, customer_name, bom_alert_sent_at")
      .eq("org_id", orgId)
      .eq("instance_id", instanceId)
      .eq("cin7_sale_id", saleId)
      .maybeSingle();
    // Guards against re-alerting on the same authorisation across sync
    // runs — see migration 0067's own comment on why this isn't reset on a
    // later re-authorisation.
    if (sale?.bom_alert_sent_at) return;

    // Cached from this sale's last detail sync (src/sync/sync-sales.ts) —
    // a sale that's genuinely transitioning status (not brand new) almost
    // always already has these from an earlier cycle. No cached lines
    // means we can't check yet; skip rather than guess (documented
    // limitation — a sale that arrives ALREADY authorised on its very
    // first sync is the one case this can miss).
    const { data: lines } = await db
      .from("sale_order_lines")
      .select("product_sku")
      .eq("org_id", orgId)
      .eq("instance_id", instanceId)
      .eq("cin7_sale_id", saleId);
    const skus = [...new Set((lines ?? []).map((l) => l.product_sku as string | null).filter((sku): sku is string => Boolean(sku)))];
    if (!skus.length) return;

    const bomSkus = await findBomSkus(creds, skus);
    if (!bomSkus.length) return;

    const orderLabel = sale?.order_number ?? saleId;
    const deepLink = cin7SaleUrl(new URL(CIN7_API_ORIGIN).origin, saleId);
    const subject = `BOM alert: ${orderLabel} authorised with assembly product(s)`;
    const text = [
      `Order: ${orderLabel}`,
      `Customer: ${sale?.customer_name ?? "Unknown"}`,
      `Assembly/BOM product(s): ${bomSkus.join(", ")}`,
      `This order just entered Authorised status — assemble these before picking (Cin7's own Pick Available flow doesn't print BOM lines).`,
      `View in Cin7: ${deepLink}`,
    ].join("\n");

    const sendResult = await sendEmail({ to: [recipient], subject, text });

    const { error: insertError } = await db.from("bom_alert_notifications").insert({
      org_id: orgId,
      instance_id: instanceId,
      cin7_sale_id: saleId,
      bom_skus: bomSkus,
      recipient,
      sent_at: sendResult.ok ? new Date().toISOString() : null,
      provider_message_id: sendResult.messageId ?? null,
      error: sendResult.ok ? null : sendResult.error,
    });
    if (insertError) console.error(`bom_alert_notifications insert failed (sale ${saleId}):`, insertError.message);

    const { error: updateError } = await db
      .from("sales")
      .update({ bom_alert_sent_at: new Date().toISOString() })
      .eq("org_id", orgId)
      .eq("instance_id", instanceId)
      .eq("cin7_sale_id", saleId);
    if (updateError) console.error(`sales.bom_alert_sent_at update failed (sale ${saleId}):`, updateError.message);
  } catch (e) {
    console.error(`processBomAlerts failed for sale ${saleId}:`, e instanceof Error ? e.message : e);
  }
}
