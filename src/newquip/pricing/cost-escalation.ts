import { divRound } from "./model/money";
import { DAYS_PER_YEAR_CENTI, type AgeBand } from "./commercial-settings";

// COST-AGE ESCALATION (pure, EXACT). The owner-approved model: a supplier cost last supplied some time ago is escalated by marginal bands (each year of age is charged at the rate of the
// band it falls in), SIMPLE (not compound), with a year of 365.25 days and a maximum age beyond which NO automatic price is produced.
//
// Exact integer arithmetic only: the age is a whole number of days between two calendar dates; "years" are days x 100 / 36525; the escalation in basis points is
//   sum over bands of rateBps x (centi-days of age inside the band) / 36525, rounded half up ONCE at the end. No float is used.

const DAY_MS = 86_400_000;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})/;
const dayNumber = (s: string | null | undefined): number | null => {
  const m = s ? ISO_DAY.exec(s) : null;
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === `${m[1]}-${m[2]}-${m[3]}` ? t / DAY_MS : null;
};

export type EscalationResult =
  | { status: "ok"; ageDays: number; escalationBps: number; factorBps: number; bands: Array<{ fromYears: number; toYears: number | null; rateBps: number; centiDaysInBand: number }> }
  | { status: "undated" | "future_dated" | "older_than_maximum"; ageDays: number | null };

/** The escalation for a cost last supplied on `lastSupplied` (YYYY-MM-DD...), as at `todayIso`. Undated, future-dated and over-age costs get NO factor (no automatic price). */
export function escalationFor(lastSupplied: string | null | undefined, todayIso: string, bands: readonly AgeBand[], maxAgeYears: number, daysPerYearCenti: number = DAYS_PER_YEAR_CENTI): EscalationResult {
  const a = dayNumber(lastSupplied), b = dayNumber(todayIso);
  if (a === null || b === null) return { status: "undated", ageDays: null };
  if (a > b) return { status: "future_dated", ageDays: null };
  const ageDays = b - a;
  const centi = ageDays * 100; // age in 1/100 days; a "year" is daysPerYearCenti of these
  if (centi > maxAgeYears * daysPerYearCenti) return { status: "older_than_maximum", ageDays };
  let numerator = BigInt(0);
  const used: Array<{ fromYears: number; toYears: number | null; rateBps: number; centiDaysInBand: number }> = [];
  for (const band of bands) {
    const from = band.fromYears * daysPerYearCenti;
    const to = band.toYears === null ? Number.POSITIVE_INFINITY : band.toYears * daysPerYearCenti;
    const inBand = Math.max(0, Math.min(centi, to) - from);
    if (inBand > 0) { numerator += BigInt(band.rateBps) * BigInt(inBand); used.push({ ...band, centiDaysInBand: inBand }); }
  }
  const escalationBps = Number(divRound(numerator, BigInt(daysPerYearCenti)));
  return { status: "ok", ageDays, escalationBps, factorBps: 10_000 + escalationBps, bands: used };
}

/** native cost (E7) x factor (bps) / 10000, half up, exact BigInt. */
export function escalateCostE7(costE7: number, factorBps: number): number {
  return Number(divRound(BigInt(costE7) * BigInt(factorBps), BigInt(10_000)));
}
