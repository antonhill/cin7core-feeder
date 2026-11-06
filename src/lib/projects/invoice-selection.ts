// Bulk selection of the physical (R0, quantity-only) product lines on a proposed Cin7 progress invoice. Pure and generic.
//
// A selection only ever decides WHICH product quantities are sent. It never touches the claim's commercial charges (Additional Charges), which
// come from the approved claim alone. Eligibility is never widened here: a quantity above the dispatch/allocation-eligible amount is still
// possible only by typing it, and then validateSelection (invoice-proposal.ts) demands the recorded early-invoicing reason.

import type { ProposedLine } from "./invoice-proposal";

type Line = Pick<ProposedLine, "sku" | "status" | "eligible" | "maxSelectable">;
export interface LineSelection { selected: ReadonlySet<string>; qty: Readonly<Record<string, string>> }

const selectable = (l: Line): boolean => l.status !== "UNKNOWN" && l.status !== "EXCLUDED";
const eligibleQty = (l: Line): number => Math.max(0, Math.min(l.eligible ?? 0, l.maxSelectable));
const asText = (n: number): string => String(n);

/** Every line that currently has something eligible to invoice. */
export function selectAllEligible(lines: readonly Line[]): LineSelection {
  const selected = new Set<string>(); const qty: Record<string, string> = {};
  for (const l of lines) {
    const q = selectable(l) ? eligibleQty(l) : 0;
    qty[l.sku] = asText(q);
    if (q > 0) selected.add(l.sku);
  }
  return { selected, qty };
}

export function clearSelection(lines: readonly Line[]): LineSelection {
  return { selected: new Set(), qty: Object.fromEntries(lines.map((l) => [l.sku, "0"])) };
}

/** Fills the eligible quantity for the lines already selected (a line with nothing eligible keeps what was typed, so early invoicing stays explicit). */
export function populateEligible(lines: readonly Line[], cur: LineSelection): LineSelection {
  const qty = { ...cur.qty };
  for (const l of lines) if (cur.selected.has(l.sku) && selectable(l) && eligibleQty(l) > 0) qty[l.sku] = asText(eligibleQty(l));
  return { selected: cur.selected, qty };
}

/** Ticking a line proposes its eligible quantity (or leaves the typed one when nothing is eligible); unticking zeroes it. */
export function toggleLine(lines: readonly Line[], cur: LineSelection, sku: string, on: boolean): LineSelection {
  const l = lines.find((x) => x.sku === sku);
  if (!l || !selectable(l)) return cur;
  const selected = new Set(cur.selected); const qty = { ...cur.qty };
  if (on) { selected.add(sku); if (eligibleQty(l) > 0 && !(Number(qty[sku]) > 0)) qty[sku] = asText(eligibleQty(l)); }
  else { selected.delete(sku); qty[sku] = "0"; }
  return { selected, qty };
}

export function visibleLines<T extends { sku: string }>(lines: readonly T[], sel: LineSelection, selectedOnly: boolean): T[] {
  return selectedOnly ? lines.filter((l) => sel.selected.has(l.sku)) : [...lines];
}

/** The quantities that will be sent: selected, selectable, positive, finite. Nothing else. */
export function selectionToQuantities(lines: readonly Line[], sel: LineSelection): Array<{ sku: string; quantity: number }> {
  const out: Array<{ sku: string; quantity: number }> = [];
  for (const l of lines) {
    if (!sel.selected.has(l.sku) || !selectable(l)) continue;
    const q = Number(sel.qty[l.sku]);
    if (Number.isFinite(q) && q > 0) out.push({ sku: l.sku, quantity: q });
  }
  return out;
}
