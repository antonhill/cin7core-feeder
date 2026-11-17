import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "@/cin7/crypto";
import { credentialColumn, storedCiphertext } from "@/cin7/credential-store";
import { CIN7_API_ORIGIN } from "@/cin7/api-origin";
import type { Cin7Credentials } from "@/cin7/types";

/** Loads and decrypts one instance's Cin7 credentials, scoped to the org (defense against a stray cross-org instanceId). */
export async function loadCin7Credentials(
  db: SupabaseClient,
  orgId: string,
  instanceId: string
): Promise<Cin7Credentials & { name: string }> {
  const { data: instanceRow, error } = await db
    .from("cin7_instances")
    .select(`name, account_id, ${credentialColumn()}, active`)
    .eq("id", instanceId)
    .eq("org_id", orgId)
    .single();
  if (error || !instanceRow) throw new Error(error?.message ?? "Instance not found");
  if (!(instanceRow as unknown as { active: boolean }).active) throw new Error("Instance is inactive");
  const ciphertext = storedCiphertext(instanceRow);
  if (!ciphertext) throw new Error("Cin7 credentials are not configured for this environment");

  return {
    name: (instanceRow as unknown as { name: string }).name,
    accountId: (instanceRow as unknown as { account_id: string }).account_id,
    applicationKey: decrypt(ciphertext),
    // Always the canonical origin — the stored base_url is intentionally ignored (SSRF).
    baseUrl: CIN7_API_ORIGIN,
  };
}
