import type { IndicativeSnapshot } from "../pricing/indicative-snapshot";

// WHAT CHANGED SINCE THE REP LAST CONFIRMED (Rep revision comparison). Pure; no I/O, no clock, no arithmetic on cost.
//
// "Then" is the immutable customer-safe section the handoff captured (newquip_indicative_price_snapshots, migration 0123: written in the same transaction as the Rep's submission, never recalculated).
// "Now" is the current draft evaluated by the SAME function (customerSafeSectionOf) with cost withheld. Both are inputs here; this module only lines them up by item key and states the differences.
//
// CONFIDENTIALITY BY CONSTRUCTION: the output type below is a WHITELIST. It carries label, quantity, selling unit price, selling line total and totals, and nothing else: the snapshot's `sku`,
// `pricedBy`, `awaiting` and its whole `internal` section are never read, so nothing confidential can reach a Rep through this module, whatever the stored row holds.

type CustomerSafe = IndicativeSnapshot["customerSafe"];
export type ChangeKind = "added" | "removed" | "changed" | "unchanged";

/**
 * How the line was priced, exactly as stored: "unit" = a selling unit price AND a line total; "package" = a line total with NO unit price stored (a package priced from its components has no unit
 * price of its own, and its quantity is not a unit of sale); "none" = not priced. A unit price is never derived from the total and the quantity: that would invent a figure for a package.
 */
export type PriceBasis = "unit" | "package" | "none";
export interface RepLineValues { label: string; quantity: number | null; unitPriceCents: number | null; lineTotalCents: number | null; priced: boolean; basis: PriceBasis }
export interface RepLineChange {
  key: string;
  kind: ChangeKind;
  /** What differs, in the Rep's words: "Quantity", "Selling unit price", "Selling line total", "Equipment selection", "Price status". Empty unless kind is "changed". */
  fields: string[];
  before: RepLineValues | null;
  after: RepLineValues | null;
  /** Line-total difference in cents (after - before; a missing side counts as 0). Null when either side is unpriced and so no honest difference exists. */
  deltaCents: number | null;
}
export interface RepChargeChange { key: string; label: string; kind: ChangeKind; beforeCents: number | null; afterCents: number | null; deltaCents: number | null }

export interface RepTotalsView { subtotalExVatCents: number; vatCents: number; totalIncVatCents: number }
export type RepChangesUnavailable = "NO_SNAPSHOT" | "REVISION_GAP" | "NOT_PRICED";

export interface RepRevisionChanges {
  available: boolean;
  /** Why no itemised comparison exists (older revisions, or nothing priced). The total change is still shown where both totals are known. */
  unavailableReason?: RepChangesUnavailable;
  /** The pair compared, so a screen can show that it is the quotation now being reconfirmed and not a stale one. */
  basis: { previousRevision: number | null; previousCapturedAt: string | null; currentRevision: number; currentDraftHash: string };
  lines: RepLineChange[];
  charges: RepChargeChange[];
  before: RepTotalsView | null;
  after: RepTotalsView | null;
  /** ex VAT difference in cents and in percent of the previous ex VAT total (null when the previous total is zero or unknown). */
  deltaExVatCents: number | null;
  deltaPercent: number | null;
  counts: { added: number; removed: number; changed: number; unchanged: number; charges: number };
  /** True when at least one customer-facing value differs. False => "No customer-facing quotation changes detected". */
  anyChange: boolean;
}

const totalsOf = (c: CustomerSafe): RepTotalsView => ({ subtotalExVatCents: c.subtotalCents, vatCents: c.taxCents, totalIncVatCents: c.totalCents });
// A unit price is stored in rand (a float); compare in whole cents so formatting or float noise is never a change.
const unitCents = (r: number | null | undefined): number | null => (r == null || !Number.isFinite(r) ? null : Math.round(r * 100));
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function valuesOf(l: CustomerSafe["lines"][number]): RepLineValues {
  const priced = l.status === "priced" && l.revenueCents != null;
  const unit = priced ? unitCents(l.unitPriceExVat) : null;
  return { label: norm(l.label), quantity: l.quantity ?? null, unitPriceCents: unit, lineTotalCents: priced ? l.revenueCents : null, priced, basis: !priced ? "none" : unit != null ? "unit" : "package" };
}

/** Selected lines only: a "not_selected" line is not on the quotation, whichever side it is on. Keyed by the stable item key, so display order never matters. */
function selected(c: CustomerSafe): Map<string, RepLineValues> {
  const m = new Map<string, RepLineValues>();
  for (const l of c.lines) if (l.status !== "not_selected") m.set(l.itemKey, valuesOf(l));
  return m;
}

function diffFields(a: RepLineValues, b: RepLineValues): string[] {
  const f: string[] = [];
  if (a.label !== b.label) f.push("Equipment selection");
  if (a.quantity !== b.quantity) f.push("Quantity");
  if (a.priced !== b.priced) f.push("Price status");
  if (a.unitPriceCents !== b.unitPriceCents) f.push("Selling unit price");
  if (a.lineTotalCents !== b.lineTotalCents) f.push("Selling line total");
  return f;
}

const order: Record<ChangeKind, number> = { added: 0, removed: 1, changed: 2, unchanged: 3 };

