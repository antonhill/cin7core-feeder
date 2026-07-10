/**
 * Plain date-string ("YYYY-MM-DD") helpers for the shipping calendar's week
 * grid — kept as pure, deterministic functions (no ambient "now" read
 * inside any of them except `currentWeekStart`, which exists specifically
 * to be called once as a useState initializer, not from inside a component
 * body/render — same React Compiler-safe pattern already used elsewhere in
 * this codebase for "get today's date" defaults).
 */

function isoDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Monday on/before the given date (JS's getUTCDay(): Sun=0..Sat=6). */
export function mondayOf(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return isoDateOnly(d);
}

/** The lone impure read in this module — pass this function itself (not a call to it) as a useState initializer so it only ever runs once, outside render. */
export function currentWeekStart(): string {
  return mondayOf(isoDateOnly(new Date()));
}

export function addDays(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDateOnly(d);
}

export function formatDayLabel(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}
