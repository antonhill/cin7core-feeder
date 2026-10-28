// Generic margin arithmetic (integer cents). Lives in lib/projects so the Projects module needs nothing from NewQuip; the NewQuip margin
// sheet re-exports it.
export interface MarginFigures {
  sellingCents: number;
  /** Null when the cost is unknown. */
  costCents: number | null;
  gpCents: number | null;
  /** Percent with two decimals; null when cost is unknown or the selling price is not positive. */
  marginPct: number | null;
  /** Percent with two decimals; null when cost is unknown or not positive. */
  markupPct: number | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function marginFigures(sellingCents: number, costCents: number | null): MarginFigures {
  if (!Number.isFinite(sellingCents)) throw new Error("A selling value must be a finite number of cents.");
  if (costCents === null || !Number.isFinite(costCents) || costCents < 0) return { sellingCents, costCents: null, gpCents: null, marginPct: null, markupPct: null };
  const gp = sellingCents - costCents;
  return {
    sellingCents, costCents, gpCents: gp,
    marginPct: sellingCents > 0 ? round2((gp / sellingCents) * 100) : null,
    markupPct: costCents > 0 ? round2((gp / costCents) * 100) : null,
  };
}

