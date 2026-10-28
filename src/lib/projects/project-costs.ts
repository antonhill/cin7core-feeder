// Projects - direct NON-STOCK project costs (pure). Installation labour, transport, subcontractors, site expenses and other direct costs that
// Cin7 inventory/assembly valuation does not carry. COMMITTED = expected, INCURRED = actual. An entry already inside a Cin7 valuation is recorded
// for visibility but EXCLUDED from totals (no double counting). INTERNAL cost data: only ever shown to org owners/admins.

export const COST_CATEGORIES = ["INSTALLATION_LABOUR", "TRANSPORT_DELIVERY", "SUBCONTRACTOR", "SITE_EXPENSE", "OTHER_DIRECT"] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];
export const COST_CATEGORY_LABEL: Record<CostCategory, string> = {
  INSTALLATION_LABOUR: "Installation labour", TRANSPORT_DELIVERY: "Transport & delivery", SUBCONTRACTOR: "Subcontractor", SITE_EXPENSE: "Site expense", OTHER_DIRECT: "Other direct cost",
};
export type CostState = "COMMITTED" | "INCURRED";

export interface CostEntry {
  id: string; category: CostCategory; description: string; supplier: string | null; reference: string | null; amount_cents: number; state: CostState;
  in_cin7_valuation: boolean; incurred_on: string | null; voided_at: string | null;
}

export interface NewCostInput { category: string; description: string; supplier?: string; reference?: string; amountRand: string; state: string; inCin7Valuation?: boolean; incurredOn?: string }

/** "1 250.50" / "R1,250.5" -> 125050 cents; null if not a positive amount with at most 2 decimals. */
export function randToCents(text: string): number | null {
  const t = text.trim().replace(/^R\s*/i, "").replace(/[\s,]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const cents = Math.round(Number(t) * 100);
  return cents > 0 ? cents : null;
}

export function validateNewCost(i: NewCostInput, today: string): { ok: true; row: { category: CostCategory; description: string; supplier: string | null; reference: string | null; amount_cents: number; state: CostState; in_cin7_valuation: boolean; incurred_on: string | null } } | { ok: false; error: string } {
  if (!(COST_CATEGORIES as readonly string[]).includes(i.category)) return { ok: false, error: "Choose a cost category." };
  if (!i.description.trim()) return { ok: false, error: "Describe the cost." };
  const cents = randToCents(i.amountRand);
  if (cents === null) return { ok: false, error: "Enter a positive amount in rand (at most 2 decimals), ex VAT." };
  if (i.state !== "COMMITTED" && i.state !== "INCURRED") return { ok: false, error: "A cost is either committed (expected) or incurred (actual)." };
  if (i.state === "INCURRED" && i.incurredOn && i.incurredOn > today) return { ok: false, error: "An incurred cost cannot be dated in the future." };
  if (i.state === "COMMITTED" && i.incurredOn) return { ok: false, error: "Only an incurred cost has an incurred date." };
  return { ok: true, row: {
    category: i.category as CostCategory, description: i.description.trim(), supplier: i.supplier?.trim() || null, reference: i.reference?.trim() || null,
    amount_cents: cents, state: i.state, in_cin7_valuation: Boolean(i.inCin7Valuation), incurred_on: i.state === "INCURRED" ? i.incurredOn || today : null,
  } };
}

export interface CostTotals { incurredCents: number; committedCents: number; excludedCents: number; byCategory: Record<CostCategory, { incurredCents: number; committedCents: number }> }

/** Totals over live (not voided) entries. Entries already inside a Cin7 valuation are listed in `excludedCents`, never added. */
export function totalCosts(entries: readonly Pick<CostEntry, "category" | "amount_cents" | "state" | "in_cin7_valuation" | "voided_at">[]): CostTotals {
  const byCategory = Object.fromEntries(COST_CATEGORIES.map((c) => [c, { incurredCents: 0, committedCents: 0 }])) as CostTotals["byCategory"];
  let incurredCents = 0, committedCents = 0, excludedCents = 0;
  for (const e of entries) {
    if (e.voided_at) continue;
    if (e.in_cin7_valuation) { excludedCents += e.amount_cents; continue; }
    if (e.state === "INCURRED") { incurredCents += e.amount_cents; byCategory[e.category].incurredCents += e.amount_cents; }
    else { committedCents += e.amount_cents; byCategory[e.category].committedCents += e.amount_cents; }
  }
  return { incurredCents, committedCents, excludedCents, byCategory };
}
