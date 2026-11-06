import "server-only";
// Prepares the proposed progress invoice for an APPROVED claim: READ-ONLY (one Cin7 GET and Supabase reads). Writes nothing anywhere.
import type { createServiceRoleClient } from "@/supabase/server";
import { loadSaleLink, reservedByOthers, type Cin7Port } from "./cin7-posting-store";
import { proposeInvoice, type InvoiceProposal } from "./invoice-proposal";
import { loadDeliveryEligibility } from "./delivery-allocation-store";
import { effectiveScope, scopeFromSnapshot } from "./product-scope";

type Db = ReturnType<typeof createServiceRoleClient>;
function fail(message: string): never { throw new Error(message); }

export interface PreparedInvoice { claimNumber: string; saleNumber: string | null; proposal: InvoiceProposal; scopeBlockers: string[]; preparedAt: string }

export async function prepareInvoiceProposal(db: Db, port: Pick<Cin7Port, "fetchSale">, input: { orgId: string; projectId: string; claimId: string; deliveryId?: string; now?: Date }): Promise<PreparedInvoice> {
  const link = await loadSaleLink(db, input.orgId, input.projectId);
  if (!link) fail("This project has no linked Cin7 Sale. Link or create one first.");
  const c = await db.from("project_claims").select("id, claim_number, status").eq("org_id", input.orgId).eq("project_id", input.projectId).eq("id", input.claimId).maybeSingle();
  if (c.error) fail(c.error.message);
  if (!c.data) fail("Claim not found in this project.");
  const claim = c.data as { claim_number: string; status: string };
  if (claim.status !== "APPROVED") fail(`Only an APPROVED claim can be prepared for invoicing (this one is ${claim.status}).`);
  const ls = await db.from("project_claim_lines").select("stage_name, current_claim_cents, tax_cents, stage_id").eq("org_id", input.orgId).eq("claim_id", input.claimId);
  if (ls.error) fail(ls.error.message);
  const claimLines = ((ls.data ?? []) as Array<{ stage_name: string; current_claim_cents: number; tax_cents: number; stage_id: string }>).sort((a, b) => a.stage_id.localeCompare(b.stage_id)).map((l) => ({ stageName: l.stage_name, amountCents: l.current_claim_cents, taxCents: l.tax_cents }));
  const p = await db.from("projects").select("baseline_snapshot").eq("org_id", input.orgId).eq("id", input.projectId).maybeSingle();
  if (p.error) fail(p.error.message);
  const scope = effectiveScope(scopeFromSnapshot((p.data as { baseline_snapshot?: unknown } | null)?.baseline_snapshot));

  const view = await port.fetchSale(link.cin7_sale_id);
  const orderLines = view.orderLines ?? [];
  const proposal = proposeInvoice({
    claimLines,
    orderLines: orderLines.map((o) => ({ sku: o.sku, description: o.name, ordered: Number.isFinite(o.quantity) ? o.quantity : null })),
    invoices: view.invoices.map((i) => ({ status: i.status, lines: i.lines ? i.lines.map((l) => ({ sku: l.sku, quantity: l.quantity })) : null })),
    shipped: Object.fromEntries(orderLines.map((o) => [o.sku, view.shipped ? view.shipped[o.sku] : null])),
    reserved: await reservedByOthers(db, input.orgId, link.id, input.claimId),
    scopeSkus: scope.lines.map((l) => l.sku),
    allocated: input.deliveryId ? (await loadDeliveryEligibility(db, input.orgId, input.projectId, input.deliveryId)).allocated : undefined,
  });
  return { claimNumber: claim.claim_number, saleNumber: link.cin7_sale_number, proposal, scopeBlockers: scope.blockers, preparedAt: (input.now ?? new Date()).toISOString() };
}
