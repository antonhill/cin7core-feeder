// T0 proof inspector - PURE rules (no I/O). TEMPORARY: lives on the investigation branch and is removed after the proof.
// See docs/projects-poc/architecture-inventory-billing-costing.md section 19 and docs/projects-poc/t0-proof-runbook.md.
//
// Everything shown to the operator is an ALLOW-LIST projection of the Cin7 payload: sale and invoice numbers, statuses, SKUs,
// quantities, money, counts. No customer, address, contact, note or attachment data is ever copied out.

/** The only organisation and Cin7 instance the inspector will read (NewQuip POC trial). Hard-coded: no discovery, no parameter. */
export const T0_ORG_ID = "e1aea782-d095-47ad-90fb-4fa65c9bf855";
export const T0_INSTANCE_ID = "30eac8f2-d55c-486c-be70-a5f2d778a761";

export const T0_FIXTURE = {
  sku: "NQ2886",
  location: "MSTR",
  quantity: 2,
  /** Rands, ex VAT, per unit. */
  unitPrice: 500,
  taxRule: "Standard Rate Sales",
  /** Expected order totals, rands: 2 x 500 = 1,000; 15% = 150. */
  totals: { exVat: 1000, vat: 150, total: 1150 },
  /** Baseline observed in the Toolbox cache on 2026-10-27 (re-confirmed LIVE by the BEFORE reading). */
  baseline: { onHand: 1000, allocated: 0, available: 1000 },
} as const;

export const isGuid = (v: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, 80) : null);
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** Property NAMES only (no values): reveals the payload shape without exposing any data. */
const keyNames = (v: unknown): string[] => Object.keys(obj(v)).sort().slice(0, 80);

export interface AvailabilityView { location: string | null; onHand: number | null; allocated: number | null; available: number | null; onOrder: number | null; inTransit: number | null }
export interface SaleLineView { sku: string | null; quantity: number | null; price: number | null; tax: number | null; total: number | null; backorderQuantity: number | null }
export interface InvoiceView { invoiceNumber: string | null; status: string | null; exVat: number | null; vat: number | null; total: number | null; lineCount: number; chargeCount: number }
export interface FulfilmentView { number: number | null; status: string | null; pick: string | null; pack: string | null; ship: string | null; linkedInvoice: string | null }

export interface SaleView {
  saleId: string | null;
  saleOrderNumber: string | null;
  type: string | null;
  saleStatus: string | null;
  orderStatus: string | null;
  taxRule: string | null;
  location: string | null;
  orderExVat: number | null;
  orderVat: number | null;
  orderTotal: number | null;
  lines: SaleLineView[];
  additionalChargeCount: number;
  invoices: InvoiceView[];
  fulfilments: FulfilmentView[];
  combined: { invoice: string | null; picking: string | null; packing: string | null; shipping: string | null; payment: string | null; fulfilment: string | null };
  cogsAmount: number | null;
  inventoryMovementCount: number;
  transactionCount: number;
  topLevelKeys: string[];
  orderKeys: string[];
}

export function projectAvailability(rows: unknown[]): AvailabilityView[] {
  return rows.map((r) => {
    const o = obj(r);
    return { location: text(o.Location), onHand: num(o.OnHand), allocated: num(o.Allocated), available: num(o.Available), onOrder: num(o.OnOrder), inTransit: num(o.InTransit) };
  });
}

