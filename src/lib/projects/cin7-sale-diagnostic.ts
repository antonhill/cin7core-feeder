// TEMPORARY (PR #122 diagnosis of the "Simple Sale" link rejection) — remove once the result has been captured.
// Read-only: asks the injected Cin7 reader about two FIXED sales and returns five classification fields only. Never a full payload,
// never credentials or customer data. The Advanced Sale validation in cin7-posting-store.ts is deliberately untouched.

export const DIAGNOSTIC_SALES = [
  { label: "SO-00015", saleId: "4fe3d99c-241d-4404-8795-4c448842108b" },
  { label: "SO-00018", saleId: "d99db61e-2af5-497b-81b2-e5610c251056" },
] as const;

export interface SaleClassification {
  label: string;
  requestedSaleId: string;
  saleId: string | null;
  /** JSON-quoted so stray whitespace/case in Cin7's value is visible. */
  type: string;
  taxRule: string;
  orderStatus: string;
  saleOrderNumber: string;
  error?: string;
}

export interface DiagnosticAccess {
  orgEnabled: boolean;
  isManager: boolean;
}

export interface SaleReader {
  (saleId: string): Promise<{ id: string; type: string | null; taxRule: string | null; orderStatus: string | null; saleNumber: string | null }>;
}

const show = (v: string | null | undefined) => (v == null ? "(absent)" : JSON.stringify(v));

export async function classifyDiagnosticSales(access: DiagnosticAccess, readSale: SaleReader): Promise<SaleClassification[]> {
  if (!access.orgEnabled) throw new Error("Not available for this organization.");
  if (!access.isManager) throw new Error("Only an org owner or admin can run this diagnostic.");
  const out: SaleClassification[] = [];
  for (const s of DIAGNOSTIC_SALES) {
    try {
      const r = await readSale(s.saleId);
      out.push({ label: s.label, requestedSaleId: s.saleId, saleId: r.id ?? null, type: show(r.type), taxRule: show(r.taxRule), orderStatus: show(r.orderStatus), saleOrderNumber: show(r.saleNumber) });
    } catch (e) {
      out.push({ label: s.label, requestedSaleId: s.saleId, saleId: null, type: "(error)", taxRule: "(error)", orderStatus: "(error)", saleOrderNumber: "(error)", error: e instanceof Error ? e.message.slice(0, 200) : "Unexpected error" });
    }
  }
  return out;
}
