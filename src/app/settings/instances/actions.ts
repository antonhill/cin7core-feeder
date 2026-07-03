"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { encrypt, decrypt } from "@/cin7/crypto";
import { testConnection } from "@/cin7/client";
import { findProductWithBom, probeWorkCentrePaths } from "@/cin7/debug";
import { requireCurrentOrg } from "@/lib/current-org";

export interface InstanceRecord {
  id: string;
  name: string;
  accountId: string;
  baseUrl: string;
  active: boolean;
  keyLast4: string;
  createdAt: string;
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
  base_url: string;
  active: boolean;
  created_at: string;
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
    baseUrl: row.base_url,
    active: row.active,
    keyLast4,
    createdAt: row.created_at,
  };
}

export async function listInstances(): Promise<ActionResult> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const { data, error } = await db
      .from("cin7_instances")
      .select("id, name, account_id, application_key_encrypted, base_url, active, created_at")
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
  baseUrl: string;
  active: boolean;
}): Promise<ActionResult> {
  if (!params.name.trim()) return { ok: false, error: "Name is required." };
  if (!params.accountId.trim()) return { ok: false, error: "Account ID is required." };
  if (!params.instanceId && !params.applicationKey) {
    return { ok: false, error: "Application key is required for a new instance." };
  }

  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();

    if (params.instanceId) {
      const update: Record<string, unknown> = {
        name: params.name.trim(),
        account_id: params.accountId.trim(),
        base_url: params.baseUrl.trim(),
        active: params.active,
        updated_at: new Date().toISOString(),
      };
      if (params.applicationKey) update.application_key_encrypted = encrypt(params.applicationKey);

      const { error } = await db
        .from("cin7_instances")
        .update(update)
        .eq("id", params.instanceId)
        .eq("org_id", orgId);
      if (error) return { ok: false, error: error.message };
    } else {
      const { error } = await db.from("cin7_instances").insert({
        org_id: orgId,
        name: params.name.trim(),
        account_id: params.accountId.trim(),
        application_key_encrypted: encrypt(params.applicationKey!),
        base_url: params.baseUrl.trim() || "https://inventory.dearsystems.com/ExternalApi/v2",
        active: params.active,
      });
      if (error) return { ok: false, error: error.message };
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
  const { orgId } = await requireCurrentOrg();
  const db = createServiceRoleClient();
  const { data, error } = await db
    .from("cin7_instances")
    .select("account_id, application_key_encrypted, base_url")
    .eq("id", instanceId)
    .eq("org_id", orgId)
    .single();
  if (error || !data) throw new Error(error?.message ?? "Instance not found.");
  return {
    accountId: data.account_id,
    applicationKey: decrypt(data.application_key_encrypted),
    baseUrl: data.base_url,
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

/**
 * Diagnostic only: scans this instance for a product that already has a
 * Bill of Materials configured and returns its raw JSON, so we can see
 * Cin7's own authoritative field shape instead of guessing further.
 */
export async function debugFindBomExample(instanceId: string): Promise<TestConnectionResult> {
  try {
    const creds = await loadInstanceCreds(instanceId);
    const result = await findProductWithBom(creds);
    if (!result.found) return { ok: false, message: "No product with a configured BOM was found." };
    return { ok: true, message: JSON.stringify(result.product, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Diagnostic only: /production/workcenters keeps returning Cin7's branded
 * "Page not found" page despite two independent sources confirming that
 * path and the account genuinely having Work Centres configured. Tries
 * several plausible casing/path variants live and reports which succeed.
 */
export async function debugProbeWorkCentrePaths(instanceId: string): Promise<TestConnectionResult> {
  try {
    const creds = await loadInstanceCreds(instanceId);
    const results = await probeWorkCentrePaths(creds);
    const anySucceeded = results.some((r) => r.looksLikeJson);
    return { ok: anySucceeded, message: JSON.stringify(results, null, 2) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function deleteInstance(instanceId: string): Promise<ActionResult> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const { error } = await db.from("cin7_instances").delete().eq("id", instanceId).eq("org_id", orgId);
    if (error) return { ok: false, error: error.message };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }

  return listInstances();
}
