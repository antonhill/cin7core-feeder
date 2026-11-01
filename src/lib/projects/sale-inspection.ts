// TEMPORARY (UAT-027): the read-only inspection of ONE pinned Cin7 Sale. Remove with the diagnostic page once SO-00028 is understood.
// Pure and Cin7-free: it reduces a Sale read back from Cin7 to an ALLOWLISTED summary. Nothing outside the fields built here can reach the browser -
// no raw response, no attachment links, no addresses, no task ids, no tracking details, no credentials.

/** The ONLY target this diagnostic will read. Pinned in code on purpose: the server action takes no argument. */
export const INSPECTED_SALE = {
  orgId: "e1aea782-d095-47ad-90fb-4fa65c9bf855",
  instanceId: "30eac8f2-d55c-486c-be70-a5f2d778a761",
  saleId: "ab919729-36e5-44c4-ae7b-f7a4797e8b75",
  saleNumber: "SO-00028",
  externalId: "NEWQUIP-PROJECTS-SALE:PRJ-NQ-Q-0017-V001",
} as const;

const MAX_LINES = 50;

/** The fields read from a Sale. Structural on purpose (this Projects module imports nothing from src/cin7): the Cin7 Sale detail type satisfies it. */
interface PickPackIn { Status?: string; Lines?: Array<{ SKU?: string; Quantity?: number }> }
export interface InspectableSale {
  ID: string; Type?: string; Customer?: string; ExternalID?: string | null; TaxRule?: string;
  Order?: {
    Status?: string; TotalBeforeTax?: number; Tax?: number; Total?: number;
    Lines?: Array<{ SKU?: string; Quantity?: number; Price?: number }>;
    AdditionalCharges?: Array<{ Description?: string; Quantity?: number; Price?: number; Tax?: number; Total?: number }>;
  };
  Invoices?: Array<{ InvoiceNumber?: string; Status?: string }>;
  Fulfilments?: Array<{
    FulfillmentNumber?: number; FulFilmentStatus?: string; LinkedInvoiceNumber?: string; Pick?: PickPackIn; Pack?: PickPackIn;
    Ship?: { Status?: string; Lines?: Array<{ IsShipped?: boolean; ShipmentDate?: string }> };
  }>;
}

export interface InspectedStockLine { sku: string | null; quantity: number | null }
export interface InspectedFulfilment {
  number: number | null;
  status: string | null;
  linkedInvoice: string | null;
  pick: { status: string | null; lineCount: number; totalQuantity: number; lines: InspectedStockLine[] };
  pack: { status: string | null; lineCount: number; totalQuantity: number; lines: InspectedStockLine[] };
  ship: { status: string | null; lineCount: number; shippedLineCount: number; hasShipmentDate: boolean };
  /** True when no pick/pack/ship line carries any quantity, shipment date or shipped flag - a container with no physical activity. */
  looksEmpty: boolean;
}
export interface SaleInspection {
  saleId: string;
  type: string | null;
  customer: string | null;
  externalId: string | null;
  taxRule: string | null;
  orderStatus: string | null;
  orderProductLineCount: number;
  orderProductLines: Array<{ sku: string | null; quantity: number | null; priceExVat: number | null }>;
  additionalCharges: Array<{ description: string | null; quantity: number | null; priceExVat: number | null; vat: number | null; total: number | null }>;
  orderTotals: { exVat: number | null; vat: number | null; total: number | null };
  invoiceCount: number;
  invoices: Array<{ number: string | null; status: string | null }>;
  fulfilmentCount: number;
  fulfilments: InspectedFulfilment[];
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function pickPack(p: PickPackIn | undefined) {
  const lines = (p?.Lines ?? []).map((l) => ({ sku: str(l.SKU), quantity: num(l.Quantity) }));
  return { status: str(p?.Status), lineCount: lines.length, totalQuantity: lines.reduce((n, l) => n + (l.quantity ?? 0), 0), lines: lines.slice(0, MAX_LINES) };
}

export function inspectSale(s: InspectableSale): SaleInspection {
  const fulfilments: InspectedFulfilment[] = (s.Fulfilments ?? []).map((f) => {
    const pick = pickPack(f.Pick);
    const pack = pickPack(f.Pack);
    const shipLines = f.Ship?.Lines ?? [];
    const ship = {
      status: str(f.Ship?.Status), lineCount: shipLines.length,
      shippedLineCount: shipLines.filter((l) => l.IsShipped === true).length,
      hasShipmentDate: shipLines.some((l) => typeof l.ShipmentDate === "string" && l.ShipmentDate.trim() !== ""),
    };
    return {
      number: num(f.FulfillmentNumber), status: str(f.FulFilmentStatus), linkedInvoice: str(f.LinkedInvoiceNumber) || null, pick, pack, ship,
      looksEmpty: pick.totalQuantity === 0 && pack.totalQuantity === 0 && ship.shippedLineCount === 0 && !ship.hasShipmentDate,
    };
  });
  const lines = s.Order?.Lines ?? [];
  return {
    saleId: s.ID, type: str(s.Type), customer: str(s.Customer), externalId: str(s.ExternalID), taxRule: str(s.TaxRule), orderStatus: str(s.Order?.Status),
    orderProductLineCount: lines.length,
    orderProductLines: lines.slice(0, MAX_LINES).map((l) => ({ sku: str(l.SKU), quantity: num(l.Quantity), priceExVat: num(l.Price) })),
    additionalCharges: (s.Order?.AdditionalCharges ?? []).map((c) => ({ description: str(c.Description), quantity: num(c.Quantity), priceExVat: num(c.Price), vat: num(c.Tax), total: num(c.Total) })),
    orderTotals: { exVat: num(s.Order?.TotalBeforeTax), vat: num(s.Order?.Tax), total: num(s.Order?.Total) },
    invoiceCount: (s.Invoices ?? []).length,
    invoices: (s.Invoices ?? []).map((i) => ({ number: str(i.InvoiceNumber), status: str(i.Status) })),
    fulfilmentCount: fulfilments.length,
    fulfilments,
  };
}
