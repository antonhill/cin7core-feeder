// Projects - DELIVERY ALLOCATION (pure, generic). A planned assignment of SKU quantities to a delivery, per billing project. It is a plan for
// invoicing: it is NOT a Cin7 stock reservation and NOT a shipment, and it never posts or ships anything.
//
// Quantities tracked separately per SKU: quoted (approved scope), ordered (Cin7 Sale), allocated (to non-cancelled deliveries), invoiced,
// shipped, remaining invoiceable and remaining deliverable. Unknown Cin7 data stays null - it is never treated as zero.

export interface ScopeQty { sku: string; description?: string; quantity: number }
export interface AllocationRow { deliveryId: string; sku: string; quantity: number }
export interface DeliveryRef { id: string; label: string; status: "PLANNED" | "LOADING" | "DISPATCHED" | "CANCELLED" }

export interface QuantityPosition {
  sku: string; description: string;
  quoted: number;
  ordered: number | null;
  allocated: number;
  invoiced: number | null;
  shipped: number | null;
  /** ordered (else quoted, before a Sale exists) - allocated: how much may still be allocated. */
  unallocated: number;
  /** ordered - invoiced; null when either is unknown. */
  remainingInvoiceable: number | null;
  /** ordered - shipped; null when either is unknown. */
  remainingDeliverable: number | null;
  /** allocated to a delivery but not yet invoiced against it (from local posting records). */
  allocatedNotInvoiced: number;
  /** The cap allocations may not exceed: the Sale's ordered quantity, else the approved quoted quantity. */
  cap: number;
  warnings: string[];
}

const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

export interface PositionInput {
  scope: ScopeQty[];
  /** Ordered quantity per SKU from the linked Sale; null = unreadable; undefined/absent SKU = no Sale line. Omit entirely when no Sale exists. */
  ordered?: Record<string, number | null | undefined>;
  invoiced?: Record<string, number | null | undefined>;
  shipped?: Record<string, number | null | undefined>;
  deliveries: DeliveryRef[];
  allocations: AllocationRow[];
  /** Quantity already invoiced against a specific delivery and SKU (from posting records). Key: `${deliveryId}|${sku}`. */
  invoicedAgainstDelivery: Record<string, number>;
}

export const allocKey = (deliveryId: string, sku: string) => `${deliveryId}|${sku}`;

export function activeAllocations(deliveries: DeliveryRef[], allocations: AllocationRow[]): AllocationRow[] {
  const live = new Set(deliveries.filter((d) => d.status !== "CANCELLED").map((d) => d.id));
  return allocations.filter((a) => live.has(a.deliveryId));
}

export function buildQuantityPositions(i: PositionInput): QuantityPosition[] {
  const live = activeAllocations(i.deliveries, i.allocations);
  const skus = [...new Set([...i.scope.map((s) => s.sku), ...live.map((a) => a.sku)])];
  return skus.map((sku) => {
    const s = i.scope.find((x) => x.sku === sku);
    const quoted = s?.quantity ?? 0;
    const warnings: string[] = [];
    const hasSale = i.ordered !== undefined;
    const rawOrdered = hasSale ? i.ordered![sku] : undefined;
    const ordered = hasSale && fin(rawOrdered) ? rawOrdered : null;
    if (hasSale && rawOrdered === null) warnings.push("The ordered quantity on the Cin7 Sale is unreadable; allocations are capped at the approved quoted quantity.");
    if (hasSale && rawOrdered === undefined) warnings.push("This SKU is not on the Cin7 Sale order, so it cannot be invoiced.");
    const allocated = r6(live.filter((a) => a.sku === sku).reduce((n, a) => n + a.quantity, 0));
    const inv = i.invoiced?.[sku]; const sh = i.shipped?.[sku];
    const invoiced = fin(inv) ? inv : null; const shipped = fin(sh) ? sh : null;
    const cap = ordered ?? quoted;
    const allocatedNotInvoiced = r6(live.filter((a) => a.sku === sku).reduce((n, a) => n + Math.max(0, a.quantity - (i.invoicedAgainstDelivery[allocKey(a.deliveryId, sku)] ?? 0)), 0));
    if (allocated > cap + 1e-9) warnings.push(`Allocated ${allocated} exceeds the ${ordered !== null ? "ordered" : "quoted"} quantity ${cap}.`);
    return {
      sku, description: s?.description ?? sku, quoted, ordered, allocated, invoiced, shipped,
      unallocated: r6(Math.max(0, cap - allocated)),
      remainingInvoiceable: ordered !== null && invoiced !== null ? r6(Math.max(0, ordered - invoiced)) : null,
      remainingDeliverable: ordered !== null && shipped !== null ? r6(Math.max(0, ordered - shipped)) : null,
      allocatedNotInvoiced, cap, warnings,
    };
  });
}

