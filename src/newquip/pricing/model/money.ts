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

// SUPPLIER-NATIVE UNIT COSTS are held in units of 1e-7 of the supplier's currency ("E7"), because Cin7 reports supplier costs with up to 7 decimals (for example 6.5454755). Exchange
// rates and freight factors stay in micro units (6 decimals). A cost with more than 7 decimals is REFUSED, never rounded or truncated.
export const COST_DECIMALS = 7;
const COST_SCALE = BigInt(10_000_000);

/** A decimal string or number with at most 7 decimals -> E7 units (1e-7). Throws on anything else (never rounds silently). */
export function cost7(v: string | number): number {
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : v.trim();
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(s);
  if (!m) throw new Error(`"${String(v)}" is not a non-negative number with at most 7 decimals.`);
  const e7 = BigInt(m[1]) * COST_SCALE + BigInt((m[2] ?? "").padEnd(COST_DECIMALS, "0"));
  if (e7 > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`"${String(v)}" is too large to hold exactly.`); // never lose precision silently
  return Number(e7);
}
/** E7 units -> a number, for DISPLAY only (never fed back into arithmetic). */
export const fromCost7 = (c: number): number => c / 10_000_000;
/** E7 units -> an exact plain decimal string (no exponent, trailing zeros trimmed): 1 -> "0.0000001", 65454755 -> "6.5454755". For form fields, so what is shown can always be parsed back by `cost7`. */
export function formatCost7(c: number): string {
  const n = BigInt(c);
  const whole = n / COST_SCALE, frac = (n % COST_SCALE).toString().padStart(COST_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

/** Half-up integer division (all operands non-negative). */
export function divRound(n: bigint, d: bigint): bigint {
  return (n * BigInt(2) + d) / (d * BigInt(2));
}

/** Native unit cost x ROE (ZAR per 1 unit) x freight factor -> whole cents. All three are micro units: the product carries 1e18, and x100 for cents leaves 1e16. */
export function landedCents(nativeCostMicro: number, rateMicro: number, freightFactorMicro: number): number {
  return Number(divRound(BigInt(nativeCostMicro) * BigInt(rateMicro) * BigInt(freightFactorMicro) * BigInt(100), BigInt("1000000000000000000")));
}

/**
 * Native unit cost (E7 units, 1e-7) x ROE (micro) x freight factor (micro) -> whole cents, half-up, in exact BigInt arithmetic. For the same cost it gives exactly what `landedCents`
 * gives for the micro-unit cost (cost7("100") and micro("100") price identically); the extra digit only matters when a cost really has a 7th decimal.
 * Carries 1e7 x 1e6 x 1e6 = 1e19, and x100 for cents leaves 1e17.
 */
export function landedCentsE7(nativeCostE7: number, rateMicro: number, freightFactorMicro: number): number {
  return Number(divRound(BigInt(nativeCostE7) * BigInt(rateMicro) * BigInt(freightFactorMicro) * BigInt(100), BigInt("10000000000000000000")));
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
