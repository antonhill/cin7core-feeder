"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { checkSecret } from "@/lib/check-secret";

export interface InstancePickerItem {
  id: string;
  name: string;
  active: boolean;
}

export interface ListInstancesForPickerResult {
  ok: boolean;
  error?: string;
  instances?: InstancePickerItem[];
}

/** Minimal instance list for an instance picker — no key/account details. Shared by the Import and Templates pages. */
export async function listInstancesForPicker(orgId: string, secret: string): Promise<ListInstancesForPickerResult> {
  const secretError = checkSecret(secret);
  if (secretError) return { ok: false, error: secretError };
  if (!orgId) return { ok: false, error: "Organization ID is required." };

  try {
    const db = createServiceRoleClient();
    const { data, error } = await db
      .from("cin7_instances")
      .select("id, name, active")
      .eq("org_id", orgId)
      .order("name");
    if (error) return { ok: false, error: error.message };
    return { ok: true, instances: data ?? [] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
