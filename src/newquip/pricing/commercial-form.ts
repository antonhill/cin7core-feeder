// Text <-> exact integer conversions for the Manager's commercial-settings form (pure; no floats). A figure with more decimals than the field holds is REFUSED (null), never rounded.
const dec = (s: string, places: number): bigint | null => {
  const m = new RegExp(`^(\\d{1,12})(?:\\.(\\d{1,${places}}))?$`).exec(s.trim());
  return m ? BigInt(m[1]) * BigInt(10) ** BigInt(places) + BigInt((m[2] ?? "").padEnd(places, "0") || "0") : null;
};
const shown = (n: number, places: number): string => {
  const base = BigInt(10) ** BigInt(places), v = BigInt(n);
  const frac = (v % base).toString().padStart(places, "0").replace(/0+$/, "");
  return frac ? `${v / base}.${frac}` : String(v / base);
};
/** "20" or "17.5" (percent, at most 2 decimals) -> basis points. */
export const pctToBps = (t: string): number | null => { const v = dec(t, 2); return v === null ? null : Number(v); };
export const bpsToPct = (bps: number): string => shown(bps, 2);
/** A rate or factor with at most 6 decimals -> micro units. */
export const decimalToMicro = (t: string): number | null => { const v = dec(t, 6); return v === null || v > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(v); };
export const microToDecimal = (m: number): string => shown(m, 6);
/** Rand with at most 2 decimals -> cents. */
export const randToCents = (t: string): number | null => { const v = dec(t, 2); return v === null ? null : Number(v); };
export const centsToRand = (c: number): string => shown(c, 2);
