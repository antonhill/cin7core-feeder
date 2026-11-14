import type { QuoteDraft } from "../grower/draft";
import type { QuoteEvaluation } from "../grower/evaluate";
import { changeStampLabel, stampsSince, type ChangeStamps } from "./change-stamps";
import { completenessOf, type PricingCompleteness } from "./pricing-feedback";
import { currentPricingRuleSet } from "./rule-set";
import type { IndicativeSnapshot, SnapshotCharge, SnapshotLine } from "./indicative-snapshot";

// ORIGINAL INDICATIVE PRICE VERSUS CURRENT PRICE, for the Estimator (NQ-008A). Pure. It compares the immutable snapshot taken at handoff with a fresh evaluation of the
// draft as it stands now, line by line, and says why and who. It decides nothing, changes nothing and does no pricing of its own: every figure is read from the snapshot or
// from the existing engine's evaluation. A line that is not priced is "not priced", never 0.
//
// Visible to cost-entitled viewers only (the page and the server both enforce that). It carries SELLING figures and attribution, never a cost.

export interface ComparisonSide { quantity: number | null; unitPriceExVat: number | null; revenueCents: number | null; status: string }
export interface LineChange { label: string; by: string; at: string }
export interface ComparisonRow {
  key: string;
  kind: "line" | "charge";
  label: string;
  original: ComparisonSide | null;
  current: ComparisonSide | null;
  /** current - original in cents, counting an unpriced side as 0 contribution to the TOTAL (the side itself stays "not priced"). */
  deltaCents: number;
  changed: boolean;
  /** Why it differs, from reasons already recorded on the quotation. "No reason recorded" when none exists. */
  reasons: string[];
  /** Who last changed an input that feeds this row, and when. Empty when the change was not attributed (see `attributionNote`). */
  changes: LineChange[];
}

export type ComparisonBasis = "snapshot" | "amount_only" | "none";
export interface IndicativeComparison {
  basis: ComparisonBasis;
  /** Plain-language limitation, set when the comparison is partial or unavailable. */
  note: string | null;
  capturedAt: string | null;
  capturedBy: string | null;
  originalTotalCents: number | null;
  currentTotalCents: number | null;
  deltaCents: number | null;
  originalCompleteness: PricingCompleteness | null;
  currentCompleteness: PricingCompleteness;
  /** Differences in the CALCULATION BASIS itself (rule version, price source, quotation type) - a price can move for these reasons without anyone editing the quote. */
  basisChanges: string[];
  rows: ComparisonRow[];
  /** Every attributed change since the handoff, including ones that feed no single row (layout, quotation type). */
  recordedChanges: LineChange[];
  /** Every earlier handoff of this quotation (oldest first), customer-safe facts only. A quotation returned to the Rep and handed off again has more than one. */
  history: HandoffHistoryEntry[];
}
export interface HandoffHistoryEntry { seq: number; revision: number; capturedAt: string; capturedBy: string; totalCents: number; completeness: PricingCompleteness }

const NO_REASON = "No reason recorded";
const cents = (r: number | null | undefined): number | null => (r == null || !Number.isFinite(r) ? null : Math.round(r * 100));

function sideOfLine(l: { status: string; quantity: number | null; unitPriceExVat: number | null; revenueCents: number | null }): ComparisonSide {
  return { quantity: l.quantity, unitPriceExVat: l.unitPriceExVat, revenueCents: l.revenueCents, status: l.status };
}
const sameSide = (a: ComparisonSide | null, b: ComparisonSide | null): boolean =>
  !!a && !!b && a.status === b.status && a.quantity === b.quantity && a.unitPriceExVat === b.unitPriceExVat && a.revenueCents === b.revenueCents;

