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
}

export interface PhysicalRow {
  sku: string;
  name: string;
  /** Approved project requirement on the Sale order. */
  ordered: number | null;
  /** Physical units represented on non-voided invoices (at R0). Independent of shipping. */
  invoiced: number | null;
  /** Packed on fulfilments that have been shipped. */
  shipped: number | null;
  /** ordered - shipped. */
  remaining: number | null;
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

export type PhysicalExceptionCode = "OVER_INVOICED" | "OVER_SHIPPED" | "UNREADABLE_QUANTITY" | "STOCK_NOT_READ" | "UNORDERED_SKU_ACTIVITY";
export interface PhysicalException { code: PhysicalExceptionCode; sku: string; message: string }

const num = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
/** Sums a list; any unreadable member makes the whole sum unknown (null), never a partial total. */
const sumKnown = (xs: Array<number | null>): number | null => (xs.some((x) => x === null) ? null : xs.reduce<number>((n, x) => n + (x as number), 0));
const voided = (s: string | null) => (s ?? "").toUpperCase() === "VOIDED";
const ASSEMBLY_ACTIVE = new Set(["DRAFT", "AUTHORISED", "IN PROGRESS"]);

export function buildPhysicalStatus(i: PhysicalInputs): { rows: PhysicalRow[]; exceptions: PhysicalException[]; asOf: string } {
  const exceptions: PhysicalException[] = [];
  const skus = i.ordered.map((o) => o.sku);
  const orderedSkus = new Set(skus);
  const rows = i.ordered.map((o): PhysicalRow => {
    const ordered = num(o.quantity);
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

    if (ordered === null) exceptions.push({ code: "UNREADABLE_QUANTITY", sku: o.sku, message: `The ordered quantity of ${o.sku} is unreadable.` });
    if (ordered !== null && invoiced !== null && invoiced > ordered + 1e-9) exceptions.push({ code: "OVER_INVOICED", sku: o.sku, message: `${o.sku}: ${invoiced} invoiced against ${ordered} ordered.` });
    if (ordered !== null && shipped !== null && shipped > ordered + 1e-9) exceptions.push({ code: "OVER_SHIPPED", sku: o.sku, message: `${o.sku}: ${shipped} shipped against ${ordered} ordered.` });
    if (!st) exceptions.push({ code: "STOCK_NOT_READ", sku: o.sku, message: `Stock for ${o.sku} was not read from Cin7.` });
    return {
      sku: o.sku, name: o.name, ordered, invoiced, shipped, remaining,
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
