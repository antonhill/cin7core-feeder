import { normaliseQuoteStatus, type QuoteStatus } from "@/rwtsa-demo/contracts/quote-status";
import type { RwtsaDataset } from "@/rwtsa-demo/dataset";
import { toCents, type Cents } from "./money";

/**
 * Scenario D: quote conversion and win/loss analytics. Pure functions over the validated dataset's Quotes (and, for
 * cross-checks only, Customers and Items). No I/O, no network.
 *
 *   Closed quotes          = WON + LOST            (OPEN and UNCLASSIFIED are never in a denominator)
 *   Count conversion %     = WON count / closed count x 100
 *   Value conversion %     = WON value / closed value x 100   (integer cents, never floating-point money)
 *
 * With no closed quotes (or no closed value) the rate is null, shown as N/A, never 0%. Nothing is invented: a missing lost
 * reason, a missing sales-order reference, an unrecognised status or an unusable value is reported and the analysis is
 * marked incomplete.
 */

export type { QuoteStatus };
export type Grain = "month" | "quarter" | "year";

export type IssueCode =
  | "unclassified_status"
  | "lost_reason_missing"
  | "conversion_ref_missing"
  | "order_ref_on_non_won"
  | "order_ref_duplicate"
  | "value_invalid"
  | "duplicate_quote"
  | "customer_not_in_master"
  | "rep_missing"
  | "rep_conflict"
  | "date_missing"
  | "product_unmatched";

export const ISSUE_LABELS: Readonly<Record<IssueCode, string>> = {
  unclassified_status: "Status not recognised (UNCLASSIFIED, excluded from every conversion rate)",
  lost_reason_missing: "LOST quote with no reason (excluded from a complete win/loss claim)",
  conversion_ref_missing: "WON quote with no converted sales-order reference (conversion record incomplete)",
  order_ref_on_non_won: "Sales-order reference on a quote that is not WON (not treated as a conversion)",
  order_ref_duplicate: "The same sales-order reference appears on more than one WON quote",
  value_invalid: "Quote value missing, negative or not a number (left out of value totals)",
  duplicate_quote: "Duplicate quote number (the first is analysed, later ones are excluded)",
  customer_not_in_master: "Customer not found in the Customers tab",
  rep_missing: "No sales representative on the quote (shown as unassigned)",
  rep_conflict: "Quote representative differs from the Customers tab representative",
  date_missing: "No quote date (left out of period filters, shown as no date in period analysis)",
  product_unmatched: "Product reference not found among Items style codes or SKUs",
};
export const ISSUE_CODES = Object.keys(ISSUE_LABELS) as IssueCode[];

export const UNASSIGNED = "(unassigned)";
export const NO_DATE = "(no date)";

export interface QuoteRecord {
  readonly ref: string;
  readonly customer: string;
  readonly customerKnown: boolean;
  readonly rep: string | null;
  readonly status: QuoteStatus;
  /** The status text as supplied (trimmed). */
  readonly rawStatus: string;
  readonly valueCents: Cents | null;
  readonly lostReason: string | null;
  /** The original sales-order reference exactly as supplied (never generated or altered). */
  readonly convertedOrder: string | null;
  readonly date: string | null;
  readonly products: readonly string[];
  readonly issues: readonly IssueCode[];
}

export interface Metrics {
  readonly quotes: number;
  readonly won: number;
  readonly lost: number;
  readonly open: number;
  readonly unclassified: number;
  /** won + lost. */
  readonly closed: number;
  readonly wonCents: Cents;
  readonly lostCents: Cents;
  readonly openCents: Cents;
  readonly unclassifiedCents: Cents;
  /** wonCents + lostCents. */
  readonly closedCents: Cents;
  /** Quotes (any status) whose value was unusable and is therefore missing from the cents above. */
  readonly valueMissing: number;
  readonly countConversionPct: number | null;
  readonly valueConversionPct: number | null;
}
export interface GroupMetrics extends Metrics {
  readonly key: string;
}