function currentLines(ev: QuoteEvaluation): { lines: (SnapshotLine & { reason: string })[]; charges: SnapshotCharge[]; subtotalCents: number } {
  const b = ev.budget;
  if (!b) return { lines: [], charges: [], subtotalCents: 0 };
  return {
    lines: b.lines.map((l) => ({
      itemKey: l.itemKey, label: l.label, status: l.status, sku: l.sku, quantity: l.quantity,
      unitPriceExVat: l.status === "priced" ? l.unitPrice : null, revenueCents: l.status === "priced" ? cents(l.revenueExTax) : null, pricedBy: l.pricedBy, reason: l.reason,
    })),
    charges: b.charges.map((c) => ({ key: c.key, label: c.label, amountCents: c.amountExTax == null ? null : cents(c.amountExTax), status: c.status })),
    subtotalCents: Math.round(b.totals.subtotalExTax * 100),
  };
}

/** Reasons the quotation already records for a line's current figures. Nothing is invented. */
function reasonsFor(itemKey: string, status: string, statusReason: string, draft: QuoteDraft): string[] {
  const out: string[] = [];
  const res = (draft.estimator.priceResolutions as Record<string, { reason?: string } | undefined>)[itemKey];
  if (res?.reason?.trim() && status === "priced") out.push(`Estimator price: ${res.reason.trim()}`);
  const ov = (draft.config.quantityOverrideReasons as Record<string, string | undefined> | undefined)?.[itemKey];
  if ((draft.config.quantityOverrides as Record<string, number | undefined> | undefined)?.[itemKey] !== undefined && ov?.trim()) out.push(`Quantity override: ${ov.trim()}`);
  const ex = (draft.config.exclusions as Record<string, string | undefined> | undefined)?.[itemKey];
  if (ex?.trim()) out.push(`Excluded: ${ex.trim()}`);
  if (status !== "priced" && status !== "not_selected" && statusReason.trim()) out.push(statusReason.trim());
  return out;
}

export interface ComparisonInput {
  /** The immutable snapshot of the CURRENT handoff, or null when none was captured (a handoff made before capture existed). */
  snapshot: IndicativeSnapshot | null;
  snapshotCapturedAt: string | null;
  snapshotCapturedBy: string | null;
  /** The amount the customer confirmed at handoff - the fallback original when no snapshot exists. */
  confirmedCents: number | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  /** The revision the SNAPSHOT was taken in (not the quotation's current revision: a price change that sends the quotation back to the Rep bumps the latter). Selects which change stamps apply. */
  revision: number;
  draft: QuoteDraft;
  currentEvaluation: QuoteEvaluation;
  history?: HandoffHistoryEntry[];
}

