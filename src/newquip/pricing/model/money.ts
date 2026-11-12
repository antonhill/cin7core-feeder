// EXACT MONEY ARITHMETIC for the versioned pricing model (NQ-008B Phase 1). Pure. Rates, native costs and factors are integers in MICRO units (6 decimals), amounts of
// rand are integer CENTS, and every conversion is done in BigInt with half-up rounding, so a price can never drift by floating-point error (the same discipline as the
// existing workbook price source, which this reproduces cent for cent under the legacy rule version).

const MICRO = BigInt(1_000_000);

/** A decimal string or number with at most 6 decimals -> micro units. Throws on anything else (never rounds silently). */
export function micro(v: string | number): number {
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : v.trim();
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) throw new Error(`"${String(v)}" is not a non-negative number with at most 6 decimals.`);
  return Number(BigInt(m[1]) * MICRO + BigInt((m[2] ?? "").padEnd(6, "0")));
}
export const fromMicro = (m: number): number => m / 1_000_000;

/** Half-up integer division (all operands non-negative). */
export function divRound(n: bigint, d: bigint): bigint {
  return (n * BigInt(2) + d) / (d * BigInt(2));
}

/** Native unit cost x ROE (ZAR per 1 unit) x freight factor -> whole cents. All three are micro units: the product carries 1e18, and x100 for cents leaves 1e16. */
export function landedCents(nativeCostMicro: number, rateMicro: number, freightFactorMicro: number): number {
  return Number(divRound(BigInt(nativeCostMicro) * BigInt(rateMicro) * BigInt(freightFactorMicro) * BigInt(100), BigInt("1000000000000000000")));
}

/** cents x (10000 + bps) / 10000, half-up. */
export function withMarkupBps(costCents: number, bps: number): number {
  return Number(divRound(BigInt(costCents) * BigInt(10_000 + bps), BigInt(10_000)));
}

/** A quantity may have at most 3 decimals (running metres, tonnes). Returns it in thousandths, or null when it has more precision than that. */
export function quantityMilli(quantity: number): number | null {
  const milli = Math.round(quantity * 1000);
  return Number.isSafeInteger(milli) && Math.abs(milli - quantity * 1000) < 1e-6 ? milli : null;
}

/** Whole-cent revenue/cost of `unitCents` x `quantity`: exact integer arithmetic, half-up. */
export const lineCents = (unitCents: number, quantity: number): number => {
  const milli = quantityMilli(quantity);
  if (milli === null) throw new Error("A quantity can have at most 3 decimals.");
  return Number(divRound(BigInt(unitCents) * BigInt(milli), BigInt(1000)));
};

// ── THE ROUNDING RULE (one place, stated once) ─────────────────────────────
//  • Money is held in whole cents. Every conversion or multiplication that is not already whole is rounded HALF UP (a tie goes away from zero) in exact integer arithmetic.
//  • A margin or markup PERCENTAGE is rounded half up to 2 decimals, again in exact integers: 14.125% is 14.13%, 14.124% is 14.12%, a loss of 14.125% is -14.13%.
//  • Percentages are DISPLAY figures only. Nothing is ever recalculated from a rounded percentage; prices come from cents and basis points.
//  • The shared Projects helper (`marginFigures`) rounds in floating point and shows 14.125% as 14.12%. That is not changed here (Projects is out of scope and
//    needs its own regression evidence); the model does not use it, and a test pins both behaviours so the difference is visible, not accidental.

/** numerator / denominator x 100 as a percentage with 2 decimals, half away from zero, exactly. Denominator must be > 0. */
export function pct2(numerator: number, denominator: number): number {
  const n = BigInt(numerator), d = BigInt(denominator);
  const neg = n < BigInt(0);
  const hundredths = divRound((neg ? -n : n) * BigInt(10_000), d);
  return (neg ? -1 : 1) * Number(hundredths) / 100;
}

export const isInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);
export const isQty = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
