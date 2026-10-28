import "server-only";
// The NewQuip side of project profitability: the estimated cost FROZEN in the project's accepted quote baseline (migration 0102 makes that
// baseline immutable). Projects itself knows nothing about quotes; this is the only place the two meet for costs. Read-only.
import type { createServiceRoleClient } from "@/supabase/server";
import type { AcceptedBaseline } from "@/newquip/quote/baseline";
import type { BaseCostInput } from "@/lib/projects/profitability-store";

type Db = ReturnType<typeof createServiceRoleClient>;

export function baseCostFromBaseline(baseline: Pick<AcceptedBaseline, "internalMargin"> | null | undefined): BaseCostInput {
  const sheet = baseline?.internalMargin;
  if (!sheet) return { estimatedCostCents: null, uncostedSellingCents: 0 };
  // An incomplete sheet (any costed line without a cost) has no project cost: a partial total is never used as the estimate.
  return { estimatedCostCents: sheet.project.incomplete ? null : sheet.project.costCents, uncostedSellingCents: sheet.project.uncostedChargesCents };
}

export async function loadBaseCost(db: Db, orgId: string, projectId: string): Promise<BaseCostInput> {
  const q = await db.from("newquip_quotes").select("accepted_baseline").eq("org_id", orgId).eq("project_id", projectId).maybeSingle();
  if (q.error) {
    if (/does not exist|schema cache/i.test(q.error.message)) return { estimatedCostCents: null, uncostedSellingCents: 0 };
    throw new Error(`load frozen estimate: ${q.error.message}`);
  }
  return baseCostFromBaseline((q.data as { accepted_baseline: AcceptedBaseline | null } | null)?.accepted_baseline);
}
