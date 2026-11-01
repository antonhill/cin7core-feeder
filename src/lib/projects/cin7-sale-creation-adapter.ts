import "server-only";
// The ONE place the Sale-creation flow touches the Cin7 API. Implements the store's `SaleCreationPort`. Credentials are loaded for the
// org's own instance, never leave the server and are never logged. Whether to call is decided by cin7-sale-creation-store.ts.
import type { createServiceRoleClient } from "@/supabase/server";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchSaleDetail } from "@/cin7/sales";
import { findBomSkus } from "@/cin7/products";
import { fetchCustomerDefaults } from "@/cin7/customers";
import { fetchAllProductAvailability, type Cin7ProductAvailabilityEntry } from "@/cin7/product-availability";
import { createAdvancedSale, customerExists, findSaleByExternalIdForCustomer, resolveProductIds } from "@/cin7/sale-order-write";
import type { SaleCreationPort } from "./cin7-sale-creation-store";
import { readBackFulfilments } from "./cin7-fulfilment-readback";

type Db = ReturnType<typeof createServiceRoleClient>;
const cents = (n: unknown): number | null => {
  if (n === null || n === undefined || n === "") return null;
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) : null;
};

export function buildSaleCreationPort(db: Db, orgId: string, instanceId: string): SaleCreationPort {
  const creds = () => loadCin7Credentials(db, orgId, instanceId);
  // One shared paged availability scan for every SKU asked about (per-SKU reads could cost dozens of requests each when the Sku filter is ignored).
  let stockIndex: Promise<Map<string, Cin7ProductAvailabilityEntry[]>> | undefined;
  return {
    async customerExists(name) { return customerExists(await creds(), name); },
    async resolveProducts(skus) { return resolveProductIds(await creds(), skus); },
    async createSale(req) {
      return createAdvancedSale(
        await creds(),
        { customer: req.header.customer, location: req.header.location, saleOrderDate: req.header.saleOrderDate, taxRule: req.header.taxRule, externalId: req.header.externalId },
        req.lines, req.charges,
      );
    },
    async assemblySkus(skus) { return findBomSkus(await creds(), skus); },
    async customerDefaults(name) {
      const d = await fetchCustomerDefaults(await creds(), name);
      // exact (case-sensitive) name only: a case-insensitive match from Cin7 is treated as 'not the customer asked for'
      return d && d.name === name ? { taxRule: d.taxRule, revenueAccount: d.revenueAccount, location: d.location } : null;
    },
    async stockAt(sku) {
      stockIndex ??= fetchAllProductAvailability(await creds()).then((all) => {
        const m = new Map<string, Cin7ProductAvailabilityEntry[]>();
        for (const r of all) m.set(r.SKU, [...(m.get(r.SKU) ?? []), r]);
        return m;
      });
      const rows = (await stockIndex).get(sku) ?? [];
      return rows.map((r) => ({ location: r.Location ?? null, available: Number.isFinite(Number(r.Available)) && r.Available !== undefined ? Number(r.Available) : null }));
    },
    async readSale(saleId) {
      const s = await fetchSaleDetail(await creds(), saleId);
      const fulfilments = readBackFulfilments(s.Fulfilments);
      return {
        id: s.ID, type: s.Type ?? null, orderStatus: s.Order?.Status ?? null, customer: s.Customer ?? null, externalId: s.ExternalID ?? null, taxRule: s.TaxRule ?? null,
        lines: (s.Order?.Lines ?? []).map((l) => ({ sku: l.SKU ?? null, quantity: l.Quantity === undefined || !Number.isFinite(Number(l.Quantity)) ? null : Number(l.Quantity), priceCents: cents(l.Price) })),
        charges: (s.Order?.AdditionalCharges ?? []).map((c) => ({ description: c.Description ?? null, priceCents: cents(c.Total ?? c.Price), taxCents: cents(c.Tax) })),
        invoiceCount: (s.Invoices ?? []).length, fulfilmentCount: fulfilments.length, fulfilments,
      };
    },
    async findByExternalId(customer, externalId, sinceIso) { return findSaleByExternalIdForCustomer(await creds(), customer, externalId, sinceIso); },
  };
}