export interface ProductMetrics {
  readonly key: string;
  /** Quotes that feature the product (a multi-product quote appears under each of its products). NOT additive across products. */
  readonly quotes: number;
  readonly won: number;
  readonly lost: number;
  readonly open: number;
  readonly unclassified: number;
  readonly closed: number;
  readonly countConversionPct: number | null;
  /** Quotes whose ONLY product is this one: the only quotes whose value can be attributed to it without splitting. */
  readonly soleQuotes: number;
  readonly wonCents: Cents;
  readonly lostCents: Cents;
  readonly closedCents: Cents;
  readonly valueConversionPct: number | null;
  /** Closed multi-product quotes featuring this product, whose value is withheld from the figures above. */
  readonly sharedClosed: number;
  /** Whether the reference matches an Items style code or SKU; null when there are no Items to compare with. */
  readonly inItems: boolean | null;
}

export interface ReasonRow {
  readonly key: string;
  readonly reason: string;
  readonly count: number;
  readonly cents: Cents;
}

export interface Check {
  readonly code: string;
  readonly label: string;
  readonly pass: boolean;
  readonly detail: string;
}

export interface QuoteOptions {
  readonly from?: string | null;
  readonly to?: string | null;
  readonly rep?: string | null;
  readonly customer?: string | null;
  readonly product?: string | null;
  readonly grain?: Grain;
}

export interface QuoteResult {
  readonly records: readonly QuoteRecord[];
  readonly total: Metrics;
  readonly byRep: readonly GroupMetrics[];
  readonly byCustomer: readonly GroupMetrics[];
  readonly byPeriod: readonly GroupMetrics[];
  readonly grain: Grain;
  readonly dateField: string;
  readonly byProduct: {
    readonly available: boolean;
    readonly reason: string | null;
    readonly rows: readonly ProductMetrics[];
    readonly multiProductQuotes: number;
    readonly noProductQuotes: number;
    readonly partial: boolean;
    readonly valueNote: string | null;
  };
  readonly reasons: {
    readonly rows: readonly ReasonRow[];
    readonly missing: { readonly count: number; readonly cents: Cents };
    readonly lostCount: number;
    readonly complete: boolean;
  };
  readonly conversion: {
    readonly withReference: number;
    readonly missingReference: number;
    readonly references: readonly { readonly quote: string; readonly order: string }[];
  };
  readonly issues: Readonly<Record<IssueCode, number>>;
  readonly issueRefs: Readonly<Record<IssueCode, readonly string[]>>;
  readonly duplicates: readonly string[];
  readonly unclassifiedValues: readonly string[];
  readonly filtered: { readonly total: number; readonly shown: number; readonly undatedExcluded: number };
  readonly options: { readonly reps: readonly string[]; readonly customers: readonly string[]; readonly products: readonly string[] };
  readonly completeness: {
    readonly complete: boolean;
    readonly winLossComplete: boolean;
    readonly conversionComplete: boolean;
    readonly valuesComplete: boolean;
    readonly reasons: readonly string[];
    readonly notes: readonly string[];
  };
  readonly checks: readonly Check[];
  readonly assumptions: readonly { readonly id: string; readonly text: string }[];
  readonly warnings: readonly string[];
}

const MAX_REFS = 50;
const fold = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();
const collapse = (s: string): string => s.trim().replace(/\s+/g, " ");
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const pct = (n: number, d: number): number | null => (d > 0 ? (n * 100) / d : null);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function periodKey(date: string | null, grain: Grain): string {
  if (date === null || !ISO.test(date)) return NO_DATE;
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  return grain === "year" ? y : grain === "quarter" ? `${y}-Q${Math.floor((m - 1) / 3) + 1}` : `${y}-${date.slice(5, 7)}`;
}

function splitProducts(raw: string | null): string[] {
  if (raw === null) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[;|\n]/)) {
    const p = collapse(part);
    if (p === "" || seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    out.push(p);
  }
  return out;
}

const SUM_KEYS = ["quotes", "won", "lost", "open", "unclassified", "wonCents", "lostCents", "openCents", "unclassifiedCents"] as const;
function sumOfGroups(rows: readonly Metrics[]): Record<(typeof SUM_KEYS)[number], number> {
  return Object.fromEntries(SUM_KEYS.map((k) => [k, rows.reduce((a, r) => a + r[k], 0)])) as Record<(typeof SUM_KEYS)[number], number>;
}
/** True only when the groups add back to the overall totals on every count and every amount. An empty list never reconciles a non-empty total. */
export function reconcileGroups(rows: readonly Metrics[], total: Metrics): boolean {
  const s = sumOfGroups(rows);
  return SUM_KEYS.every((k) => s[k] === total[k]);
}