/** Allow-list projection of `GET /sale?ID=`. Unknown / absent fields become null (never 0, never NaN). */
export function projectSale(raw: unknown): SaleView {
  const s = obj(raw);
  const order = obj(s.Order);
  return {
    saleId: text(s.ID),
    saleOrderNumber: text(order.SaleOrderNumber) ?? text(s.SaleOrderNumber),
    type: text(s.Type),
    saleStatus: text(s.Status),
    orderStatus: text(order.Status),
    taxRule: text(s.TaxRule) ?? text(order.TaxRule),
    location: text(s.Location),
    orderExVat: num(order.TotalBeforeTax) ?? num(s.TotalBeforeTax),
    orderVat: num(order.Tax) ?? num(s.Tax),
    orderTotal: num(order.Total) ?? num(s.Total),
    lines: arr(order.Lines).map((l) => {
      const o = obj(l);
      return { sku: text(o.SKU), quantity: num(o.Quantity), price: num(o.Price), tax: num(o.Tax), total: num(o.Total), backorderQuantity: num(o.BackorderQuantity) };
    }),
    additionalChargeCount: arr(order.AdditionalCharges).length,
    invoices: arr(s.Invoices).map((i) => {
      const o = obj(i);
      return { invoiceNumber: text(o.InvoiceNumber), status: text(o.Status), exVat: num(o.TotalBeforeTax), vat: num(o.Tax), total: num(o.Total), lineCount: arr(o.Lines).length, chargeCount: arr(o.AdditionalCharges).length };
    }),
    fulfilments: arr(s.Fulfilments).map((f) => {
      const o = obj(f);
      return { number: num(o.FulfillmentNumber), status: text(o.FulFilmentStatus), pick: text(obj(o.Pick).Status), pack: text(obj(o.Pack).Status), ship: text(obj(o.Ship).Status), linkedInvoice: text(o.LinkedInvoiceNumber) };
    }),
    combined: {
      invoice: text(s.CombinedInvoiceStatus), picking: text(s.CombinedPickingStatus), packing: text(s.CombinedPackingStatus),
      shipping: text(s.CombinedShippingStatus), payment: text(s.CombinedPaymentStatus), fulfilment: text(s.FulFilmentStatus),
    },
    cogsAmount: num(s.COGSAmount),
    inventoryMovementCount: arr(s.InventoryMovements).length,
    transactionCount: arr(s.Transactions).length,
    topLevelKeys: keyNames(s),
    orderKeys: keyNames(order),
  };
}

export type CheckResult = "PASS" | "DEVIATION" | "NOT_READABLE";
export interface Check { id: string; label: string; expected: string; actual: string; result: CheckResult }

const eq = (a: number | null, b: number) => a !== null && Math.abs(a - b) < 0.005;
const show = (v: number | string | null) => (v === null ? "(not returned)" : String(v));

function check(id: string, label: string, expected: string, actual: number | string | null, ok: boolean | null): Check {
  return { id, label, expected, actual: show(actual), result: actual === null || ok === null ? "NOT_READABLE" : ok ? "PASS" : "DEVIATION" };
}

/** The availability row for the fixture SKU at the fixture location, if exactly one exists. */
export function fixtureRow(rows: AvailabilityView[]): AvailabilityView | null {
  const m = rows.filter((r) => r.location === T0_FIXTURE.location);
  return m.length === 1 ? m[0] : null;
}

/** BEFORE the Sale exists: the live stock must equal the recorded baseline, or the expectations below are not comparable. */
export function evaluateBefore(rows: AvailabilityView[]): Check[] {
  const r = fixtureRow(rows);
  const b = T0_FIXTURE.baseline;
  return [
    check("B1", `${T0_FIXTURE.sku} has one ${T0_FIXTURE.location} row`, "1 row", rows.filter((x) => x.location === T0_FIXTURE.location).length, rows.filter((x) => x.location === T0_FIXTURE.location).length === 1),
    check("B2", "on hand (live)", String(b.onHand), r?.onHand ?? null, r ? eq(r.onHand, b.onHand) : null),
    check("B3", "allocated (live)", String(b.allocated), r?.allocated ?? null, r ? eq(r.allocated, b.allocated) : null),
    check("B4", "available (live)", String(b.available), r?.available ?? null, r ? eq(r.available, b.available) : null),
  ];
}

