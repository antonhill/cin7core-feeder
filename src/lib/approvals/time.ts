// Approval dates are stored in UTC and ALWAYS shown in South African Standard Time (Africa/Johannesburg, UTC+02:00, no daylight saving) as an
// unambiguous "29 Oct 2026, 10:32 SAST". Relative labels may supplement an exact time but never replace it.
const SAST_OFFSET_MS = 2 * 3_600_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n: number) => String(n).padStart(2, "0");
const sast = (iso: string | number | Date) => new Date(new Date(iso).getTime() + SAST_OFFSET_MS);

export function formatSast(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const d = sast(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} SAST`;
}
export function formatSastDate(iso: string | null | undefined): string {
  const s = formatSast(iso);
  return s === "—" ? s : s.split(",")[0] + "," + s.split(",")[1].slice(0, 5);
}

/**
 * Adds BUSINESS days (Monday-Friday, in SAST) keeping the time of day. Weekends are skipped; public holidays are NOT modelled (no organisation
 * business calendar exists yet), so a due date can fall on a holiday. This is stated in the UI rather than assumed.
 */
export function addBusinessDays(fromIso: string, days: number): string {
  const d = sast(fromIso);
  let left = Math.max(0, Math.floor(days));
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return new Date(d.getTime() - SAST_OFFSET_MS).toISOString();
}
export const weekdayOf = (iso: string): string => DAYS[sast(iso).getUTCDay()];

export const isOverdue = (dueAt: string | null, nowIso: string): boolean => dueAt != null && new Date(dueAt).getTime() < new Date(nowIso).getTime();

/** Elapsed (calendar) time, e.g. "2 d 3 h" / "45 min". Supplements the exact timestamp. */
export function waitingLabel(fromIso: string, nowIso: string): string {
  const ms = Math.max(0, new Date(nowIso).getTime() - new Date(fromIso).getTime());
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
