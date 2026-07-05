"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import { pullInstanceData, type PullInstanceResult } from "@/migrate/pull-instance";

/**
 * Pulls every Product/Assembly BOM/Customer/Supplier live from the selected
 * source instance into the org's canonical tables. The org comes from the
 * logged-in session, not a client-supplied orgId, same as every other
 * "use server" action in this app.
 */
export async function pullInstanceDataAction(sourceInstanceId: string): Promise<PullInstanceResult> {
  if (!sourceInstanceId) return { ok: false, error: "Choose a source instance." };

  const { orgId } = await requireCurrentOrg();
  const db = createServiceRoleClient();
  return pullInstanceData(db, orgId, sourceInstanceId);
}