/** A reconciliation line for the page: pass/fail is computed from the same sums it shows. */
export function groupCheck(code: string, label: string, rows: readonly Metrics[], total: Metrics): Check {
  const s = sumOfGroups(rows);
  return { code, label, pass: reconcileGroups(rows, total), detail: `${s.quotes} of ${total.quotes} quotes; won ${s.wonCents} of ${total.wonCents} cents; lost ${s.lostCents} of ${total.lostCents} cents` };
}

class Acc {
  quotes = 0; won = 0; lost = 0; open = 0; unclassified = 0;
  wonCents = 0; lostCents = 0; openCents = 0; unclassifiedCents = 0; valueMissing = 0;
  add(q: QuoteRecord): void {
    this.quotes++;
    const c = q.valueCents ?? 0;
    if (q.valueCents === null) this.valueMissing++;
    if (q.status === "WON") { this.won++; this.wonCents += c; }
    else if (q.status === "LOST") { this.lost++; this.lostCents += c; }
    else if (q.status === "OPEN") { this.open++; this.openCents += c; }
    else { this.unclassified++; this.unclassifiedCents += c; }
  }
  done(): Metrics {
    const closed = this.won + this.lost;
    const closedCents = this.wonCents + this.lostCents;
    return {
      quotes: this.quotes, won: this.won, lost: this.lost, open: this.open, unclassified: this.unclassified, closed,
      wonCents: this.wonCents, lostCents: this.lostCents, openCents: this.openCents, unclassifiedCents: this.unclassifiedCents, closedCents,
      valueMissing: this.valueMissing,
      countConversionPct: pct(this.won, closed),
      valueConversionPct: pct(this.wonCents, closedCents),
    };
  }
}

function groupBy(records: readonly QuoteRecord[], keyOf: (q: QuoteRecord) => string, special: string): GroupMetrics[] {
  const m = new Map<string, { label: string; acc: Acc }>();
  for (const q of records) {
    const label = keyOf(q);
    const k = label === special ? label : fold(label);
    let g = m.get(k);
    if (!g) m.set(k, (g = { label, acc: new Acc() }));
    g.acc.add(q);
  }
  return [...m.values()]
    .sort((a, b) => (a.label === special ? 1 : b.label === special ? -1 : cmp(a.label, b.label)))
    .map((g) => ({ key: g.label, ...g.acc.done() }));
}

