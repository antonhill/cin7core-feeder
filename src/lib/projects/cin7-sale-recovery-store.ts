import "server-only";
// ADMINISTRATIVE RECOVERY ONLY: attach an Advanced Sale that already exists in Cin7 to a project when automatic creation could not finish
// (for example a creation whose outcome stayed uncertain). The normal workflow never reaches this: the Sale is created, read back, verified and
// linked automatically. Recovery is deliberately stricter than creation: it READS the Sale live (no Cin7 write) and links it only when the Sale
// is provably THIS project's Sale and matches the project's approved scope and commercial totals exactly. Anything else is refused, never guessed.
import type { createServiceRoleClient } from "@/supabase/server";
import { buildCreationPlan, externalIdFor, verifyCreatedSale, type SaleReadBack } from "./cin7-sale-creation";
import type { WriteGates, SaleLinkRow } from "./cin7-posting-store";
import { effectiveScope, scopeFromSnapshot } from "./product-scope";

type Db = ReturnType<typeof createServiceRoleClient>;
function fail(message: string): never { throw new Error(message); }
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RecoveryInput {
  orgId: string; projectId: string; instanceId: string; saleId: string;
  /** What the Sale is expected to carry; the live read must agree with every one of these. */
  customerName: string; location: string; cin7TaxRule: string; revenueAccount: string;
  /** Why automatic creation/linking could not complete. Mandatory; stored on the link and in the audit trail. */
  reason: string;
  now?: Date;
}

export async function recoverLinkExistingSale(
  db: Db, port: { readSale(saleId: string): Promise<SaleReadBack> }, gates: Pick<WriteGates, "orgEnabled" | "isManager">, email: string, input: RecoveryInput,
): Promise<SaleLinkRow> {
  if (!gates.orgEnabled) fail("Cin7 Sale recovery is not enabled for this organization.");
  if (!gates.isManager) fail("Only an organisation administrator can run Sale recovery.");
  const saleId = input.saleId.trim();
  if (!GUID.test(saleId)) fail("Enter the Cin7 SaleID (a GUID).");
  const reason = input.reason.trim();
  if (reason.length < 10) fail("Recovery needs a reason (at least a short sentence) explaining why the Sale was not created and linked automatically.");

  const p = await db.from("projects").select("id, status, project_reference, tax_rate_bps, original_contract_cents, billing_scope, baseline_snapshot").eq("org_id", input.orgId).eq("id", input.projectId).maybeSingle();
  if (p.error) fail(p.error.message);
  if (!p.data) fail("Project not found.");
  const project = p.data as { status: string; project_reference: string; tax_rate_bps: number; original_contract_cents: number; billing_scope?: string; baseline_snapshot?: unknown };
  if (project.status !== "ACTIVE") fail("Only an ACTIVE project can be linked to a Cin7 Sale.");
  const role = project.billing_scope === "VARIATION" ? "VARIATION" : "BASE";

  // existing links and creation intents (this project, and this Sale on any other project)
  const mine = await db.from("project_cin7_sale_links").select("id").eq("org_id", input.orgId).eq("project_id", input.projectId).maybeSingle();
  if (mine.error) fail(mine.error.message);
  if (mine.data) fail("This project is already linked to a Cin7 Sale. A link is permanent.");
  const taken = await db.from("project_cin7_sale_links").select("project_id").eq("org_id", input.orgId).eq("cin7_sale_id", saleId).maybeSingle();
  if (taken.error) fail(taken.error.message);
  if (taken.data) fail("That Cin7 Sale is already linked to a project. A Sale belongs to exactly one project; nothing was linked.");
  const intents = await db.from("project_cin7_sale_creations").select("project_id, creation_state, cin7_sale_id").eq("org_id", input.orgId);
  if (intents.error && !/does not exist|schema cache/i.test(intents.error.message)) fail(intents.error.message);
  const rows = (intents.data ?? []) as Array<{ project_id: string; creation_state: string; cin7_sale_id: string | null }>;
  if (rows.some((r) => r.cin7_sale_id === saleId && r.project_id !== input.projectId)) fail("That Cin7 Sale was created for a different project; it cannot be attached here.");
  const own = rows.find((r) => r.project_id === input.projectId);
  if (own && own.creation_state !== "FAILED_UNCERTAIN") fail(`This project has a Sale creation in state ${own.creation_state}. Recovery is only for an uncertain creation (or a project with no creation): use "Reconcile" or the controlled retry instead.`);
  if (own?.cin7_sale_id && own.cin7_sale_id !== saleId) fail("This project's creation recorded a different Cin7 Sale; refusing to attach another one.");

  // the expected Sale, built from the project's own approved scope and stages (the same builder as creation)
  const st = await db.from("project_stages").select("name, value_cents, sort_order").eq("org_id", input.orgId).eq("project_id", input.projectId);
  if (st.error) fail(st.error.message);
  const stages = ((st.data ?? []) as Array<{ name: string; value_cents: number; sort_order: number }>).sort((a, b) => a.sort_order - b.sort_order).map((s) => ({ name: s.name, valueCents: s.value_cents }));
  const scope = effectiveScope(scopeFromSnapshot(project.baseline_snapshot));
  if (scope.blockers.length) fail(`The project's product scope is not resolved, so the Sale's products cannot be verified: ${scope.blockers.join(" | ")}`);
  const built = buildCreationPlan({
    projectRef: project.project_reference, role, customerName: input.customerName, location: input.location, taxRule: input.cin7TaxRule, taxRateBps: project.tax_rate_bps,
    revenueAccount: input.revenueAccount, contractCents: project.original_contract_cents, stages, physicalLines: scope.lines.map((l) => ({ sku: l.sku, name: l.description, quantity: l.quantity })),
    saleOrderDate: (input.now ?? new Date()).toISOString().slice(0, 10),
  });
  if (!built.ok) fail(built.error);

  // LIVE, read-only: it must be this project's Sale (ExternalID), for this customer, with the planned products and totals
  const view = await port.readSale(saleId);
  if (view.id !== saleId) fail("Cin7 returned a different Sale than requested; nothing was linked.");
  if (view.externalId !== externalIdFor(project.project_reference)) fail(`That Sale's ExternalID is "${view.externalId ?? "missing"}", not this project's (${externalIdFor(project.project_reference)}). It belongs to something else; nothing was linked.`);
  const diffs = verifyCreatedSale(built.plan, view);
  if (diffs.length) fail(`The Cin7 Sale does not match this project, so it was NOT linked: ${diffs.join("; ")}.`);

  const now = (input.now ?? new Date()).toISOString();
  const ins = await db.from("project_cin7_sale_links").insert({
    org_id: input.orgId, project_id: input.projectId, instance_id: input.instanceId, cin7_sale_id: saleId, cin7_sale_number: null,
    link_status: "LINKED", tax_rule: built.plan.taxRule, revenue_account: built.plan.revenueAccount,
    sale_snapshot: { type: view.type, orderStatus: view.orderStatus, invoiceCount: view.invoiceCount, externalId: view.externalId, recovery: { reason, by: email, at: now, verifiedAgainstPlan: true } },
    linked_by_email: email, ...(role === "VARIATION" ? { sale_role: role } : {}),
  }).select("*").single();
  if (ins.error || !ins.data) fail(`link sale: ${ins.error?.message ?? "no row"}`);
  return ins.data as SaleLinkRow;
}
