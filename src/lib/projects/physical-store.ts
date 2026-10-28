import "server-only";
// Projects - read-only PHYSICAL visibility of a project's linked Sale. Imports nothing from src/cin7; reads only through the injected port.
// Writes NOTHING to Cin7 and NOTHING to Supabase.
import type { createServiceRoleClient } from "@/supabase/server";
import { buildPhysicalStatus, type AssemblyView, type FulfilmentView, type InvoiceView, type OrderedLine, type StockView } from "./physical-status";
import { loadSaleLink } from "./cin7-posting-store";
import { effectiveScope, scopeFromSnapshot } from "./product-scope";

type Db = ReturnType<typeof createServiceRoleClient>;

export interface PhysicalPort {
  /** One GET of the Sale, projected to what the physical view needs. */
  readSale(saleId: string): Promise<{ ordered: OrderedLine[]; invoices: InvoiceView[]; fulfilments: FulfilmentView[]; /** Cost of goods Cin7 has recognised on the Sale so far, cents; null when unreadable. */ cogsCents: number | null; /** Quantity x AverageCost over the non-voided invoice lines, cents; null when unreadable/unknown. Absent on test doubles. */ invoiceLineCostCents?: number | null }>;
  /** One bounded read per SKU. */
  readStock(sku: string): Promise<StockView | null>;
  /** The account's assembly (finished goods) records; read-only. */
  readAssemblies(): Promise<AssemblyView[]>;
}

export async function loadPhysicalStatus(db: Db, port: PhysicalPort, input: { orgId: string; projectId: string }) {
  const p = await db.from("projects").select("baseline_snapshot").eq("org_id", input.orgId).eq("id", input.projectId).maybeSingle();
  if (p.error) throw new Error(p.error.message);
  const eff = effectiveScope(scopeFromSnapshot((p.data as { baseline_snapshot?: unknown } | null)?.baseline_snapshot));
  const scope = eff.lines.map((l) => ({ sku: l.sku, description: l.description, quantity: l.quantity }));
  const link = await loadSaleLink(db, input.orgId, input.projectId);
  if (!link) {
    // No Sale yet: the approved scope is still the register (quoted known; everything from Cin7 unknown, never zero).
    const st = buildPhysicalStatus({ ordered: [], invoices: [], fulfilments: [], stock: {}, assemblies: [], scope, saleLinked: false });
    return { linked: false as const, saleNumber: null, cogsCents: null, scopeBlockers: eff.blockers, ...st };
  }
  const sale = await port.readSale(link.cin7_sale_id);
  const stock: Record<string, StockView | undefined> = {};
  for (const o of [...sale.ordered.map((x) => x.sku), ...scope.map((x) => x.sku)]) {
    if (stock[o]) continue;
    try { const s = await port.readStock(o); if (s) stock[o] = s; } catch { /* left unread: surfaced as a STOCK_NOT_READ exception */ }
  }
  let assemblies: AssemblyView[] = [];
  try { assemblies = await port.readAssemblies(); } catch { /* assembly visibility is best effort; rows show "no assembly records" rather than guessing */ }
  return { linked: true as const, saleNumber: link.cin7_sale_number, cogsCents: sale.cogsCents, scopeBlockers: eff.blockers, ...buildPhysicalStatus({ ordered: sale.ordered, invoices: sale.invoices, fulfilments: sale.fulfilments, stock, assemblies, scope, saleLinked: true }) };
}
