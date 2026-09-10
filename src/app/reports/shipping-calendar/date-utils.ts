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

/** Same impure-read caveat as currentWeekStart — only ever call this via a useState initializer (e.g. the "mark as shipped" form's default Shipment Date), never inline during render. */
export function todayIso(): string {
  return isoDateOnly(new Date());
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

/** Days shown on one board — a Monday-anchored week. */
export const CALENDAR_DAY_COUNT = 7;

/**
 * The `ship_by` range that can land on this board's visible week (migration
 * 0090), so the page fetches that week instead of the org's whole history.
 *
 * CalendarBoard buckets a card under `ship_by - offsetDays` (0 for Shipping
 * Calendar, the org's saved lead time for Picking Calendar). Inverting that
 * for the visible range [weekStart, weekStart + 6] gives a ship_by range
 * shifted the OTHER way — hence `+ offsetDays` on both ends. Invoicing
 * Scheduler buckets in the opposite direction and so has its own version of
 * this function with the sign flipped; the two must not be shared.
 *
 * Both bounds inclusive, matching the SQL window.
 */
export function shipByWindowForWeek(weekStart: string, offsetDays: number): { shipByFrom: string; shipByTo: string } {
  return {
    shipByFrom: addDays(weekStart, offsetDays),
    shipByTo: addDays(weekStart, CALENDAR_DAY_COUNT - 1 + offsetDays),
  };
}