/** AFTER the Sale is created AND authorised: compares the live Sale + stock with the T0 hypotheses. A deviation is a FINDING, not an error. */
export function evaluateAfter(sale: SaleView, rows: AvailabilityView[]): Check[] {
  const f = T0_FIXTURE;
  const r = fixtureRow(rows);
  const line = sale.lines.length === 1 ? sale.lines[0] : null;
  return [
    check("A1", "sale type", "Advanced Sale", sale.type, sale.type === null ? null : sale.type === "Advanced Sale"),
    check("A2", "order status", "AUTHORISED", sale.orderStatus, sale.orderStatus === null ? null : sale.orderStatus === "AUTHORISED"),
    check("A3", "product lines", `1 line: ${f.sku} x ${f.quantity} @ ${f.unitPrice}`, line ? `${line.sku} x ${line.quantity} @ ${line.price}` : `${sale.lines.length} line(s)`, line ? line.sku === f.sku && eq(line.quantity, f.quantity) && eq(line.price, f.unitPrice) : false),
    check("A4", "tax rule", f.taxRule, sale.taxRule, sale.taxRule === null ? null : sale.taxRule === f.taxRule),
    check("A5", "order ex VAT / VAT / total", `${f.totals.exVat} / ${f.totals.vat} / ${f.totals.total}`, sale.orderExVat === null || sale.orderVat === null || sale.orderTotal === null ? null : `${sale.orderExVat} / ${sale.orderVat} / ${sale.orderTotal}`, sale.orderExVat === null || sale.orderVat === null || sale.orderTotal === null ? null : eq(sale.orderExVat, f.totals.exVat) && eq(sale.orderVat, f.totals.vat) && eq(sale.orderTotal, f.totals.total)),
    check("A6", "invoices", "0", sale.invoices.length, sale.invoices.length === 0),
    check("A7", "fulfilments", "0", sale.fulfilments.length, sale.fulfilments.length === 0),
    check("A8", "COGS amount", "0", sale.cogsAmount, sale.cogsAmount === null ? null : eq(sale.cogsAmount, 0)),
    check("A9", "inventory movements", "0", sale.inventoryMovementCount, sale.inventoryMovementCount === 0),
    check("A10", "stock on hand (unchanged)", String(f.baseline.onHand), r?.onHand ?? null, r ? eq(r.onHand, f.baseline.onHand) : null),
    check("A11", "stock allocated", String(f.baseline.allocated + f.quantity), r?.allocated ?? null, r ? eq(r.allocated, f.baseline.allocated + f.quantity) : null),
    check("A12", "stock available", String(f.baseline.available - f.quantity), r?.available ?? null, r ? eq(r.available, f.baseline.available - f.quantity) : null),
  ];
}

export interface T0Access { orgId: string; isManager: boolean }
export class T0AccessError extends Error {}

/** Every gate, evaluated BEFORE any Cin7 call. Throws T0AccessError (the page turns it into a 404). */
export function assertT0Access(a: T0Access): void {
  if (a.orgId !== T0_ORG_ID) throw new T0AccessError("not available");
  if (!a.isManager) throw new T0AccessError("not available");
}

export interface T0Deps {
  readAvailability(sku: string): Promise<unknown[]>;
  readSale(saleId: string): Promise<unknown>;
}
export interface T0Report {
  mode: "BEFORE" | "AFTER";
  generatedAt: string;
  availability: AvailabilityView[];
  sale: SaleView | null;
  checks: Check[];
  verdict: string;
  error?: string;
}

/** Orchestration. Read-only by construction: the only dependencies are two reads. */
export async function buildT0Report(access: T0Access, saleIdParam: string | null, deps: T0Deps, now: Date = new Date()): Promise<T0Report> {
  assertT0Access(access);
  const availability = projectAvailability(await deps.readAvailability(T0_FIXTURE.sku));
  if (saleIdParam === null) {
    const checks = evaluateBefore(availability);
    return { mode: "BEFORE", generatedAt: now.toISOString(), availability, sale: null, checks, verdict: verdictOf(checks) };
  }
  if (!isGuid(saleIdParam)) {
    return { mode: "AFTER", generatedAt: now.toISOString(), availability, sale: null, checks: [], verdict: "NOT RUN", error: "The sale parameter is not a valid SaleID (GUID)." };
  }
  const sale = projectSale(await deps.readSale(saleIdParam));
  const checks = evaluateAfter(sale, availability);
  return { mode: "AFTER", generatedAt: now.toISOString(), availability, sale, checks, verdict: verdictOf(checks) };
}

function verdictOf(checks: Check[]): string {
  if (checks.some((c) => c.result === "DEVIATION")) return "DEVIATION: record every deviating row as a finding";
  if (checks.some((c) => c.result === "NOT_READABLE")) return "INCOMPLETE: some values were not returned; use the screenshots";
  return "ALL EXPECTED";
}
