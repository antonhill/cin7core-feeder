"use server";

// NewQuip: READ-ONLY Cin7 supplier data for the Estimator's cost entry. INTERNAL (supplier prices): the same authority as the pricing workspace - NewQuip organisation, module access, cost visibility, and never
// in Demo Mode. Nothing here writes to Cin7 or to the quotation. Only async functions and erased types are exported.
import { createServiceRoleClient } from "@/supabase/server";
import { NEWQUIP_POC_CIN7_INSTANCE_ID } from "@/newquip/access";
import { formatCost7 } from "@/newquip/pricing/estimator";
import { costToE7 } from "@/newquip/pricing/estimator/supplier-identity";
import { listCin7Suppliers, readProductSuppliers } from "@/lib/projects/latest-cost-adapter";
import { loadQuote } from "@/lib/newquip-quotes/quote-store";
import { authoriseActor, errText } from "./actor";

export interface SupplierActionResult<T> { ok: boolean; error?: string; data?: T }
/** One supplier Cin7 already lists for the product (the likely choices). `cost` is Cin7's latest price as exact decimal text; `lastSupplied` is Cin7's date or null when Cin7 holds none. */
export interface SkuSupplierRecord {
  supplierId: string; supplierName: string; cost: string | null;
  /** false when the supplier is inactive in Cin7 (it cannot be chosen). */
  active: boolean;
  /** The supplier's OWN currency from its Cin7 supplier record: the authoritative currency a cost from this supplier is entered in. null when Cin7 holds none (the marked exception then applies). */
  currency: string | null; currencySource: "cin7_supplier" | null;
  /** The currency Cin7 states on this product's price record from this supplier, when it states one: information (and a consistency check for a Cin7 historical cost), never the source of the currency. */
  productCurrency: string | null;
  lastSupplied: string | null;
}
export interface SkuCostContext {
  sku: string; found: boolean; productName: string | null;
  /** Cin7's AverageCost, shown as an UNDATED reference only: it is never offered as a supplier cost and never given a date. */
  averageCostUndated: string | null;
  suppliers: SkuSupplierRecord[]; retrievedAt: string;
}
export interface SupplierHit { supplierId: string; name: string; currency: string | null }
export interface SupplierSearchResult { hits: SupplierHit[]; total: number; truncated: boolean }

const MSG = "Cin7 supplier data is not available right now. Nothing was changed.";
async function costActor() {
  let a: Awaited<ReturnType<typeof authoriseActor>>;
  try { a = await authoriseActor(); } catch (e) { throw new Refusal(errText(e)); } // our own permission refusals are shown as written
  if (a.demo) throw new Refusal("Supplier pricing is not available in Demo Mode.");
  if (!a.canSeeCost) throw new Refusal("Supplier costs are internal: only an Estimator or Manager can see them.");
  return a;
}
/** Our own plain-language refusals (permission, demo mode) are shown as written; a malformed request and any Cin7 or network failure get one safe message (no internals). */
class Refusal extends Error {}
const failText = (e: unknown): string => (e instanceof TypeError ? "The request was not valid." : e instanceof Refusal ? e.message : MSG);
const asText = (n: number): string => formatCost7(costToE7(n));

/** What Cin7 already holds for one product: its supplier records (price, currency, last-supplied date) and the undated average cost. The Estimator sees this BEFORE entering anything. */
export async function getSkuCostContextAction(quoteId: string, sku: string): Promise<SupplierActionResult<SkuCostContext>> {
  try {
    if (typeof quoteId !== "string" || quoteId.length === 0 || quoteId.length > 64 || typeof sku !== "string" || !/^[A-Za-z0-9._\-/ ]{1,64}$/.test(sku)) throw new TypeError("bad request");
    const a = await costActor();
    const db = createServiceRoleClient();
    if (!(await loadQuote(db, a.orgId, quoteId))) throw new Refusal("That quotation could not be found.");
    const [read, directory] = await Promise.all([readProductSuppliers(db, a.orgId, NEWQUIP_POC_CIN7_INSTANCE_ID, sku), listCin7Suppliers(db, a.orgId, NEWQUIP_POC_CIN7_INSTANCE_ID)]); // the supplier catalogue is essential: if it cannot be read the whole call fails (no currency is ever guessed)
    const byId = new Map(directory.map((s) => [s.id, s]));
    const suppliers: SkuSupplierRecord[] = read.suppliers.map((r) => {
      const master = byId.get(r.supplierId)?.currency ?? null;
      return { supplierId: r.supplierId, supplierName: byId.get(r.supplierId)?.name ?? r.supplierName, active: byId.get(r.supplierId)?.active ?? false, cost: r.cost == null ? null : asText(r.cost), currency: master, currencySource: master ? "cin7_supplier" : null, productCurrency: r.currency, lastSupplied: r.lastSupplied };
    });
    return { ok: true, data: { sku, found: read.found, productName: read.productName, averageCostUndated: read.averageCost != null && read.averageCost > 0 ? asText(read.averageCost) : null, suppliers, retrievedAt: new Date().toISOString() } };
  } catch (e) { return { ok: false, error: failText(e) }; }
}

/** A name search over the ACTIVE suppliers in the org's Cin7 instance, each with its Cin7 id and currency. At least two characters; at most 25 shown (the total says how many matched). */
export async function searchCin7SuppliersAction(quoteId: string, query: string): Promise<SupplierActionResult<SupplierSearchResult>> {
  try {
    if (typeof quoteId !== "string" || quoteId.length === 0 || quoteId.length > 64 || typeof query !== "string" || query.length > 80) throw new TypeError("bad request");
    const a = await costActor();
    if (!(await loadQuote(createServiceRoleClient(), a.orgId, quoteId))) throw new Refusal("That quotation could not be found.");
    const q = query.trim().toLowerCase();
    if (q.length < 2) return { ok: true, data: { hits: [], total: 0, truncated: false } };
    const all = await listCin7Suppliers(createServiceRoleClient(), a.orgId, NEWQUIP_POC_CIN7_INSTANCE_ID);
    const matches = all.filter((s) => s.active && s.name.toLowerCase().includes(q)).sort((x, y) => Number(y.name.toLowerCase().startsWith(q)) - Number(x.name.toLowerCase().startsWith(q)) || x.name.localeCompare(y.name));
    return { ok: true, data: { hits: matches.slice(0, 25).map((s) => ({ supplierId: s.id, name: s.name, currency: s.currency })), total: matches.length, truncated: matches.length > 25 } };
  } catch (e) { return { ok: false, error: failText(e) }; }
}
