/** Pure UTC date and month helpers for the Red Flag engine. No clock is ever read: the stock date is always an input. */

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

export function parseIsoDate(s: string): number | null {
  const m = ISO_DATE_RE.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? t : null;
}

/** Whole days from `fromIso` to `toIso` (negative when `toIso` is earlier). Both must be valid ISO dates. */
export function daysBetween(fromIso: string, toIso: string): number {
  const a = parseIsoDate(fromIso);
  const b = parseIsoDate(toIso);
  if (a === null || b === null) throw new Error("daysBetween: invalid ISO date");
  return Math.round((b - a) / MS_PER_DAY);
}

/**
 * Projection week of a date: week 1 is the 7 days after the stock date (stock date + 1 .. + 7), week 2 the next 7, and so on.
 * A value of 0 or less means the date is on or before the stock date.
 */
export function weekOfDate(stockDate: string, date: string): number {
  return Math.ceil(daysBetween(stockDate, date) / 7);
}

export function monthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

export function isLastDayOfMonth(isoDate: string): boolean {
  const t = parseIsoDate(isoDate);
  if (t === null) return false;
  return new Date(t + MS_PER_DAY).getUTCDate() === 1;
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/** The `count` consecutive months ending at (and including) `end`, ascending. */
export function monthsEndingAt(end: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => shiftMonth(end, i - (count - 1)));
}

/** Months strictly after `from` up to and including `to` (empty when `to` is not later). */
export function monthsBetweenExclusive(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = shiftMonth(from, 1); m <= to && out.length < 1200; m = shiftMonth(m, 1)) out.push(m);
  return out;
}

/** The latest month that is COMPLETE as at the stock date: the stock date's own month only if the stock date is its last day. */
export function lastCompleteMonth(stockDate: string): string {
  const month = monthOf(stockDate);
  return isLastDayOfMonth(stockDate) ? month : shiftMonth(month, -1);
}
