import type { QuoteDraft } from "@/newquip/grower/draft";

// ESTIMATOR HANDOVER (pure). When an Estimator's save changes a customer-facing amount, the quotation goes back to the Rep with the customer's confirmation withdrawn. This module says WHICH
// customer-facing inputs changed between the saved draft before and after that save (selling prices and delivery / installation charges only: supplier costs, mappings and cost overrides
// are deliberately not looked at, because they never change what the customer pays).

export interface AmountChange { key: string; kind: "line price" | "charge"; before: number | null; after: number | null }

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function describeAmountChanges(before: QuoteDraft, after: QuoteDraft): AmountChange[] {
  const out: AmountChange[] = [];
  const keys = (a: object, b: object) => [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const bRes = before.estimator.priceResolutions ?? {}, aRes = after.estimator.priceResolutions ?? {};
  for (const k of keys(bRes, aRes)) {
    const x = num((bRes as Record<string, { unitPriceExVat?: number } | undefined>)[k]?.unitPriceExVat), y = num((aRes as Record<string, { unitPriceExVat?: number } | undefined>)[k]?.unitPriceExVat);
    if (x !== y) out.push({ key: k, kind: "line price", before: x, after: y });
  }
  const bUp = before.estimator.unitPrices ?? {}, aUp = after.estimator.unitPrices ?? {};
  for (const k of keys(bUp, aUp)) {
    const x = num((bUp as Record<string, unknown>)[k]), y = num((aUp as Record<string, unknown>)[k]);
    if (x !== y) out.push({ key: k, kind: "line price", before: x, after: y });
  }
  const bCh = before.estimator.charges ?? {}, aCh = after.estimator.charges ?? {};
  for (const k of keys(bCh, aCh)) {
    const x = num((bCh as Record<string, unknown>)[k]), y = num((aCh as Record<string, unknown>)[k]);
    if (x !== y) out.push({ key: k, kind: "charge", before: x, after: y });
  }
  return out;
}
