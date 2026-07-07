"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllFinishedGoodsList, fetchFinishedGoodsDetail, type Cin7FinishedGoodsListEntry, type Cin7FinishedGoodsDetail } from "@/cin7/finished-goods";

export interface AssembliesActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

/** Pulls every assembly build live from the chosen instance — read-only, nothing is written. Filtering/searching happens client-side in page.tsx; there's no domain logic here worth a separate pure module (unlike Audit/Health's flagging rules). */
export async function listAssembliesAction(instanceId: string): Promise<AssembliesActionResult<Cin7FinishedGoodsListEntry[]>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);
    const assemblies = await fetchAllFinishedGoodsList(creds);
    return { ok: true, data: assemblies };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Components + actual consumption for one assembly, fetched only when its
 * row is expanded — an eager detail call per assembly on every scan would be
 * a real N+1 rate-limit cost across a large catalog, so this stays on-demand.
 */
export async function getAssemblyDetailAction(instanceId: string, taskId: string): Promise<AssembliesActionResult<Cin7FinishedGoodsDetail>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  if (!taskId) return { ok: false, error: "Missing assembly ID." };
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);
    const detail = await fetchFinishedGoodsDetail(creds, taskId);
    return { ok: true, data: detail };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
