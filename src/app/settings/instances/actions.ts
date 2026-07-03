"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { encrypt, decrypt } from "@/cin7/crypto";

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

function checkSecret(secret: string): string | null {
  const expected = process.env.SYNC_SHARED_SECRET;
  if (!expected) return "SYNC_SHARED_SECRET is not configured on the server.";
  if (secret !== expected) return "Incorrect passphrase.";
  return null;
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

export async function listInstances(orgId: string, secret: string): Promise<ActionResult> {
  const secretError = checkSecret(secret);
  if (secretError) return { ok: false, error: secretError };
  if (!orgId) return { ok: false, error: "Organization ID is required." };

  try {
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
  orgId: string;
  secret: string;
  instanceId?: string;
  name: string;
  accountId: string;
  applicationKey?: string;
  baseUrl: string;
  active: boolean;
}): Promise<ActionResult> {
  const secretError = checkSecret(params.secret);
  if (secretError) return { ok: false, error: secretError };
  if (!params.orgId) return { ok: false, error: "Organization ID is required." };
  if (!params.name.trim()) return { ok: false, error: "Name is required." };
  if (!params.accountId.trim()) return { ok: false, error: "Account ID is required." };
  if (!params.instanceId && !params.applicationKey) {
    return { ok: false, error: "Application key is required for a new instance." };
  }

  try {
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
        .eq("org_id", params.orgId);
      if (error) return { ok: false, error: error.message };
    } else {
      const { error } = await db.from("cin7_instances").insert({
        org_id: params.orgId,
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

  return listInstances(params.orgId, params.secret);
}

export async function deleteInstance(orgId: string, secret: string, instanceId: string): Promise<ActionResult> {
  const secretError = checkSecret(secret);
  if (secretError) return { ok: false, error: secretError };

  try {
    const db = createServiceRoleClient();
    const { error } = await db.from("cin7_instances").delete().eq("id", instanceId).eq("org_id", orgId);
    if (error) return { ok: false, error: error.message };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }

  return listInstances(orgId, secret);
}
