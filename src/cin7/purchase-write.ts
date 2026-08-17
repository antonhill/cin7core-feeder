import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

export interface CreatePurchaseOrderLine {
  productId: string;
  sku: string;
  name: string;
  quantity: number;
  price: number;
  taxRule?: string;
}

export interface CreatePurchaseOrderInput {
  supplierName: string;
  supplierId: string;
  locationName: string;
  locationId: string;
  lines: CreatePurchaseOrderLine[];
}

export interface CreatePurchaseOrderResult {
  taskId: string;
  orderNumber: string;
  status: string;
  lineCount: number;
}

/**
 * Creates a real Purchase Order — confirmed live 2026-07-25 against Spark
 * Demo after 7 rounds of live trial-and-error (src/cin7/debug.ts's
 * testCreatePurchaseOrder). A genuine two-step process, not one call:
 *
 * 1. `POST /purchase` creates the bare header (Supplier/Location/Approach/
 *    Status). Line items sent on THIS call are silently ignored no matter
 *    what shape — confirmed dead end across a flat top-level `Lines` key
 *    and every `Order`/`Invoice`/`StockReceived`-nested variant, all
 *    returning a real 200 with the line array staying empty.
 * 2. `POST /purchase/order` is a genuinely separate sub-resource, keyed by
 *    the header's own `ID` passed back as `TaskID` (confirmed `PUT` on this
 *    path 405s — POST only). This is the only call that actually populates
 *    `Lines[]`.
 *
 * Always `Status: "DRAFT"` on both calls — same discipline as
 * createStockTransfer — a genuine but inert proposal a human still
 * authorizes in Cin7, never something this feature force-executes.
 */
export async function createPurchaseOrder(creds: Cin7Credentials, input: CreatePurchaseOrderInput): Promise<CreatePurchaseOrderResult> {
  // Security re-audit P0-2: both calls create real Cin7 records with no
  // client-supplied reference to reconcile against later, so a network
  // failure here must never trigger an automatic resend — see
  // Cin7RequestOptions.nonIdempotentCreate in cin7/http.ts.
  const header = await cin7Request<{ ID: string; OrderNumber: string; Status: string }>(creds, "/purchase", {
    method: "POST",
    nonIdempotentCreate: true,
    body: {
      Status: "DRAFT",
      Supplier: input.supplierName,
      SupplierID: input.supplierId,
      Location: input.locationName,
      LocationID: input.locationId,
      Approach: "Stock",
    },
  });

  const orderLines = await cin7Request<{ Lines?: unknown[] }>(creds, "/purchase/order", {
    method: "POST",
    nonIdempotentCreate: true,
    body: {
      TaskID: header.ID,
      CombineAdditionalCharges: false,
      Memo: "",
      Status: "DRAFT",
      Lines: input.lines.map((l) => ({
        ProductID: l.productId,
        SKU: l.sku,
        Name: l.name,
        Quantity: l.quantity,
        Price: l.price,
        Discount: 0,
        Tax: 0,
        ...(l.taxRule ? { TaxRule: l.taxRule } : {}),
        SupplierSKU: "",
        Comment: "",
        Total: Math.round(l.quantity * l.price * 100) / 100,
      })),
      AdditionalCharges: [],
    },
  });

  return {
    taskId: header.ID,
    orderNumber: header.OrderNumber,
    status: header.Status,
    lineCount: orderLines.Lines?.length ?? 0,
  };
}
