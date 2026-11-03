/**
 * DP-14: an optional local (7th Wave) make offset against an import requirement.
 *
 * The workbook supplies NO local-production capacity, lead time or planned quantity, so by default the calculation is NOT EVALUATED.
 * A planner may enter values; they are always labelled a DEMONSTRATION ASSUMPTION, never client-confirmed figures.
 *
 * Local make is never received stock and is never added to Available, balances or inbound. It only reduces the REQUIREMENT that is
 * left after imports already counted in the projection, so it cannot be counted twice against the same shortage.
 */

export const LOCAL_MAKE_LABEL = "DEMONSTRATION ASSUMPTION: entered by the planner, not a client-confirmed value";

export interface LocalMakeEntry {
  /** Proposed local-make quantity (whole units). */
  readonly quantity: number;
  /** Available local-production capacity for the quantity (whole units). */
  readonly capacityUnits: number;
  /** Production lead time in whole weeks. */
  readonly leadTimeWeeks: number;
  /** Expected completion week (1-based, counted from the stock date). */
  readonly completionWeek: number;
}

export type LocalMakeStatus = "NOT EVALUATED" | "BLOCKED" | "EVALUATED";

export interface LocalMakeResult {
  readonly status: LocalMakeStatus;
  readonly reason: string | null;
  /** The requirement before the local make (the selected formula's calculated proposal). */
  readonly gross: number | null;
  /** Units of local make counted against the requirement: within capacity, within the horizon, never more than the requirement. */
  readonly localCounted: number;
  /** What is still to be imported: gross - localCounted. Null when not evaluated or blocked. */
  readonly residualImport: number | null;
  readonly entry: LocalMakeEntry | null;
  readonly label: string | null;
}

export interface LocalMakeInput {
  readonly gross: number | null;
  /** Items.Source for the SKU ("Import", "Local", "Both") or null. */
  readonly source: string | null;
  /** Only an ORDINARY replenishment SKU has a requirement to offset. */
  readonly eligible: boolean;
  readonly entry: LocalMakeEntry | null;
  readonly horizonWeeks: number;
}

const notEvaluated = (reason: string, gross: number | null): LocalMakeResult => ({ status: "NOT EVALUATED", reason, gross, localCounted: 0, residualImport: null, entry: null, label: null });
const blocked = (reason: string, gross: number | null, entry: LocalMakeEntry | null): LocalMakeResult => ({ status: "BLOCKED", reason, gross, localCounted: 0, residualImport: null, entry, label: entry ? LOCAL_MAKE_LABEL : null });

export function validateLocalMake(e: LocalMakeEntry): string | null {
  const whole = (v: number) => Number.isInteger(v) && v >= 0;
  if (!whole(e.quantity) || !whole(e.capacityUnits)) return "Quantity and capacity must be whole numbers of 0 or more.";
  if (!whole(e.leadTimeWeeks) || e.leadTimeWeeks > 52) return "Lead time must be a whole number of weeks from 0 to 52.";
  if (!Number.isInteger(e.completionWeek) || e.completionWeek < 1 || e.completionWeek > 52) return "Completion week must be a whole number from 1 to 52.";
  return null;
}

export function localMakeOffset(i: LocalMakeInput): LocalMakeResult {
  if (!i.eligible) return notEvaluated("Not an ordinary replenishment SKU (tender, or not yet classified): there is no import requirement to offset.", i.gross);
  if (i.gross === null) return notEvaluated("There is no calculated requirement for this SKU.", i.gross);
  if (i.source !== null && /^import$/i.test(i.source.trim())) return blocked("Items marks this SKU as import-only: a local make cannot offset it.", i.gross, i.entry);
  if (i.entry === null) return notEvaluated("No local-production data is supplied: capacity, lead time and quantity are not in the workbook, and none is invented.", i.gross);
  const bad = validateLocalMake(i.entry);
  if (bad !== null) return blocked(bad, i.gross, i.entry);
  const e = i.entry;
  if (e.completionWeek < e.leadTimeWeeks) return blocked("The expected completion week is earlier than the production lead time.", i.gross, e);
  const base = { gross: i.gross, entry: e, label: LOCAL_MAKE_LABEL, status: "EVALUATED" as const };
  if (e.completionWeek > i.horizonWeeks) return { ...base, reason: `Completes in week ${e.completionWeek}, after the ${i.horizonWeeks}-week horizon: not counted.`, localCounted: 0, residualImport: i.gross };
  const usable = Math.min(e.quantity, e.capacityUnits);
  const counted = Math.min(usable, i.gross);
  const notes = [e.quantity > e.capacityUnits ? `Quantity ${e.quantity} exceeds capacity ${e.capacityUnits}: only ${e.capacityUnits} is usable.` : null, usable > i.gross ? "More than the requirement: only the requirement is counted." : null].filter(Boolean);
  return { ...base, reason: notes.length > 0 ? notes.join(" ") : null, localCounted: counted, residualImport: i.gross - counted };
}