export function runQuoteConversion(ds: RwtsaDataset, opts: QuoteOptions = {}): QuoteResult {
  const grain: Grain = opts.grain ?? "month";
  const { quotes, customers, items } = ds.tables;
  const masterNames = new Set(customers.map((c) => fold(c.customer)));
  const masterRep = new Map<string, string>();
  for (const c of customers) if (c.rep !== null && c.rep.trim() !== "" && !masterRep.has(fold(c.customer))) masterRep.set(fold(c.customer), fold(c.rep));
  const itemRefs = new Set(items.flatMap((i) => [fold(i.styleCode), fold(i.sku)]));

  // 1. Build records, dropping later duplicates of a quote number (first wins).
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const all: { rec: Omit<QuoteRecord, "issues">; issues: IssueCode[] }[] = [];
  for (const q of quotes) {
    const key = fold(q.quoteNo);
    if (seen.has(key)) {
      if (!duplicates.includes(key)) duplicates.push(key);
      continue;
    }
    seen.add(key);
    const status = normaliseQuoteStatus(q.status);
    const valueCents = typeof q.value === "number" && Number.isFinite(q.value) && q.value >= 0 ? toCents(q.value) : null;
    const reason = typeof q.lostReason === "string" && q.lostReason.trim() !== "" ? collapse(q.lostReason) : null;
    const order = typeof q.convertedOrder === "string" && q.convertedOrder.trim() !== "" ? q.convertedOrder : null;
    const rep = typeof q.rep === "string" && q.rep.trim() !== "" ? q.rep.trim() : null;
    const customer = q.customer.trim();
    const date = typeof q.quoteDate === "string" && ISO.test(q.quoteDate) ? q.quoteDate : null;
    const products = splitProducts(q.product);
    const customerKnown = masterNames.size === 0 || masterNames.has(fold(customer));
    const issues: IssueCode[] = [];
    if (status === "UNCLASSIFIED") issues.push("unclassified_status");
    if (status === "LOST" && reason === null) issues.push("lost_reason_missing");
    if (status === "WON" && order === null) issues.push("conversion_ref_missing");
    if ((status === "OPEN" || status === "LOST") && order !== null) issues.push("order_ref_on_non_won");
    if (valueCents === null) issues.push("value_invalid");
    if (!customerKnown) issues.push("customer_not_in_master");
    if (rep === null) issues.push("rep_missing");
    const mr = masterRep.get(fold(customer));
    if (rep !== null && mr !== undefined && fold(rep) !== mr) issues.push("rep_conflict");
    if (date === null) issues.push("date_missing");
    if (itemRefs.size > 0 && products.some((p) => !itemRefs.has(p.toLowerCase()))) issues.push("product_unmatched");
    all.push({ rec: { ref: q.quoteNo.trim(), customer, customerKnown, rep, status, rawStatus: typeof q.status === "string" ? q.status.trim() : "", valueCents, lostReason: reason, convertedOrder: order, date, products }, issues });
  }
  // The same sales-order reference on several WON quotes (across the whole data set).
  const orderUse = new Map<string, number>();
  for (const { rec } of all) if (rec.status === "WON" && rec.convertedOrder !== null) orderUse.set(fold(rec.convertedOrder), (orderUse.get(fold(rec.convertedOrder)) ?? 0) + 1);
  for (const { rec, issues } of all) if (rec.status === "WON" && rec.convertedOrder !== null && (orderUse.get(fold(rec.convertedOrder)) ?? 0) > 1) issues.push("order_ref_duplicate");
  const everyRecord: QuoteRecord[] = all.map(({ rec, issues }) => ({ ...rec, issues }));

  // 2. Options always come from the whole data set, so a filter never hides the way back.
  const repLabel = (q: QuoteRecord): string => q.rep ?? UNASSIGNED;
  const uniq = (xs: string[], special?: string): string[] => {
    const m = new Map<string, string>();
    for (const x of xs) if (!m.has(fold(x))) m.set(fold(x), x);
    return [...m.values()].sort((a, b) => (a === special ? 1 : b === special ? -1 : cmp(a, b)));
  };
  const options = {
    reps: uniq(everyRecord.map(repLabel), UNASSIGNED),
    customers: uniq(everyRecord.map((q) => q.customer)),
    products: uniq(everyRecord.flatMap((q) => [...q.products])),
  };

  // 3. Filters (period inclusive on both ends; undated quotes cannot satisfy a date range).
  const dateFiltered = (opts.from ?? null) !== null || (opts.to ?? null) !== null;
  let undatedExcluded = 0;
  const records = everyRecord.filter((q) => {
    if (dateFiltered) {
      if (q.date === null) { undatedExcluded++; return false; }
      if (opts.from && q.date < opts.from) return false;
      if (opts.to && q.date > opts.to) return false;
    }
    if (opts.rep && fold(repLabel(q)) !== fold(opts.rep)) return false;
    if (opts.customer && fold(q.customer) !== fold(opts.customer)) return false;
    if (opts.product && !q.products.some((p) => fold(p) === fold(opts.product as string))) return false;
    return true;
  });

  // 4. Totals and groups.
  const totalAcc = new Acc();
  for (const q of records) totalAcc.add(q);
  const total = totalAcc.done();
  const byRep = groupBy(records, repLabel, UNASSIGNED);
  const byCustomer = groupBy(records, (q) => q.customer, "\u0000");
  const byPeriod = groupBy(records, (q) => periodKey(q.date, grain), NO_DATE);

  // 5. Win/loss reasons (LOST quotes only). A missing reason is counted separately, never given a default.
  const rmap = new Map<string, { reason: string; count: number; cents: Cents }>();
  const missing = { count: 0, cents: 0 };
  let lostCount = 0;
  for (const q of records) {
    if (q.status !== "LOST") continue;
    lostCount++;
    if (q.lostReason === null) { missing.count++; missing.cents += q.valueCents ?? 0; continue; }
    const k = fold(q.lostReason);
    const e = rmap.get(k) ?? { reason: q.lostReason, count: 0, cents: 0 };
    e.count++;
    e.cents += q.valueCents ?? 0;
    rmap.set(k, e);
  }
  const reasonRows: ReasonRow[] = [...rmap.entries()].map(([key, e]) => ({ key, ...e })).sort((a, b) => b.count - a.count || cmp(a.reason, b.reason));

  // 6. Product analysis: a quote is counted once per product it features, and its value is attributed only when it has one product.
  const withProduct = records.filter((q) => q.products.length > 0);
  const multi = records.filter((q) => q.products.length > 1).length;
  const none = records.length - withProduct.length;
  const pm = new Map<string, { key: string; count: Acc; solesAcc: Acc; sharedClosed: number }>();
  for (const q of withProduct) {
    for (const p of q.products) {
      const k = fold(p);
      const e = pm.get(k) ?? { key: p, count: new Acc(), solesAcc: new Acc(), sharedClosed: 0 };
      e.count.add(q);
      if (q.products.length === 1) e.solesAcc.add(q);
      else if (q.status === "WON" || q.status === "LOST") e.sharedClosed++;
      pm.set(k, e);
    }
  }
  const productRows: ProductMetrics[] = [...pm.entries()]
    .sort((a, b) => cmp(a[1].key, b[1].key))
    .map(([k, e]) => {
      const c = e.count.done();
      const s = e.solesAcc.done();
      return {
        key: e.key, quotes: c.quotes, won: c.won, lost: c.lost, open: c.open, unclassified: c.unclassified, closed: c.closed, countConversionPct: c.countConversionPct,
        soleQuotes: s.quotes, wonCents: s.wonCents, lostCents: s.lostCents, closedCents: s.closedCents, valueConversionPct: s.valueConversionPct, sharedClosed: e.sharedClosed,
        inItems: itemRefs.size === 0 ? null : itemRefs.has(k),
      };
    });
  const byProduct = {
    available: productRows.length > 0,
    reason: productRows.length > 0 ? null : "No quote carries a product reference, so no product analysis is possible. Nothing has been inferred.",
    rows: productRows,
    multiProductQuotes: multi,
    noProductQuotes: none,
    partial: productRows.length > 0 && none > 0,
    valueNote: productRows.length > 0 ? "Value conversion by product uses only quotes with a single product. The value of a multi-product quote is withheld, not split: the workbook has no per-product line values." : null,
  };

  // 7. Conversion references (WON only).
  const wonRecords = records.filter((q) => q.status === "WON");
  const references = wonRecords.filter((q) => q.convertedOrder !== null).map((q) => ({ quote: q.ref, order: q.convertedOrder as string }));
  const conversion = { withReference: references.length, missingReference: wonRecords.length - references.length, references };

  // 8. Issue counts and the quotes behind them.
  const issues = Object.fromEntries(ISSUE_CODES.map((c) => [c, 0])) as Record<IssueCode, number>;
  const issueRefs = Object.fromEntries(ISSUE_CODES.map((c) => [c, [] as string[]])) as Record<IssueCode, string[]>;
  for (const q of records) for (const c of q.issues) { issues[c]++; if (issueRefs[c].length < MAX_REFS) issueRefs[c].push(q.ref); }
  issues.duplicate_quote = duplicates.length;
  issueRefs.duplicate_quote = duplicates.slice(0, MAX_REFS);
  const unclassifiedValues = [...new Set(records.filter((q) => q.status === "UNCLASSIFIED").map((q) => (q.rawStatus === "" ? "(blank)" : q.rawStatus.slice(0, 40))))].slice(0, 10);

  // 9. Reconciliation: every grouping must add back to the overall totals.
  const soleSum = productRows.reduce((a, p) => a + p.soleQuotes, 0);
  const checks: Check[] = [
    { code: "status", label: "Won + lost + open + unclassified = total quotes", pass: total.won + total.lost + total.open + total.unclassified === total.quotes && total.quotes === records.length, detail: `${total.won} + ${total.lost} + ${total.open} + ${total.unclassified} = ${total.quotes}` },
    groupCheck("rep", "Representative groups add up to the total", byRep, total),
    groupCheck("customer", "Customer groups add up to the total", byCustomer, total),
    groupCheck("period", "Period groups add up to the total", byPeriod, total),
    { code: "reasons", label: "Lost reasons (plus missing) = lost quotes, by count and value", pass: reasonRows.reduce((a, r) => a + r.count, 0) + missing.count === total.lost && reasonRows.reduce((a, r) => a + r.cents, 0) + missing.cents === total.lostCents, detail: `${reasonRows.reduce((a, r) => a + r.count, 0)} + ${missing.count} missing = ${total.lost} lost` },
    { code: "product", label: "Single-product + multi-product + no-product quotes = total quotes", pass: soleSum + multi + none === total.quotes, detail: `${soleSum} + ${multi} + ${none} = ${total.quotes}` },
  ];

  // 10. Completeness: only what the loaded records support is claimed.
  const reasons: string[] = [];
  if (total.quotes === 0) reasons.push("No quotes are loaded or match the filters, so there is no analysis to claim.");
  if (issues.unclassified_status > 0) reasons.push(`${issues.unclassified_status} quote(s) have a status that is not recognised (UNCLASSIFIED); they are left out of every conversion rate.`);
  if (issues.lost_reason_missing > 0) reasons.push(`${issues.lost_reason_missing} LOST quote(s) have no reason, so the win/loss analysis is incomplete.`);
  if (issues.conversion_ref_missing > 0) reasons.push(`${issues.conversion_ref_missing} WON quote(s) have no converted sales-order reference, so their conversion records are incomplete.`);
  if (issues.value_invalid > 0) reasons.push(`${issues.value_invalid} quote(s) have no usable value, so value totals are understated.`);
  if (issues.duplicate_quote > 0) reasons.push(`${issues.duplicate_quote} duplicate quote number(s) were excluded.`);
  const notes: string[] = [];
  if (issues.date_missing > 0) notes.push(`${issues.date_missing} quote(s) have no date: period analysis is partial.`);
  if (issues.rep_missing > 0) notes.push(`${issues.rep_missing} quote(s) have no sales representative (shown as unassigned).`);
  if (issues.customer_not_in_master > 0) notes.push(`${issues.customer_not_in_master} quote(s) name a customer that is not in the Customers tab.`);
  if (byProduct.partial) notes.push(`${none} quote(s) have no product: product analysis is partial.`);
  if (issues.product_unmatched > 0) notes.push(`${issues.product_unmatched} quote(s) name a product that is not among the Items.`);
  const completeness = {
    complete: reasons.length === 0,
    winLossComplete: issues.lost_reason_missing === 0 && issues.unclassified_status === 0 && total.quotes > 0,
    conversionComplete: issues.conversion_ref_missing === 0,
    valuesComplete: issues.value_invalid === 0,
    reasons,
    notes,
  };

  const warnings = ISSUE_CODES.filter((c) => issues[c] > 0).map((c) => `${ISSUE_LABELS[c]}: ${issues[c]}`);
  const assumptions = [
    { id: "date-field", text: "Periods use the Quote date column. The workbook has no won or lost date, so a quote is attributed to the period it was quoted in, not the period it was won or lost." },
    { id: "status", text: "Status text is normalised from an explicit table (won, closed won, accepted; lost, closed lost, declined, rejected; open, pending, sent, quoted). Any other text, including a blank, is UNCLASSIFIED and is never treated as open." },
    { id: "conversion", text: "Conversion counts only WON and LOST quotes in the denominator, by count and by value (whole cents). With nothing closed the rate is N/A." },
    { id: "rep", text: "The representative on the quote is used. The Customers tab representative is never substituted; a conflict is only counted." },
    { id: "product", text: "A quote has one product cell. Several products in it may be separated by semicolons, vertical bars or new lines (not commas). A multi-product quote counts once per product for counts and is left out of product value figures." },
    { id: "reasons", text: "Lost reasons are grouped ignoring case and extra spaces. A LOST quote with no reason is shown as missing; no default reason is invented." },
    { id: "refs", text: "The converted sales-order reference is shown exactly as supplied. This demonstration does not create, check or synchronise sales orders in Cin7 Core." },
  ];

  return {
    records, total, byRep, byCustomer, byPeriod, grain, dateField: "Quote date", byProduct,
    reasons: { rows: reasonRows, missing, lostCount, complete: missing.count === 0 },
    conversion, issues, issueRefs, duplicates, unclassifiedValues,
    filtered: { total: everyRecord.length, shown: records.length, undatedExcluded },
    options, completeness, checks, assumptions, warnings,
  };
}
