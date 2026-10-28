import "server-only";
// The ONE place the Projects module touches the Cin7 API. Implements the store's `Cin7Port` with: a read (GET /sale) and the
// progress-invoice create. Loaded with the org's own instance credentials (scoped by org; they never leave the server and are never
// logged). Everything about WHETHER to call is decided by cin7-posting-store.ts before this is reached.
import type { createServiceRoleClient } from "@/supabase/server";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchSaleDetail } from "@/cin7/sales";
import { createSaleProgressInvoice } from "@/cin7/sale-invoice-write";
import type { Cin7Port, Cin7SaleView } from "./cin7-posting-store";

type Db = ReturnType<typeof createServiceRoleClient>;

/** Cin7 money (rands) -> integer cents, or null when it is missing / not a finite number. Missing is NEVER zero. */
const cents = (n: unknown): number | null => {
  if (n === null || n === undefined || n === "") return null;
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) : null;
};

export function buildCin7Port(db: Db, orgId: string, instanceId: string): Cin7Port {
  const creds = () => loadCin7Credentials(db, orgId, instanceId);
  return {
    async fetchSale(saleId): Promise<Cin7SaleView> {
      const s = await fetchSaleDetail(await creds(), saleId);
      return {
        id: s.ID,
        saleNumber: s.Order?.SaleOrderNumber ?? null,
        type: s.Type ?? null,
        orderStatus: s.Order?.Status ?? null,
        taxRule: s.TaxRule ?? null,
        invoices: (s.Invoices ?? []).map((i) => ({
          invoiceNumber: i.InvoiceNumber ?? null, taskId: i.TaskID ?? null, memo: i.Memo ?? null, status: i.Status ?? null,
          subtotalCents: cents(i.TotalBeforeTax), taxCents: cents(i.Tax), totalCents: cents(i.Total),
          lines: (i.Lines ?? []).map((l) => ({ sku: l.SKU ?? null, quantity: Number.isFinite(Number(l.Quantity)) && l.Quantity !== undefined ? Number(l.Quantity) : null, priceCents: cents(l.Price) })),
        })),
        // Shipped = packed on a fulfilment whose Ship step is AUTHORISED or has a line marked shipped (semantics UNVERIFIED: contract C9). null = a quantity was unreadable.
        shipped: (() => {
          const out: Record<string, number | null> = {};
          for (const f of s.Fulfilments ?? []) {
            const shipped = (f.Ship?.Status ?? "").toUpperCase() === "AUTHORISED" || (f.Ship?.Lines ?? []).some((l) => l.IsShipped === true);
            if (!shipped) continue;
            for (const l of f.Pack?.Lines ?? []) {
              if (!l.SKU) continue;
              const q = l.Quantity === undefined || !Number.isFinite(Number(l.Quantity)) ? null : Number(l.Quantity);
              out[l.SKU] = q === null || out[l.SKU] === null ? null : (out[l.SKU] ?? 0) + q;
            }
          }
          return out;
        })(),
        orderLines: (s.Order?.Lines ?? []).map((l) => ({ productId: l.ProductID ?? "", sku: l.SKU ?? "", name: l.Name ?? "", quantity: Number(l.Quantity) })),
      };
    },
    async createInvoice(req) {
      return createSaleProgressInvoice(await creds(), req);
    },
  };
}

/** The org's single active Cin7 instance. Ambiguity (0 or >1) fails closed rather than picking one. */
export async function singleActiveInstanceId(db: Db, orgId: string): Promise<string> {
  const r = await db.from("cin7_instances").select("id").eq("org_id", orgId).eq("active", true);
  if (r.error) throw new Error(r.error.message);
  const rows = (r.data ?? []) as { id: string }[];
  if (rows.length !== 1) throw new Error(rows.length === 0 ? "This organization has no active Cin7 instance." : "This organization has several Cin7 instances; linking needs a single active one.");
  return rows[0].id;
}
