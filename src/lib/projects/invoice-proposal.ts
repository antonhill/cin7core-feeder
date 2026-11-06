// Projects - the PROPOSED progress invoice (pure, generic). Built from facts only: the approved claim's commercial charges, the project's approved
// product scope, and what Cin7 actually holds (Sale order lines, non-voided invoice lines, verified shipments) plus quantities already reserved by
// other in-flight postings. It is a PROPOSAL for manager review: it never posts, never changes anything, and is a pure function of its inputs
// (so preparing it again gives the identical proposal).
//
//  * A physical line is NEVER derived from a completion percentage.
//  * Default eligibility is FIRST DISPATCH: eligible = shipped - already invoiced - reserved by other postings (never above what was ordered).
//  * DEPOSIT and SERVICE (installation / commissioning) claims propose no product lines by default.
//  * A manager may select more than the eligible quantity - up to the Sale's remaining invoiceable quantity - only with a recorded reason.
//  * Unknown evidence (unreadable shipment / invoice lines) is UNKNOWN, never zero, and proposes nothing.
//  * All physical lines are at R0; the commercial value is carried only by the claim's charges.

export type StageKind = "DEPOSIT" | "MANUFACTURING" | "DELIVERY" | "SERVICE" | "OTHER";

export function stageKind(name: string): StageKind {
  const n = name.toLowerCase();
  if (/deposit|commencement|advance/.test(n)) return "DEPOSIT";
  if (/install|commission|handover/.test(n)) return "SERVICE";
  if (/deliver|dispatch|ship/.test(n)) return "DELIVERY";
  if (/manufactur|equipment ready|fabricat/.test(n)) return "MANUFACTURING";
  return "OTHER";
}

export interface ProposalClaimLine { stageName: string; amountCents: number; taxCents: number }
export interface ProposalOrderLine { sku: string; description: string; ordered: number | null }
export interface ProposalInvoice { status: string | null; lines: Array<{ sku: string | null; quantity: number | null }> | null }
export interface ProposalInput {
  claimLines: ProposalClaimLine[];
  /** The Sale's order lines (authoritative for what can be invoiced). */
  orderLines: ProposalOrderLine[];
  invoices: ProposalInvoice[];
  /** Verified shipped quantity per SKU, or null when the shipment evidence is unreadable. */
  shipped: Record<string, number | null | undefined>;
  /** Quantities held by OTHER in-flight postings that Cin7 does not show yet (PENDING / uncertain). */
  reserved: Record<string, number>;
  /** SKUs in the approved scope that are not on the Sale's order (reported, never invoiced). */
  scopeSkus: string[];
  /**
   * DELIVERY-ALLOCATION rule: when present, the claim is for ONE planned delivery and this is the per-SKU quantity allocated to it and not yet
   * invoiced against it. Eligibility then follows the allocation (even while goods are still loading), not the shipped quantity.
   */
  allocated?: Record<string, number>;
}

export type LineStatus = "PROPOSED" | "NOTHING_ELIGIBLE" | "EXCLUDED" | "UNKNOWN";
export interface ProposedLine {
  sku: string; description: string;
  ordered: number | null; invoiced: number | null; reserved: number; shipped: number | null;
  remainingToInvoice: number | null;
  /** Dispatch-eligible quantity under the default rule (null = unknown). */
  eligible: number | null;
  /** The quantity proposed (= eligible, or 0). */
  proposed: number;
  /** The most a manager may select, with a reason when it exceeds `eligible`. */
  maxSelectable: number;
  status: LineStatus;
  reasons: string[];
}
export interface InvoiceProposal {
  kinds: StageKind[];
  charges: Array<{ stageName: string; amountCents: number; taxCents: number }>;
  subtotalCents: number; taxCents: number; totalCents: number;
  lines: ProposedLine[];
  notes: string[];
  /** True if the default rule applies to this claim (any stage that is not deposit/service). */
  dispatchRuleApplies: boolean;
}

