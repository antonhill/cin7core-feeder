import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "@/cin7/crypto";
import type { Cin7Credentials } from "@/cin7/types";

/** Loads and decrypts one instance's Cin7 credentials, scoped to the org (defense against a stray cross-org instanceId). */
export async function loadCin7Credentials(
  db: SupabaseClient,
  orgId: string,
  instanceId: string
): Promise<Cin7Credentials & { name: string }> {
  const { data: instanceRow, error } = await db
    .from("cin7_instances")
    .select("name, account_id, application_key_encrypted, base_url, active")
    .eq("id", instanceId)
    .eq("org_id", orgId)
    .single();
  if (error || !instanceRow) throw new Error(error?.message ?? "Instance not found");
  if (!instanceRow.active) throw new Error("Instance is inactive");

  return {
    name: instanceRow.name,
    accountId: instanceRow.account_id,
    applicationKey: decrypt(instanceRow.application_key_encrypted),
    baseUrl: instanceRow.base_url,
  };
}
