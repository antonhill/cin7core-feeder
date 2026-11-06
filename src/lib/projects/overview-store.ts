import "server-only";
// Projects - loader for the EXECUTIVE OVERVIEW. READ-ONLY and DATABASE-ONLY: it reuses the existing loaders (consolidated project, Sale links, the
// product register, the Toolbox delivery register and, for owners/admins only, the frozen cost estimate) and makes NO Cin7 call. Physical
// fulfilment from Cin7 is read separately, on request, through the existing physical-status action. Nothing is written anywhere.
import type { createServiceRoleClient } from "@/supabase/server";
import { loadSaleLink } from "./cin7-posting-store";
import { loadProjectScope } from "./scope-store";
import { loadProjectView } from "./project-store";
import { loadConsolidatedProject } from "./variation-billing-store";
import { loadProfitability, type BaseCostInput } from "./profitability-store";
import type { PhysicalPort } from "./physical-store";
import { redactVariationCosts } from "./variations";
import type { DeliverySummaryInput, OverviewEstimateInput, OverviewScopeInput } from "./overview-model";

type Db = ReturnType<typeof createServiceRoleClient>;

export interface OverviewData {
  scopes: OverviewScopeInput[];
  unbilledApprovedVariations: Array<{ code: string; amountCents: number }>;
  deliveries: DeliverySummaryInput | null;
  /** Owners/admins only; always null for anyone else (the frozen cost is not even loaded for them). */
  estimates: OverviewEstimateInput | null;
}

/** A port that can never reach Cin7: the profitability loader leaves every Cin7-derived figure unknown, and only its frozen estimates are used. */
const OFFLINE_PORT: PhysicalPort = {
  async readSale() { throw new Error("offline: the executive overview reads no Cin7 data here"); },
  async readStock() { throw new Error("offline"); },
  async readAssemblies() { throw new Error("offline"); },
};

const missingTable = (m: string) => /does not exist|schema cache/i.test(m);

async function loadDeliverySummary(db: Db, orgId: string, projectIds: string[]): Promise<DeliverySummaryInput | null> {
  const d = await db.from("project_deliveries").select("status, created_at").eq("org_id", orgId).in("project_id", projectIds);
  if (d.error) { if (missingTable(d.error.message)) return null; throw new Error(`load deliveries: ${d.error.message}`); }
  const rows = (d.data ?? []) as Array<{ status: string; created_at: string }>;
  const ev = await db.from("project_delivery_events").select("created_at").eq("org_id", orgId).in("project_id", projectIds).order("created_at", { ascending: false }).limit(1);
  if (ev.error && !missingTable(ev.error.message)) throw new Error(`load delivery events: ${ev.error.message}`);
  const stamps = [...rows.map((r) => r.created_at), ...(((ev.data ?? []) as Array<{ created_at: string }>).map((e) => e.created_at))].sort();
  return {
    total: rows.filter((r) => r.status !== "CANCELLED").length,
    dispatched: rows.filter((r) => r.status === "DISPATCHED").length,
    inProgress: rows.filter((r) => r.status === "PLANNED" || r.status === "LOADING").length,
    cancelled: rows.filter((r) => r.status === "CANCELLED").length,
    latestActivityAt: stamps.length ? stamps[stamps.length - 1] : null,
  };
}

/** `base` is the frozen cost knowledge the NewQuip layer supplies for the original scope; it is only used when `isAdmin`. Returns null when the project does not exist. */
export async function loadOverviewData(db: Db, input: { orgId: string; projectId: string; isAdmin: boolean; base: BaseCostInput }): Promise<OverviewData | null> {
  const { orgId, projectId, isAdmin } = input;
  const c = await loadConsolidatedProject(db, orgId, projectId);
  if (!c) return null;
  const scopes: OverviewScopeInput[] = [];
  for (const s of c.scopes) {
    const view = s.scope === "BASE" ? c.base : await loadProjectView(db, orgId, s.projectId);
    if (!view) throw new Error(`The ${s.scope === "BASE" ? "original" : "variation"} project scope could not be loaded.`);
    const link = await loadSaleLink(db, orgId, s.projectId);
    const register = await loadProjectScope(db, orgId, s.projectId);
    scopes.push({
      projectId: s.projectId, scope: s.scope, label: s.scope === "BASE" ? "Original contract" : `${s.variationCode} variation`, variationCode: s.variationCode,
      saleNumber: link?.cin7_sale_number ?? null,
      // Variation cost estimates are withheld from viewers who may not see cost (the same redaction the project screen applies).
      view: redactVariationCosts(view, isAdmin), scopeBlockers: register.effective.blockers,
    });
  }
  let estimates: OverviewEstimateInput | null = null;
  if (isAdmin) {
    const r = await loadProfitability(db, () => OFFLINE_PORT, { orgId, projectId, base: input.base });
    if (r) estimates = { revised: r.estimated.revised, incomplete: r.estimated.incomplete, uncostedSellingCents: r.estimated.uncostedSellingCents, exceptions: r.exceptions.map((e) => ({ code: e.code, scope: e.scope, message: e.message })) };
  }
  return {
    scopes,
    unbilledApprovedVariations: c.unbilledApprovedVariations.map((u) => ({ code: u.code, amountCents: u.amountCents })),
    deliveries: await loadDeliverySummary(db, orgId, scopes.map((s) => s.projectId)),
    estimates,
  };
}
