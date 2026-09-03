"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { encrypt, decrypt } from "@/cin7/crypto";
import { testConnection } from "@/cin7/client";
import { CIN7_API_ORIGIN } from "@/cin7/api-origin";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requirePrivilegedOrgAdmin } from "@/lib/require-privileged";
import { getBillingStatus } from "@/lib/billing";
import { logActivity, type ActivityActor } from "@/lib/activity-log";

export interface InstanceRecord {
  id: string;
  name: string;
  accountId: string;
  active: boolean;
  keyLast4: string;
  createdAt: string;
  /** P5.3 (LBL brief): orders with an effective date (ship_by, falling back to order_date) before this hide from Pick Today / Ship Today / the Shipping Calendar — null means no floor, the default. Per-instance, not per-org: different instances can be at different points in their own history cleanup. */
  fulfilmentViewStartDate: string | null;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
  instances?: InstanceRecord[];
}

async function toRecord(row: {
  id: string;
  name: string;
  account_id: string;
  application_key_encrypted: string;
  active: boolean;
  created_at: string;
  fulfilment_view_start_date: string | null;
}): Promise<InstanceRecord> {
  let keyLast4 = "????";
  try {
    const plain = decrypt(row.application_key_encrypted);
    keyLast4 = plain.slice(-4);
  } catch {
    keyLast4 = "????"; // ENCRYPTION_KEY mismatch or corrupt row — never surface the raw error to the UI
  }
  return {
    id: row.id,
    name: row.name,
    accountId: row.account_id,
    active: row.active,
    keyLast4,
    createdAt: row.created_at,
    fulfilmentViewStartDate: row.fulfilment_view_start_date,
  };
}

/**
 * Security re-audit closure, Blocker 3: shared logging point for every real
 * write from the diagnostic/credential surface (Cin7 credential CRUD, and
 * the 4 debug* actions that make genuine Cin7 writes) — every one of these
 * was previously entirely unlogged, leaving zero forensic trail for a
 * compromised or malicious super-admin session's writes into a customer's
 * live Cin7 account, or for who changed/rotated a customer's own Cin7
 * credentials. Deliberately never called from the 27 read-only debug*
 * actions — logging a read doesn't inflate coverage, it just adds noise.
 */
