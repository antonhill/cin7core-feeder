// Projects - PHYSICAL lifecycle of a project's Cin7 Sale, derived READ-ONLY from what Cin7 holds. Pure and Cin7-free (the store injects a
// port). Cin7 is the source of truth for stock, assembly and shipping; this module only joins and labels what it reads. It never derives
// physical completion from commercial progress, never invents a quantity (unknown = null, never 0) and creates no inventory transaction.

export interface OrderedLine { sku: string; name: string; quantity: number | null }
export interface InvoicedLine { sku: string | null; quantity: number | null }
export interface InvoiceView { invoiceNumber: string | null; status: string | null; lines: InvoicedLine[] | null }
export interface PackedLine { sku: string | null; quantity: number | null }
export interface FulfilmentView { number: number | null; packLines: PackedLine[]; shipped: boolean }
export interface StockView { onHand: number | null; allocated: number | null; available: number | null }
export interface AssemblyView { sku: string; status: string; quantity: number | null }

export interface PhysicalInputs {
  ordered: OrderedLine[];
  invoices: InvoiceView[];
  fulfilments: FulfilmentView[];
  /** Per SKU; undefined = not read, null fields = unreadable. */
  stock: Record<string, StockView | undefined>;
  assemblies: AssemblyView[];
  /** The approved product scope (one entry per SKU, quantities already summed). Optional for callers that only know the Sale. */
  scope?: Array<{ sku: string; description: string; quantity: number }>;
  /** Whether a Cin7 Sale is linked. When false, 'ordered' is unknown (null) rather than 0. Default true. */
  saleLinked?: boolean;
}

export interface PhysicalRow {
  sku: string;
  name: string;
  /** Approved scope quantity (the quotation / variation). Null when the SKU is not in the approved scope (for example a manually linked Sale). */
  quoted: number | null;
  /** Approved project requirement on the Sale order. */
  ordered: number | null;
  /** Physical units represented on non-voided invoices (at R0). Independent of shipping. */
  invoiced: number | null;
  /** Packed on fulfilments that have been shipped. */
  shipped: number | null;
  /** ordered - shipped. */
  remaining: number | null;
  /** ordered - non-voided invoiced (null when either is unknown). */
  remainingToInvoice: number | null;
  /** Alias of `remaining`: ordered - shipped. */
  remainingToDeliver: number | null;
  /** Cin7 stock - ACCOUNT-WIDE for the SKU, not attributable to this Sale. */
  onHand: number | null;
  allocatedAllOrders: number | null;
  available: number | null;
  /** Shortfall against free stock: max(0, remaining - available). An ESTIMATE of what must be assembled or bought. */
  shortfall: number | null;
  /** Assembly records for this SKU, account-wide (Cin7 does not link a build to a Sale in the list view). */
  assemblyInProgress: number | null;
  assemblyCompleted: number | null;
  hasAssemblyRecords: boolean;
}

export type PhysicalExceptionCode = "NOT_ON_ORDER" | "QUANTITY_DIFFERS_FROM_SCOPE" | "OVER_INVOICED" | "OVER_SHIPPED" | "UNREADABLE_QUANTITY" | "STOCK_NOT_READ" | "UNORDERED_SKU_ACTIVITY";
export interface PhysicalException { code: PhysicalExceptionCode; sku: string; message: string }

const num = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** Sums a list; any unreadable member makes the whole sum unknown (null), never a partial total. */
const sumKnown = (xs: Array<number | null>): number | null => (xs.some((x) => x === null) ? null : xs.reduce<number>((n, x) => n + (x as number), 0));
const voided = (s: string | null) => (s ?? "").toUpperCase() === "VOIDED";
const ASSEMBLY_ACTIVE = new Set(["DRAFT", "AUTHORISED", "IN PROGRESS"]);