const voided = (s: string | null) => (s ?? "").toUpperCase() === "VOIDED";
const fin = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export function proposeInvoice(i: ProposalInput): InvoiceProposal {
  const kinds = [...new Set(i.claimLines.map((l) => stageKind(l.stageName)))];
  const dispatchRuleApplies = kinds.some((k) => k !== "DEPOSIT" && k !== "SERVICE");
  const notes: string[] = [];
  const subtotalCents = i.claimLines.reduce((n, l) => n + l.amountCents, 0);
  const taxCents = i.claimLines.reduce((n, l) => n + l.taxCents, 0);
  if (i.allocated && dispatchRuleApplies) notes.push("Products are proposed from the delivery allocation (not from shipment); shipment is reconciled separately from Cin7.");
  if (!dispatchRuleApplies) notes.push(`${kinds.join(" / ") || "This"} claim: no physical product lines are proposed by default (commercial charge only).`);

  const lines: ProposedLine[] = i.orderLines.map((o) => {
    const reasons: string[] = [];
    // invoiced: unreadable invoice lines make it UNKNOWN, never 0
    let invoiced: number | null = 0;
    for (const inv of i.invoices.filter((x) => !voided(x.status))) {
      if (inv.lines === null) { invoiced = null; break; }
      for (const l of inv.lines.filter((x) => x.sku === o.sku)) { if (!fin(l.quantity)) { invoiced = null; break; } invoiced = (invoiced ?? 0) + l.quantity; }
      if (invoiced === null) break;
    }
    const reserved = i.reserved[o.sku] ?? 0;
    const shippedRaw = i.shipped[o.sku];
    const shipped = fin(shippedRaw) ? shippedRaw : shippedRaw === undefined ? 0 : null; // no fulfilment lines for this SKU = nothing shipped; null = unreadable
    const remainingToInvoice = o.ordered !== null && invoiced !== null ? Math.max(0, o.ordered - invoiced - reserved) : null;
    let eligible: number | null = null;
    let status: LineStatus;
    if (o.ordered === null) { status = "UNKNOWN"; reasons.push("The ordered quantity on the Cin7 Sale is unreadable."); }
    else if (invoiced === null) { status = "UNKNOWN"; reasons.push("A previous invoice's product lines are unreadable, so the invoiced quantity cannot be proven."); }
    else if (!dispatchRuleApplies) { status = "EXCLUDED"; eligible = 0; reasons.push("Commercial-only claim (deposit / service): physical lines are not proposed by default."); }
    else if (i.allocated) {
      // Allocation rule: shipped is irrelevant (it is shown, never used). Capped by what the Sale still allows, so nothing is invoiced twice.
      const alloc = i.allocated[o.sku] ?? 0;
      eligible = Math.max(0, Math.min(alloc, o.ordered - invoiced - reserved));
      if (alloc === 0) reasons.push("Nothing is allocated to this delivery for this SKU.");
      if (alloc > 0 && eligible < alloc) reasons.push(`Only ${eligible} of the ${alloc} allocated can still be invoiced on the Sale (ordered ${o.ordered}, invoiced ${invoiced}, reserved ${reserved}).`);
      status = eligible > 0 ? "PROPOSED" : "NOTHING_ELIGIBLE";
    }
    else if (shipped === null) { status = "UNKNOWN"; reasons.push("Shipment evidence is unreadable, so nothing is proposed."); }
    else {
      eligible = Math.max(0, Math.min(shipped, o.ordered) - invoiced - reserved);
      if (shipped === 0) reasons.push("Nothing has shipped yet (first-dispatch rule).");
      if (reserved > 0) reasons.push(`${reserved} already reserved by another posting in progress.`);
      status = eligible > 0 ? "PROPOSED" : "NOTHING_ELIGIBLE";
      if (eligible === 0 && shipped > 0) reasons.push("Everything shipped has already been invoiced.");
    }
    return {
      sku: o.sku, description: o.description, ordered: o.ordered, invoiced, reserved, shipped, remainingToInvoice, eligible,
      proposed: status === "PROPOSED" ? (eligible as number) : 0, maxSelectable: remainingToInvoice ?? 0, status, reasons,
    };
  });
  const onOrder = new Set(i.orderLines.map((o) => o.sku));
  for (const sku of i.scopeSkus) if (!onOrder.has(sku)) notes.push(`${sku} is in the approved scope but not on the Cin7 Sale order, so it cannot be invoiced.`);
  return { kinds, charges: i.claimLines.map((l) => ({ stageName: l.stageName, amountCents: l.amountCents, taxCents: l.taxCents })), subtotalCents, taxCents, totalCents: subtotalCents + taxCents, lines, notes, dispatchRuleApplies };
}

/**
 * Checks a manager's final selection against the proposal's own facts, RECOMPUTED just before posting. Returns the first problem, or null.
 * `earlyReason` is required for any quantity above the dispatch-eligible amount.
 */
export function validateSelection(p: InvoiceProposal, selection: Array<{ sku: string; quantity: number }>, earlyReason: string | null): string | null {
  const seen = new Set<string>();
  let needsReason = false;
  for (const s of selection) {
    if (seen.has(s.sku)) return `SKU ${s.sku} is selected twice.`;
    seen.add(s.sku);
    if (!fin(s.quantity) || s.quantity <= 0) return `Quantity for ${s.sku} must be positive.`;
    const l = p.lines.find((x) => x.sku === s.sku);
    if (!l) return `${s.sku} is not on the Cin7 Sale order: products cannot be added through an invoice (use a controlled scope amendment).`;
    if (l.status === "UNKNOWN") return `${s.sku}: ${l.reasons.join(" ")}`;
    if (s.quantity > l.maxSelectable + 1e-9) return `${s.sku}: ${s.quantity} requested but only ${l.maxSelectable} remain invoiceable.`;
    if (s.quantity > (l.eligible ?? 0) + 1e-9) needsReason = true;
  }
  if (needsReason && !(earlyReason ?? "").trim()) return "A reason is required to invoice more than has been dispatched.";
  return null;
}
