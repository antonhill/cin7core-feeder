/**
 * Single South African money presentation for every NewQuip display path.
 *
 *   R 12 345 678,90      (ZAR, "R" prefix, space thousands, comma decimal, 2 dp)
 *   -R 1 234,50          (negative: sign BEFORE the R)
 *
 * Built from integer math on cents and a fixed pattern. It deliberately does NOT use
 * Intl / toLocaleString: the separator characters of "en-ZA" differ across ICU versions
 * (and between Node and browsers), which would make output non-deterministic.
 *
 * The separators are NON-BREAKING SPACES (U+00A0) - between thousands groups and after
 * "R" - so a figure can never wrap mid-amount. Tests/search should compare against the
 * exact strings (use NBSP) or go through this formatter.
 *
 * Display only. Never use the output as a stored value or in a calculation.
 */
export const NBSP = "\u00A0";

const B0 = BigInt(0);
const B1 = BigInt(1);
const B100 = BigInt(100);

function render(neg: boolean, cents: bigint): string {
  const whole = (cents / B100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const frac = (cents % B100).toString().padStart(2, "0");
  return `${neg && cents !== B0 ? "-" : ""}R${NBSP}${whole},${frac}`;
}

/** Integer cents -> "R 1 234,50". Null / non-finite input returns the placeholder. */
export function formatZarCents(cents: number | null | undefined, placeholder = "\u2014"): string {
  if (cents == null || !Number.isFinite(cents)) return placeholder;
  // BigInt keeps digits exact beyond 2^53; Math.round only matters for non-integer input.
  return render(cents < 0, BigInt(Math.round(Math.abs(cents))));
}

/**
 * Rands (a JS number) -> display string. Converts to cents from a decimal string (not x*100)
 * so 0.1+0.2, 1.005 etc. do not drift; the cent is rounded half away from zero.
 */
export function formatZar(rands: number | null | undefined, placeholder = "\u2014"): string {
  if (rands == null || !Number.isFinite(rands)) return placeholder;
  const abs = Math.abs(rands);
  if (abs >= 1e15) return render(rands < 0, BigInt(Math.round(abs)) * B100);
  // toFixed(10) strips binary noise (0.1+0.2 -> 0.3000000000) but keeps the true decimal.
  const [w, f] = abs.toFixed(10).split(".");
  const cents = BigInt(w) * B100 + BigInt(f.slice(0, 2)) + (f.charCodeAt(2) >= 53 ? B1 : B0);
  return render(rands < 0, cents);
}

const BMICRO = BigInt(1_000_000);

/**
 * Micro-units (1e-6 of the currency; supplier unit costs) -> "R 1 234,56", or "USD 12,5" style for a foreign currency: the same separators as everywhere else, never ICU.
 * Two decimals minimum, up to six when the price really has them (a unit cost of 0,0042 must not read R 0,00). Display only.
 */
export function formatMicroAmount(micro: number | null | undefined, currency: string | null | undefined, placeholder = "—"): string {
  if (micro == null || !Number.isFinite(micro)) return placeholder;
  const abs = BigInt(Math.round(Math.abs(micro)));
  const whole = (abs / BMICRO).toString().replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const frac = (abs % BMICRO).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  const cur = currency == null ? "?" : currency === "ZAR" ? "R" : currency;
  return `${micro < 0 && abs !== B0 ? "-" : ""}${cur}${NBSP}${whole},${frac}`;
}