export function buildPhysicalStatus(i: PhysicalInputs): { rows: PhysicalRow[]; exceptions: PhysicalException[]; asOf: string } {
  const exceptions: PhysicalException[] = [];
  const linked = i.saleLinked !== false;
  const scopeBySku = new Map((i.scope ?? []).map((x) => [x.sku, x]));
  // rows: everything on the Sale order, then approved-scope SKUs that are not on it (ordered = 0 once a Sale exists, unknown before)
  const base: OrderedLine[] = [
    ...i.ordered,
    ...(i.scope ?? []).filter((x) => !i.ordered.some((o) => o.sku === x.sku)).map((x): OrderedLine => ({ sku: x.sku, name: x.description, quantity: linked ? 0 : null })),
  ];
  const skus = base.map((o) => o.sku);
  const orderedSkus = new Set(skus);
  const rows = base.map((o): PhysicalRow => {
    const ordered = num(o.quantity);
    const quoted = scopeBySku.has(o.sku) ? scopeBySku.get(o.sku)!.quantity : null;
    // invoiced: a non-voided invoice with unreadable lines makes the figure unknown rather than zero
    const invParts: Array<number | null> = [];
    for (const inv of i.invoices.filter((x) => !voided(x.status))) {
      if (inv.lines === null) { invParts.push(null); continue; }
      for (const l of inv.lines.filter((x) => x.sku === o.sku)) invParts.push(num(l.quantity));
    }
    const invoiced = sumKnown(invParts);
    const shipParts: Array<number | null> = [];
    for (const f of i.fulfilments.filter((x) => x.shipped)) for (const l of f.packLines.filter((x) => x.sku === o.sku)) shipParts.push(num(l.quantity));
    const shipped = sumKnown(shipParts);
    const remaining = ordered !== null && shipped !== null ? ordered - shipped : null;
    const st = i.stock[o.sku];
    const available = st ? num(st.available) : null;
    const asm = i.assemblies.filter((a) => a.sku === o.sku);
    const inProg = sumKnown(asm.filter((a) => ASSEMBLY_ACTIVE.has(a.status.toUpperCase())).map((a) => num(a.quantity)));
    const done = sumKnown(asm.filter((a) => a.status.toUpperCase() === "COMPLETED").map((a) => num(a.quantity)));

    // (Before a Sale exists "ordered" is simply not applicable - not an unreadable value - so no warning.)
    if (ordered === null && linked) exceptions.push({ code: "UNREADABLE_QUANTITY", sku: o.sku, message: `The ordered quantity of ${o.sku} is unreadable.` });
    if (ordered !== null && invoiced !== null && invoiced > ordered + 1e-9) exceptions.push({ code: "OVER_INVOICED", sku: o.sku, message: `${o.sku}: ${invoiced} invoiced against ${ordered} ordered.` });
    if (ordered !== null && shipped !== null && shipped > ordered + 1e-9) exceptions.push({ code: "OVER_SHIPPED", sku: o.sku, message: `${o.sku}: ${shipped} shipped against ${ordered} ordered.` });
    if (linked && scopeBySku.has(o.sku) && !i.ordered.some((x) => x.sku === o.sku)) exceptions.push({ code: "NOT_ON_ORDER", sku: o.sku, message: `${o.sku} is in the approved scope but not on the Cin7 Sale order.` });
    if (linked && quoted !== null && ordered !== null && i.ordered.some((x) => x.sku === o.sku) && Math.abs(quoted - ordered) > 1e-9) exceptions.push({ code: "QUANTITY_DIFFERS_FROM_SCOPE", sku: o.sku, message: `${o.sku}: ${ordered} on the Sale vs ${quoted} in the approved scope.` });
    // Before a Sale exists nothing is read from Cin7 at all, so "stock was not read" would be a misleading warning: it is only raised once a Sale is linked.
    if (!st && linked) exceptions.push({ code: "STOCK_NOT_READ", sku: o.sku, message: `Stock for ${o.sku} was not read from Cin7.` });
    return {
      sku: o.sku, name: o.name, quoted, ordered, invoiced, shipped, remaining, remainingToDeliver: remaining,
      remainingToInvoice: ordered !== null && invoiced !== null ? ordered - invoiced : null,
      onHand: st ? num(st.onHand) : null, allocatedAllOrders: st ? num(st.allocated) : null, available,
      shortfall: remaining !== null && available !== null ? Math.max(0, remaining - available) : null,
      assemblyInProgress: asm.length ? inProg : null, assemblyCompleted: asm.length ? done : null, hasAssemblyRecords: asm.length > 0,
    };
  });
  // Activity on a SKU that is not on the order is never silently ignored.
  const stray = new Set<string>();
  for (const inv of i.invoices.filter((x) => !voided(x.status))) for (const l of inv.lines ?? []) if (l.sku && !orderedSkus.has(l.sku)) stray.add(l.sku);
  for (const f of i.fulfilments) for (const l of f.packLines) if (l.sku && !orderedSkus.has(l.sku)) stray.add(l.sku);
  for (const sku of stray) exceptions.push({ code: "UNORDERED_SKU_ACTIVITY", sku, message: `${sku} appears on an invoice or fulfilment but is not on the Sale order.` });
  return { rows, exceptions, asOf: new Date().toISOString() };
}
