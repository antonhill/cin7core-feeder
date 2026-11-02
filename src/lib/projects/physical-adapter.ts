import "server-only";
// READ-ONLY Cin7 adapter for the physical view: GETs only (sale detail, availability, finished-goods list). No write verb exists here.
import type { createServiceRoleClient } from "@/supabase/server";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchSaleDetail } from "@/cin7/sales";
import { fetchAllProductAvailability, type Cin7ProductAvailabilityEntry } from "@/cin7/product-availability";
import { fetchAllFinishedGoodsList } from "@/cin7/finished-goods";
import type { PhysicalPort } from "./physical-store";

type Db = ReturnType<typeof createServiceRoleClient>;
const n = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Cost carried on the Sale's NON-VOIDED invoice lines: sum of Quantity x AverageCost (Cin7's own per-line COGS basis). This is NOT the same as the
 * header's recognised COGS: it is present as soon as an invoice line exists (even a DRAFT invoice), whereas recognised COGS appears only when Cin7
 * books it. Unknown (null) if any line has an unreadable quantity or a missing / zero AverageCost (Cin7 uses a literal 0 for "not configured").
 */
export function invoiceLineCost(invoices: Array<{ Status?: string; Lines?: Array<{ SKU?: string; Quantity?: number; AverageCost?: number }> }>): number | null {
  let total = 0;
  for (const inv of invoices) {
    if ((inv.Status ?? "").toUpperCase() === "VOIDED") continue;
    if (!inv.Lines) return null;
    for (const l of inv.Lines) {
      const q = n(l.Quantity); const c = n(l.AverageCost);
      if (q === null) return null;
      if (q === 0) continue;
      if (c === null || c <= 0) return null;
      total += q * c;
    }
  }
  return Math.round(total * 100);
}

/** Cost carried on non-voided invoice lines, per SKU (quantity and cents). Null if any line is unreadable or has no usable average cost (unknown, never zero). */
export function invoiceLineCostsBySku(invoices: Array<{ Status?: string; Lines?: Array<{ SKU?: string; Quantity?: number; AverageCost?: number }> }>): Record<string, { quantity: number; costCents: number }> | null {
  const out: Record<string, { quantity: number; costCents: number }> = {};
  for (const inv of invoices) {
    if ((inv.Status ?? "").toUpperCase() === "VOIDED") continue;
    if (!inv.Lines) return null;
    for (const l of inv.Lines) {
      const q = n(l.Quantity); const c = n(l.AverageCost);
      if (q === null) return null;
      if (q === 0) continue;
      if (!l.SKU || c === null || c <= 0) return null;
      const cur = out[l.SKU] ?? { quantity: 0, costCents: 0 };
      out[l.SKU] = { quantity: cur.quantity + q, costCents: cur.costCents + Math.round(q * c * 100) };
    }
  }
  return out;
}

export function buildPhysicalPort(db: Db, orgId: string, instanceId: string): PhysicalPort {
  const creds = () => loadCin7Credentials(db, orgId, instanceId);
  let stockIndex: Promise<Map<string, Cin7ProductAvailabilityEntry[]>> | undefined;
  return {
    async readSale(saleId) {
      const s = await fetchSaleDetail(await creds(), saleId);
      return {
        invoiceLineCostCents: invoiceLineCost(s.Invoices ?? []),
        invoiceLineCostsBySku: invoiceLineCostsBySku(s.Invoices ?? []),
        cogsCents: n(s.COGSAmount) === null ? null : Math.round((n(s.COGSAmount) as number) * 100),
        ordered: (s.Order?.Lines ?? []).filter((l) => l.SKU).map((l) => ({ sku: l.SKU as string, name: l.Name ?? "", quantity: n(l.Quantity) })),
        invoices: (s.Invoices ?? []).map((i) => ({
          invoiceNumber: i.InvoiceNumber ?? null, status: i.Status ?? null,
          lines: i.Lines ? i.Lines.map((l) => ({ sku: l.SKU ?? null, quantity: n(l.Quantity) })) : null,
        })),
        fulfilments: (s.Fulfilments ?? []).map((f) => ({
          number: n(f.FulfillmentNumber),
          packLines: (f.Pack?.Lines ?? []).map((l) => ({ sku: l.SKU ?? null, quantity: n(l.Quantity) })),
          // Shipped when the ship step is AUTHORISED or any ship line is marked shipped. UNVERIFIED semantics (contract C9).
          shipped: (f.Ship?.Status ?? "").toUpperCase() === "AUTHORISED" || (f.Ship?.Lines ?? []).some((l) => l.IsShipped === true),
        })),
      };
    },
    async readStock(sku) {
      // ONE paged scan of the availability list, shared by every SKU of this view. (Reading per SKU fell back to scanning up to 30 pages each when the
      // Sku filter is ignored - dozens of requests for a project with many products, which hit the rate limit and showed false "stock not read".)
      stockIndex ??= fetchAllProductAvailability(await creds()).then((all) => {
        const m = new Map<string, Cin7ProductAvailabilityEntry[]>();
        for (const r of all) m.set(r.SKU, [...(m.get(r.SKU) ?? []), r]);
        return m;
      });
      const rows = (await stockIndex).get(sku) ?? [];
      if (rows.length === 0) return null;
      const sum = (f: (r: (typeof rows)[number]) => unknown) => rows.reduce<number | null>((acc, r) => { const v = n(f(r)); return acc === null || v === null ? null : acc + v; }, 0);
      return { onHand: sum((r) => r.OnHand), allocated: sum((r) => r.Allocated), available: sum((r) => r.Available) };
    },
    async readAssemblies() {
      return (await fetchAllFinishedGoodsList(await creds())).filter((a) => a.ProductCode).map((a) => ({ sku: a.ProductCode as string, status: a.Status ?? "UNKNOWN", quantity: n(a.Quantity) }));
    },
  };
}
