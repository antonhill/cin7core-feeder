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

/** Whole-cent revenue/cost of `unitCents` x `quantity` (quantity may be fractional, e.g. running metres). */
export const lineCents = (unitCents: number, quantity: number): number => Math.round(unitCents * quantity);

export const isInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);
export const isQty = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