export function compareRepRevisions(i: {
  previous: CustomerSafe | null;
  previousCapturedAt: string | null;
  /** The current customer-safe section, or null when nothing is priced now. */
  current: CustomerSafe | null;
  currentRevision: number;
  currentDraftHash: string;
}): RepRevisionChanges {
  const basisOf = (): RepRevisionChanges["basis"] => ({ previousRevision: i.previous?.revision ?? null, previousCapturedAt: i.previousCapturedAt, currentRevision: i.currentRevision, currentDraftHash: i.currentDraftHash });
  const empty = (reason: RepChangesUnavailable): RepRevisionChanges => ({
    available: false, unavailableReason: reason, basis: basisOf(), lines: [], charges: [],
    before: i.previous ? totalsOf(i.previous) : null, after: i.current ? totalsOf(i.current) : null,
    deltaExVatCents: i.previous && i.current ? i.current.subtotalCents - i.previous.subtotalCents : null,
    deltaPercent: i.previous && i.current && i.previous.subtotalCents !== 0 ? pct(i.current.subtotalCents - i.previous.subtotalCents, i.previous.subtotalCents) : null,
    counts: { added: 0, removed: 0, changed: 0, unchanged: 0, charges: 0 }, anyChange: false,
  });
  if (!i.current) return empty("NOT_PRICED");
  if (!i.previous) return empty("NO_SNAPSHOT");

  const was = selected(i.previous);
  const now = selected(i.current);
  const keys = [...new Set([...was.keys(), ...now.keys()])];
  const lines: RepLineChange[] = keys.map((key) => {
    const b = was.get(key) ?? null; const a = now.get(key) ?? null;
    if (!b && a) return { key, kind: "added" as const, fields: [], before: null, after: a, deltaCents: a.lineTotalCents };
    if (b && !a) return { key, kind: "removed" as const, fields: [], before: b, after: null, deltaCents: b.lineTotalCents == null ? null : -b.lineTotalCents };
    const fields = diffFields(b!, a!);
    const delta = b!.lineTotalCents != null && a!.lineTotalCents != null ? a!.lineTotalCents - b!.lineTotalCents : null;
    return { key, kind: fields.length ? ("changed" as const) : ("unchanged" as const), fields, before: b, after: a, deltaCents: fields.length ? delta : 0 };
  }).sort((x, y) => order[x.kind] - order[y.kind] || (x.after?.label ?? x.before?.label ?? "").localeCompare(y.after?.label ?? y.before?.label ?? "") || x.key.localeCompare(y.key));

  const chargeKeys = [...new Set([...i.previous.charges.map((c) => c.key), ...i.current.charges.map((c) => c.key)])];
  const charges: RepChargeChange[] = chargeKeys.map((key) => {
    const b = i.previous!.charges.find((c) => c.key === key); const a = i.current!.charges.find((c) => c.key === key);
    const beforeCents = b?.amountCents ?? null; const afterCents = a?.amountCents ?? null;
    const kind: ChangeKind = beforeCents === afterCents && !!b === !!a ? "unchanged" : !b ? "added" : !a ? "removed" : "changed";
    return { key, label: norm((a ?? b)!.label), kind, beforeCents, afterCents, deltaCents: beforeCents != null && afterCents != null ? afterCents - beforeCents : afterCents ?? (beforeCents == null ? null : -beforeCents) };
  }).sort((x, y) => order[x.kind] - order[y.kind] || x.label.localeCompare(y.label));

  const before = totalsOf(i.previous); const after = totalsOf(i.current);
  const deltaExVatCents = after.subtotalExVatCents - before.subtotalExVatCents;
  const counts = {
    added: lines.filter((l) => l.kind === "added").length, removed: lines.filter((l) => l.kind === "removed").length,
    changed: lines.filter((l) => l.kind === "changed").length, unchanged: lines.filter((l) => l.kind === "unchanged").length,
    charges: charges.filter((c) => c.kind !== "unchanged").length,
  };
  const anyChange = counts.added + counts.removed + counts.changed + counts.charges > 0 || deltaExVatCents !== 0 || before.totalIncVatCents !== after.totalIncVatCents;
  return { available: true, basis: basisOf(), lines, charges, before, after, deltaExVatCents, deltaPercent: before.subtotalExVatCents !== 0 ? pct(deltaExVatCents, before.subtotalExVatCents) : null, counts, anyChange };
}

/** Percent to one decimal (display only). */
function pct(delta: number, base: number): number { return Math.round((delta / Math.abs(base)) * 1000) / 10; }

/**
 * The snapshot that stands for "the quotation the Rep last confirmed". Snapshots are appended at every handoff (oldest first). A quotation returned N times has handoff snapshots at each
 * earlier revision; the one that matters is the latest taken BEFORE the current revision. `gap` is true when that is not the revision immediately before (a handoff happened with no
 * snapshot, e.g. before capture existed): the comparison is then not a reliable "what changed" and the screen says so instead of presenting it.
 */
export function previousHandoffOf<T extends { revision: number; seq: number }>(snapshots: readonly T[], currentRevision: number): { snapshot: T | null; gap: boolean } {
  const earlier = snapshots.filter((s) => s.revision < currentRevision);
  if (earlier.length === 0) return { snapshot: null, gap: false };
  const last = earlier.reduce((m, s) => (s.seq > m.seq ? s : m));
  return { snapshot: last, gap: last.revision !== currentRevision - 1 };
}