export function compareToIndicative(i: ComparisonInput): IndicativeComparison {
  const cur = currentLines(i.currentEvaluation);
  const currentCompleteness = completenessOf(i.currentEvaluation.budget);
  const currentTotalCents = i.currentEvaluation.budget ? cur.subtotalCents : null;

  if (!i.snapshot) {
    const has = i.confirmedCents != null;
    return {
      basis: has ? "amount_only" : "none",
      note: has
        ? "No indicative price snapshot was captured for this quotation (it was handed off before capture existed), so only the amount the customer confirmed is available. Line-by-line comparison is not possible."
        : "This quotation has not been handed to the Estimator, so there is no indicative price to compare with.",
      capturedAt: i.confirmedAt, capturedBy: i.confirmedBy,
      originalTotalCents: i.confirmedCents, currentTotalCents,
      deltaCents: has && currentTotalCents != null ? currentTotalCents - i.confirmedCents! : null,
      originalCompleteness: null, currentCompleteness, basisChanges: [], rows: [], recordedChanges: [], history: i.history ?? [],
    };
  }

  const snap = i.snapshot;
  const capturedAt = i.snapshotCapturedAt ?? new Date(0).toISOString();
  const stamps: ChangeStamps = stampsSince(i.draft.estimator.changeStamps, i.revision, capturedAt);
  const stampOf = (key: string): LineChange[] => (stamps[key] ? [{ label: changeStampLabel(key), by: stamps[key].by, at: stamps[key].at }] : []);
  const resStamp = (itemKey: string): LineChange[] => {
    const r = (i.draft.estimator.priceResolutions as Record<string, { by?: string; at?: string } | undefined>)[itemKey];
    return r?.by && r?.at && Date.parse(r.at) >= Date.parse(capturedAt) ? [{ label: "Estimator price", by: r.by, at: r.at }] : [];
  };

  const rows: ComparisonRow[] = [];
  const origLines = new Map(snap.customerSafe.lines.map((l) => [l.itemKey, l]));
  const curLines = new Map(cur.lines.map((l) => [l.itemKey, l]));
  for (const key of new Set([...origLines.keys(), ...curLines.keys()])) {
    const o = origLines.get(key) ?? null;
    const c = curLines.get(key) ?? null;
    const original = o ? sideOfLine(o) : null;
    const current = c ? sideOfLine(c) : null;
    const changed = !sameSide(original, current);
    const label = (c ?? o)!.label;
    const why = changed ? reasonsFor(key, current?.status ?? "unmapped", c?.reason ?? "", i.draft) : [];
    rows.push({
      key, kind: "line", label, original, current,
      deltaCents: (current?.revenueCents ?? 0) - (original?.revenueCents ?? 0),
      changed,
      reasons: changed ? (why.length ? why : [NO_REASON]) : [],
      changes: changed ? [
        ...resStamp(key),
        ...["estimatorQuantities", "quantityOverrides", "exclusions", "optionalEquipment", "confirmedMappings", "unitPrices"].flatMap((p) => stampOf(`${p}.${key}`)),
      ] : [],
    });
  }
  const origCharges = new Map(snap.customerSafe.charges.map((c) => [c.key, c]));
  const curCharges = new Map(cur.charges.map((c) => [c.key, c]));
  for (const key of new Set([...origCharges.keys(), ...curCharges.keys()])) {
    const o = origCharges.get(key) ?? null;
    const c = curCharges.get(key) ?? null;
    const side = (x: SnapshotCharge | null): ComparisonSide | null => (x ? { quantity: x.amountCents == null ? null : 1, unitPriceExVat: x.amountCents == null ? null : x.amountCents / 100, revenueCents: x.amountCents, status: x.amountCents == null ? "required" : "entered" } : null);
    const original = side(o);
    const current = side(c);
    const changed = !sameSide(original, current);
    rows.push({
      key: `charge:${key}`, kind: "charge", label: (c ?? o)!.label, original, current,
      deltaCents: (current?.revenueCents ?? 0) - (original?.revenueCents ?? 0), changed,
      reasons: changed ? [NO_REASON] : [], // delivery / installation amounts are Estimator-entered figures with no reason field today (a reason field is NQ-008B scope)
      changes: changed ? stampOf(`charges.${key}`) : [],
    });
  }

  const basisChanges: string[] = [];
  const rs = currentPricingRuleSet();
  if (snap.internal.ruleSet.version !== rs.version) basisChanges.push(`Pricing rules changed: ${snap.internal.ruleSet.version} at handoff, ${rs.version} now.`);
  const curSource = i.currentEvaluation.budget?.priceSource;
  if (curSource && (curSource.id !== snap.internal.priceSource.id || curSource.provenance !== snap.internal.priceSource.provenance)) basisChanges.push("The price source changed since handoff, so prices can differ even for unedited lines.");
  if (i.currentEvaluation.budget && i.currentEvaluation.budget.quoteType !== snap.customerSafe.quoteType) basisChanges.push(`Quotation type changed: ${snap.customerSafe.quoteType} at handoff, ${i.currentEvaluation.budget.quoteType} now.`);

  const recordedChanges = Object.entries(stamps).map(([k, v]) => ({ label: changeStampLabel(k), by: v.by, at: v.at })).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return {
    basis: "snapshot", note: null, capturedAt: i.snapshotCapturedAt, capturedBy: i.snapshotCapturedBy,
    originalTotalCents: snap.customerSafe.subtotalCents, currentTotalCents,
    deltaCents: currentTotalCents == null ? null : currentTotalCents - snap.customerSafe.subtotalCents,
    originalCompleteness: snap.customerSafe.completeness, currentCompleteness, basisChanges, rows, recordedChanges, history: i.history ?? [],
  };
}