async function logPrivilegedWrite(params: {
  orgId: string;
  instanceId?: string | null;
  actor: ActivityActor;
  action: string;
  outcome: "success" | "failed" | "ambiguous";
  summary: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const db = createServiceRoleClient();
  await logActivity(db, {
    orgId: params.orgId,
    instanceId: params.instanceId,
    actor: params.actor,
    action: params.action,
    summary: params.summary,
    // Security re-audit closure, Blocker 3: never log the Cin7 Application
    // Key, a decrypted credential, or any other secret — `detail` here is
    // always caller-supplied, non-credential metadata (order numbers, SKUs,
    // row counts, outcome classification), never the raw request/response
    // body of a credential-bearing call.
    detail: { outcome: params.outcome, ...params.detail },
  });
}

export async function listInstances(): Promise<ActionResult> {
  try {
    // Instance config carries Account IDs + key metadata — owner/admin only.
    // Security re-audit round 3, item 1 (P1-2): AAL2 required too — credential metadata.
    const { orgId } = await requirePrivilegedOrgAdmin("view Cin7 instance configuration");
    const db = createServiceRoleClient();
    // Security re-audit P0-1: base_url deliberately not selected — nothing
    // in this file needs it anymore, and it stays out of the InstanceRecord
    // handed to the client.
    const { data, error } = await db
      .from("cin7_instances")
      .select("id, name, account_id, application_key_encrypted, active, created_at, fulfilment_view_start_date")
      .eq("org_id", orgId)
      .order("created_at");
    if (error) return { ok: false, error: error.message };

    return { ok: true, instances: await Promise.all((data ?? []).map(toRecord)) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function upsertInstance(params: {
  instanceId?: string;
  name: string;
  accountId: string;
  applicationKey?: string;
  active: boolean;
  /** "" clears the floor (no restriction); omitted on create defaults to no floor. */
  fulfilmentViewStartDate?: string;
}): Promise<ActionResult> {
  if (!params.name.trim()) return { ok: false, error: "Name is required." };
  if (!params.accountId.trim()) return { ok: false, error: "Account ID is required." };
  if (!params.instanceId && !params.applicationKey) {
    return { ok: false, error: "Application key is required for a new instance." };
  }

  try {
    // Create / update / replace-key — owner/admin only.
    // Security re-audit round 3, item 1 (P1-2): AAL2 required too — writes credentials.
    const { orgId, userId, email } = await requirePrivilegedOrgAdmin("manage Cin7 instances");
    const db = createServiceRoleClient();
    const actor: ActivityActor = { userId, email };

    if (params.instanceId) {
      // Security re-audit P0-1: base_url is intentionally never written here
      // anymore — see the insert branch's comment below.
      const update: Record<string, unknown> = {
        name: params.name.trim(),
        account_id: params.accountId.trim(),
        active: params.active,
        fulfilment_view_start_date: params.fulfilmentViewStartDate?.trim() || null,
        updated_at: new Date().toISOString(),
      };
      if (params.applicationKey) update.application_key_encrypted = encrypt(params.applicationKey);

      const { error } = await db
        .from("cin7_instances")
        .update(update)
        .eq("id", params.instanceId)
        .eq("org_id", orgId);
      if (error) {
        await logPrivilegedWrite({
          orgId,
          instanceId: params.instanceId,
          actor,
          action: "instance.update",
          outcome: "failed",
          summary: `Failed to update Cin7 instance "${params.name.trim()}"`,
          detail: { error: error.message },
        });
        return { ok: false, error: error.message };
      }
      // Security re-audit closure, Blocker 3: never log the Application Key
      // itself — only whether this update rotated it.
      await logPrivilegedWrite({
        orgId,
        instanceId: params.instanceId,
        actor,
        action: "instance.update",
        outcome: "success",
        summary: `Updated Cin7 instance "${params.name.trim()}"${params.applicationKey ? " (rotated Application Key)" : ""}`,
        detail: { name: params.name.trim(), accountId: params.accountId.trim(), active: params.active, rotatedKey: Boolean(params.applicationKey) },
      });
    } else {
      const [{ count }, billing] = await Promise.all([
        db.from("cin7_instances").select("id", { count: "exact", head: true }).eq("org_id", orgId),
        getBillingStatus(orgId),
      ]);
      if ((count ?? 0) >= billing.maxInstances) {
        return {
          ok: false,
          error:
            billing.maxInstances === 1
              ? "Your trial allows 1 connected instance — subscribe to connect another."
              : `Your plan allows ${billing.maxInstances} connected instances.`,
        };
      }

      const { data: inserted, error } = await db
        .from("cin7_instances")
        .insert({
          org_id: orgId,
          name: params.name.trim(),
          account_id: params.accountId.trim(),
          application_key_encrypted: encrypt(params.applicationKey!),
          // Security re-audit P0-1: base_url used to be a free-text field an
          // org admin could edit — every credential-bearing call ignores it
          // regardless (see cin7/api-origin.ts's CIN7_API_ORIGIN), so an
          // editable value was pure attack surface with no real effect.
          // Always the canonical origin now; there is no UI to change it.
          base_url: CIN7_API_ORIGIN,
          active: params.active,
        })
        .select("id")
        .single();
      if (error) {
        await logPrivilegedWrite({
          orgId,
          actor,
          action: "instance.create",
          outcome: "failed",
          summary: `Failed to create Cin7 instance "${params.name.trim()}"`,
          detail: { error: error.message },
        });
        return { ok: false, error: error.message };
      }
      await logPrivilegedWrite({
        orgId,
        instanceId: inserted?.id,
        actor,
        action: "instance.create",
        outcome: "success",
        summary: `Created Cin7 instance "${params.name.trim()}"`,
        detail: { name: params.name.trim(), accountId: params.accountId.trim(), active: params.active },
      });
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }

  return listInstances();
}

export interface TestConnectionResult {
  ok: boolean;
  message: string;
}

async function loadInstanceCreds(instanceId: string) {
  // Chokepoint for every diagnostic below: loading decrypted creds + running live Cin7
  // calls is owner/admin only. testInstanceConnection and all debug* actions go through here.
  //
  // Security re-audit P0-1: this used to select+return the DB-stored, user-editable
  // base_url and hand it straight to raw-fetch diagnostic helpers (cin7/client.ts,
  // cin7/debug.ts) — a stored base_url could redirect these credential-bearing
  // calls off Cin7 entirely. Mirrors loadCin7Credentials' (cin7/load-credentials.ts)
  // already-safe pattern: never select base_url at all, always hand back the
  // canonical, hardcoded origin.
  const { orgId } = await requireOrgAdmin("run Cin7 instance diagnostics");
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("cin7_instances")
    .select("account_id, application_key_encrypted")
    .eq("id", instanceId)
    .eq("org_id", orgId)
    .single();
  if (error || !data) throw new Error(error?.message ?? "Instance not found.");
  return {
    accountId: data.account_id,
    applicationKey: decrypt(data.application_key_encrypted),
    baseUrl: CIN7_API_ORIGIN,
  };
}

export async function testInstanceConnection(instanceId: string): Promise<TestConnectionResult> {
  try {
    const creds = await loadInstanceCreds(instanceId);
    const result = await testConnection(creds);
    return { ok: result.ok, message: `[${result.status || "network"}] ${result.message}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function deleteInstance(instanceId: string): Promise<ActionResult> {
  try {
    // Security re-audit round 3, item 1 (P1-2): AAL2 required too — deletes credentials.
    const { orgId, userId, email } = await requirePrivilegedOrgAdmin("delete Cin7 instances");
    const db = createServiceRoleClient();
    const actor: ActivityActor = { userId, email };
    const { error } = await db.from("cin7_instances").delete().eq("id", instanceId).eq("org_id", orgId);
    if (error) {
      await logPrivilegedWrite({
        orgId,
        instanceId,
        actor,
        action: "instance.delete",
        outcome: "failed",
        summary: `Failed to delete Cin7 instance ${instanceId}`,
        detail: { error: error.message },
      });
      return { ok: false, error: error.message };
    }
    await logPrivilegedWrite({
      orgId,
      instanceId,
      actor,
      action: "instance.delete",
      outcome: "success",
      summary: `Deleted Cin7 instance ${instanceId}`,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }

  return listInstances();
}
