import { fireEvent, screen } from "@testing-library/react";
import { vi } from "vitest";

// Shared fakes for tests that render the supplier-cost editor: the Cin7 supplier actions are replaced by a small fixed catalogue (the real actions have their own tests), and `identity` chooses a supplier and a kind
// of cost the way the Estimator does.
export const CATALOGUE = [
  { supplierId: "CUR-ZAR", supplierName: "Cin7 Supplier ZAR", currency: "ZAR" as string | null },
  { supplierId: "CUR-USD", supplierName: "Cin7 Supplier USD", currency: "USD" as string | null },
  { supplierId: "CUR-EUR", supplierName: "Cin7 Supplier EUR", currency: "EUR" as string | null },
  { supplierId: "NOCUR", supplierName: "No Currency Co", currency: null as string | null },
];
export const supplierActionsMock = () => ({
  getSkuCostContextAction: vi.fn(async (_q: string, sku: string) => ({ ok: true, data: { sku, found: true, productName: null, averageCostUndated: null, retrievedAt: "2026-11-17T08:00:00Z",
    suppliers: CATALOGUE.map((c) => ({ supplierId: c.supplierId, supplierName: c.supplierName, cost: null, currency: c.currency, currencySource: c.currency ? "cin7_product_supplier" : null, lastSupplied: null })) } })),
  searchCin7SuppliersAction: vi.fn(async (_q: string, query: string) => ({ ok: true, data: { hits: CATALOGUE.filter((c) => c.supplierName.toLowerCase().includes(query.toLowerCase())).map((c) => ({ supplierId: c.supplierId, name: c.supplierName, currency: c.currency })), total: 1, truncated: false } })),
});
/** Choose the Cin7 supplier that holds `currency`, and "Manually estimated cost" (needs no date), as the Estimator would. */
export async function identity(currency = "ZAR", kind = "manual_estimate"): Promise<void> {
  fireEvent.click(await screen.findByTestId(`cin7-record-CUR-${currency}`));
  fireEvent.click(screen.getByTestId(`kind-${kind}`));
}
