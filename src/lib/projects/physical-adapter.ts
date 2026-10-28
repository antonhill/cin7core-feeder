import "server-only";
// READ-ONLY Cin7 adapter for the physical view: GETs only (sale detail, availability, finished-goods list). No write verb exists here.
import type { createServiceRoleClient } from "@/supabase/server";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchSaleDetail } from "@/cin7/sales";
import { fetchAvailabilityForSku } from "@/cin7/sale-inspect";
import { fetchAllFinishedGoodsList } from "@/cin7/finished-goods";
import type { PhysicalPort } from "./physical-store";

type Db = ReturnType<typeof createServiceRoleClient>;
const n = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const cents = n;

export function buildPhysicalPort(db: Db, orgId: string, instanceId: string): PhysicalPort {
  const creds = () => loadCin7Credentials(db, orgId, instanceId);
  return {
    async readSale(saleId) {
      const s = await fetchSaleDetail(await creds(), saleId);
      return {
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
      const rows = await fetchAvailabilityForSku(await creds(), sku);
      if (rows.length === 0) return null;
      const sum = (f: (r: (typeof rows)[number]) => unknown) => rows.reduce<number | null>((acc, r) => { const v = n(f(r)); return acc === null || v === null ? null : acc + v; }, 0);
      return { onHand: sum((r) => r.OnHand), allocated: sum((r) => r.Allocated), available: sum((r) => r.Available) };
    },
    async readAssemblies() {
      return (await fetchAllFinishedGoodsList(await creds())).filter((a) => a.ProductCode).map((a) => ({ sku: a.ProductCode as string, status: a.Status ?? "UNKNOWN", quantity: cents(a.Quantity) }));
    },
  };
}