export interface AllocationChange {
  deliveryId: string; sku: string;
  /** The new total quantity for this delivery + SKU; 0 removes the allocation. */
  quantity: number;
  reason: string;
}

/** Checks one allocation change against the approved scope / Sale and what is already invoiced. Returns the first problem, or null. */
export function validateAllocationChange(
  change: AllocationChange,
  ctx: { scope: ScopeQty[]; ordered?: Record<string, number | null | undefined>; deliveries: DeliveryRef[]; allocations: AllocationRow[]; invoicedAgainstDelivery: Record<string, number> },
): string | null {
  const d = ctx.deliveries.find((x) => x.id === change.deliveryId);
  if (!d) return "Delivery not found in this project.";
  if (d.status === "CANCELLED") return "A cancelled delivery cannot be changed.";
  if (d.status === "DISPATCHED") return "A dispatched delivery's allocations are frozen.";
  if (!fin(change.quantity) || change.quantity < 0) return "Quantity must be zero or a positive number.";
  if (!(change.reason ?? "").trim()) return "A reason is required for every allocation change.";
  const scope = ctx.scope.find((s) => s.sku === change.sku);
  if (!scope) return `${change.sku} is not in this billing scope's approved products.`;
  const invoicedHere = ctx.invoicedAgainstDelivery[allocKey(change.deliveryId, change.sku)] ?? 0;
  if (change.quantity + 1e-9 < invoicedHere) return `${change.quantity} is below the ${invoicedHere} already invoiced against this delivery.`;
  const hasSale = ctx.ordered !== undefined;
  const raw = hasSale ? ctx.ordered![change.sku] : undefined;
  if (hasSale && raw === undefined) return `${change.sku} is not on the Cin7 Sale order; products cannot be added through an allocation.`;
  const cap = hasSale && fin(raw) ? raw : scope.quantity;
  const others = activeAllocations(ctx.deliveries, ctx.allocations).filter((a) => a.sku === change.sku && a.deliveryId !== change.deliveryId).reduce((n, a) => n + a.quantity, 0);
  if (others + change.quantity > cap + 1e-9) return `${change.sku}: ${r6(others + change.quantity)} allocated would exceed the ${hasSale && fin(raw) ? "ordered" : "approved"} quantity ${cap} (${r6(others)} already on other deliveries).`;
  return null;
}

/** Per-SKU quantity that is allocated to ONE delivery and not yet invoiced against it - the allocation rule's eligibility input. */
export function allocatedUninvoiced(deliveryId: string, allocations: AllocationRow[], invoicedAgainstDelivery: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of allocations.filter((x) => x.deliveryId === deliveryId)) {
    const left = r6(Math.max(0, a.quantity - (invoicedAgainstDelivery[allocKey(deliveryId, a.sku)] ?? 0)));
    if (left > 0) out[a.sku] = left;
  }
  return out;
}

/** Sums posting lines (non-failed postings) into invoiced-against-delivery quantities. */
export function sumInvoicedAgainstDeliveries(postings: Array<{ posting_state: string; physical_lines?: Array<{ sku: string; quantity: number; deliveryId?: string }> | null }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of postings) {
    if (p.posting_state === "FAILED_CONFIRMED_NO_WRITE") continue;
    for (const l of p.physical_lines ?? []) if (l.deliveryId) out[allocKey(l.deliveryId, l.sku)] = r6((out[allocKey(l.deliveryId, l.sku)] ?? 0) + l.quantity);
  }
  return out;
}
