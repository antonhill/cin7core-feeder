/**
 * Money in integer cents. Every rand/dollar amount the landed-cost engine reports is an integer number of cents, so totals add
 * up exactly (no floating-point drift) and the same input always gives the same output.
 */
export type Cents = number;

const EPS = 1e-6;

/** Rounds half away from zero to a whole number of cents. The small epsilon makes 1.005 -> 1.01 despite binary floating point. */
export function toCents(amount: number): Cents {
  const c = Math.abs(amount) * 100;
  const r = Math.floor(c + 0.5 + EPS);
  return amount < 0 ? -r : r;
}

export const fromCents = (c: Cents): number => c / 100;

/** `cents` scaled by `factor`, rounded half away from zero to a whole cent. */
export function scaleCents(cents: Cents, factor: number): Cents {
  const v = Math.abs(cents) * factor;
  const r = Math.floor(v + 0.5 + EPS);
  return cents < 0 ? -r : r;
}

/**
 * Splits `total` cents across `weights` so the parts sum to `total` EXACTLY (largest-remainder method; ties go to the earlier
 * position). Zero weights get zero. Returns null when there is nothing to split by (no positive weight).
 */
export function allocateCents(total: Cents, weights: readonly number[]): Cents[] | null {
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const sum = w.reduce((a, b) => a + b, 0);
  if (w.length === 0 || sum <= 0) return null;
  const exact = w.map((x) => (total * x) / sum);
  const parts = exact.map((e) => Math.floor(e + 1e-9));
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => ({ i, frac: e - Math.floor(e + 1e-9) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    if (w[i] > 0) {
      parts[i] += 1;
      left -= 1;
    }
  }
  return parts;
}
