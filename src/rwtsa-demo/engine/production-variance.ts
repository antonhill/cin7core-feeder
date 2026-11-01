import type { RwtsaDataset } from "@/rwtsa-demo/dataset";
import { fromCents, toCents, type Cents } from "./money";

/**
 * Scenario B production variance, per production order and aggregated by order, style, production line and order-size bracket.
 *
 *   fabric usage variance (m)     = actual quantity - planned quantity
 *   usage variance (rand)         = (actual quantity - planned quantity) x standard price
 *   fabric price variance (rand)  = actual quantity x (actual price - standard price)
 *   labour recovery %             = planned minutes / actual minutes x 100        (aggregated as total planned / total actual)
 *   labour variance (rand)        = (actual minutes - planned minutes) x cost per minute
 *
 * Positive rand variances are unfavourable (more fabric, a higher price, more minutes than planned). Nothing is invented: a
 * missing price or rate leaves that figure null and the group says how many orders it could include.
 */

export interface VarianceConfig {
  /** Ascending lower bounds of the order-size brackets after the first (which starts at 0). Default 100, 250, 500, 1000, 2500. */
  readonly bracketBreaks?: readonly number[];
}

export const DEFAULT_BRACKET_BREAKS: readonly number[] = [100, 250, 500, 1000, 2500];

export interface VarianceAssumption {
  readonly id: string;
  readonly text: string;
}
export interface VarianceCheck {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface OrderVariance {
  readonly orderNo: string;
  readonly styleCode: string;
  readonly line: string;
  readonly qty: number;
  readonly bracket: string;
  readonly plannedFabricM: number;
  readonly actualFabricM: number;
  readonly usageVarianceM: number;
  readonly standardPrice: number | null;
  readonly actualPrice: number | null;
  readonly usageVarianceCents: Cents | null;
  readonly priceVarianceCents: Cents | null;
  readonly plannedMinutes: number;
  readonly actualMinutes: number;
  readonly labourRecoveryPct: number | null;
  readonly costPerMinute: number | null;
  readonly labourVarianceCents: Cents | null;
  /** workbook figure - engine figure (null when the workbook has none or the engine has none). */
  readonly workbookDiff: { readonly usageCents: Cents | null; readonly priceCents: Cents | null; readonly recoveryPct: number | null };
  readonly valid: boolean;
  readonly issues: readonly string[];
}

export interface GroupVariance {
  readonly key: string;
  readonly orders: number;
  readonly qty: number;
  readonly plannedFabricM: number;
  readonly actualFabricM: number;
  readonly usageVarianceM: number;
  readonly usageVarianceCents: Cents;
  readonly usageIncluded: number;
  readonly priceVarianceCents: Cents;
  readonly priceIncluded: number;
  readonly plannedMinutes: number;
  readonly actualMinutes: number;
  /** Total planned / total actual x 100 (never an average of percentages). Null when there are no actual minutes. */
  readonly labourRecoveryPct: number | null;
  readonly labourVarianceCents: Cents;
  readonly labourIncluded: number;
  /** True when every order in the group contributed to every measure. */
  readonly complete: boolean;
}

export interface VarianceResult {
  readonly config: { readonly bracketBreaks: readonly number[] };
  readonly orders: readonly OrderVariance[];
  readonly byStyle: readonly GroupVariance[];
  readonly byLine: readonly GroupVariance[];
  readonly byBracket: readonly GroupVariance[];
  readonly total: GroupVariance;
  readonly checks: readonly VarianceCheck[];
  readonly assumptions: readonly VarianceAssumption[];
  readonly warnings: readonly string[];
}

export function bracketLabels(breaks: readonly number[]): string[] {
  const out: string[] = [];
  let lo = 0;
  for (const b of breaks) {
    out.push(`${lo}-${b - 1}`);
    lo = b;
  }
  out.push(`${lo}+`);
  return out;
}

/** The bracket an order quantity falls in: lower bound inclusive, upper bound exclusive. */
export function bracketOf(qty: number, breaks: readonly number[]): string {
  const labels = bracketLabels(breaks);
  let i = 0;
  while (i < breaks.length && qty >= breaks[i]) i++;
  return labels[i];
}

function validateBreaks(b: readonly number[]): void {
  if (b.length > 12) throw new Error("Invalid bracket boundaries: at most 12.");
  let prev = 0;
  for (const x of b) {
    if (!Number.isInteger(x) || x <= prev) throw new Error("Invalid bracket boundaries: whole numbers above 0, strictly ascending.");
    prev = x;
  }
}

const finite = (n: number): boolean => Number.isFinite(n) && n >= 0;
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

function group(key: string, os: readonly OrderVariance[]): GroupVariance {
  const withUsage = os.filter((o) => o.usageVarianceCents !== null);
  const withPrice = os.filter((o) => o.priceVarianceCents !== null);
  const withLabour = os.filter((o) => o.labourVarianceCents !== null);
  const planned = sum(os.map((o) => o.plannedMinutes));
  const actual = sum(os.map((o) => o.actualMinutes));
  return {
    key,
    orders: os.length,
    qty: sum(os.map((o) => o.qty)),
    plannedFabricM: round6(sum(os.map((o) => o.plannedFabricM))),
    actualFabricM: round6(sum(os.map((o) => o.actualFabricM))),
    usageVarianceM: round6(sum(os.map((o) => o.usageVarianceM))),
    usageVarianceCents: sum(withUsage.map((o) => o.usageVarianceCents as number)),
    usageIncluded: withUsage.length,
    priceVarianceCents: sum(withPrice.map((o) => o.priceVarianceCents as number)),
    priceIncluded: withPrice.length,
    plannedMinutes: round6(planned),
    actualMinutes: round6(actual),
    labourRecoveryPct: actual > 0 ? round6((planned / actual) * 100) : null,
    labourVarianceCents: sum(withLabour.map((o) => o.labourVarianceCents as number)),
    labourIncluded: withLabour.length,
    complete: os.length > 0 && withUsage.length === os.length && withPrice.length === os.length && withLabour.length === os.length,
  };
}

function groupsBy(os: readonly OrderVariance[], keyOf: (o: OrderVariance) => string, order?: readonly string[]): GroupVariance[] {
  const m = new Map<string, OrderVariance[]>();
  for (const o of os) m.set(keyOf(o), [...(m.get(keyOf(o)) ?? []), o]);
  const keys = order ? order.filter((k) => m.has(k)) : [...m.keys()].sort();
  return keys.map((k) => group(k, m.get(k) as OrderVariance[]));
}

export function runProductionVariance(ds: RwtsaDataset, config: VarianceConfig = {}): VarianceResult {
  const breaks = config.bracketBreaks ?? DEFAULT_BRACKET_BREAKS;
  validateBreaks(breaks);

  // SMV-weighted cost per minute of each style's routing.
  const cpm = new Map<string, number>();
  const acc = new Map<string, { smv: number; cost: number }>();
  for (const r of ds.tables.routing) {
    const a = acc.get(r.styleCode) ?? { smv: 0, cost: 0 };
    a.smv += r.smv;
    a.cost += r.smv * r.costPerMinute;
    acc.set(r.styleCode, a);
  }
  for (const [style, a] of acc) if (a.smv > 0) cpm.set(style, a.cost / a.smv);

  const orders: OrderVariance[] = ds.tables.productionOrders.map((p) => {
    const issues: string[] = [];
    const nums = [p.qty, p.plannedFabricM, p.actualFabricM, p.plannedMinutes, p.actualMinutes];
    const priceOk = (v: number | null) => v === null || finite(v);
    const valid = nums.every(finite) && priceOk(p.standardPrice) && priceOk(p.actualPrice);
    if (!valid) issues.push("A measurement is negative or not a number, so this order is excluded from every total.");
    const rate = cpm.get(p.styleCode) ?? null;
    if (rate === null) issues.push("No routing for this style, so the labour variance in rand cannot be calculated.");
    if (valid && p.actualMinutes === 0) issues.push("Zero actual minutes: labour recovery is undefined.");
    if (valid && p.standardPrice === null) issues.push("No standard price: usage and price variances in rand are unavailable.");
    else if (valid && p.actualPrice === null) issues.push("No actual price: the price variance in rand is unavailable.");

    const usageM = p.actualFabricM - p.plannedFabricM;
    const usage = valid && p.standardPrice !== null ? toCents(usageM * p.standardPrice) : null;
    const price = valid && p.standardPrice !== null && p.actualPrice !== null ? toCents(p.actualFabricM * (p.actualPrice - p.standardPrice)) : null;
    const recovery = valid && p.actualMinutes > 0 ? round6((p.plannedMinutes / p.actualMinutes) * 100) : null;
    const labour = valid && rate !== null ? toCents((p.actualMinutes - p.plannedMinutes) * rate) : null;
    return {
      orderNo: p.orderNo,
      styleCode: p.styleCode,
      line: p.productionLine,
      qty: p.qty,
      bracket: bracketOf(p.qty, breaks),
      plannedFabricM: p.plannedFabricM,
      actualFabricM: p.actualFabricM,
      usageVarianceM: round6(usageM),
      standardPrice: p.standardPrice,
      actualPrice: p.actualPrice,
      usageVarianceCents: usage,
      priceVarianceCents: price,
      plannedMinutes: p.plannedMinutes,
      actualMinutes: p.actualMinutes,
      labourRecoveryPct: recovery,
      costPerMinute: rate,
      labourVarianceCents: labour,
      workbookDiff: {
        usageCents: p.usageVariance !== null && usage !== null ? toCents(p.usageVariance) - usage : null,
        priceCents: p.priceVariance !== null && price !== null ? toCents(p.priceVariance) - price : null,
        recoveryPct: p.labourRecoveryPct !== null && recovery !== null ? round6(p.labourRecoveryPct - recovery) : null,
      },
      valid,
      issues,
    };
  });

  const good = orders.filter((o) => o.valid);
  const byStyle = groupsBy(good, (o) => o.styleCode);
  const byLine = groupsBy(good, (o) => o.line);
  const byBracket = groupsBy(good, (o) => o.bracket, bracketLabels(breaks));
  const total = group("All orders", good);

  const warnings: string[] = [];
  const bad = orders.length - good.length;
  if (bad > 0) warnings.push(`${bad} order(s) with negative or invalid measurements are excluded from every total.`);
  const noRate = good.filter((o) => o.costPerMinute === null).length;
  if (noRate > 0) warnings.push(`${noRate} order(s) have no routing for their style, so no labour variance in rand.`);
  const noPrice = good.filter((o) => o.usageVarianceCents === null).length;
  if (noPrice > 0) warnings.push(`${noPrice} order(s) have no standard price, so no usage variance in rand.`);
  const noActual = good.filter((o) => o.usageVarianceCents !== null && o.priceVarianceCents === null).length;
  if (noActual > 0) warnings.push(`${noActual} order(s) have no actual price, so no price variance in rand.`);
  const zero = good.filter((o) => o.actualMinutes === 0).length;
  if (zero > 0) warnings.push(`${zero} order(s) have zero actual minutes, so no labour recovery percentage.`);
  const wb = good.filter((o) => (o.workbookDiff.usageCents ?? 0) !== 0 || (o.workbookDiff.priceCents ?? 0) !== 0 || (o.workbookDiff.recoveryPct ?? 0) !== 0).length;
  if (wb > 0) warnings.push(`The workbook's own variance columns differ from the calculation on ${wb} order(s); the calculation is shown.`);

  const groupsSum = (gs: readonly GroupVariance[], f: (g: GroupVariance) => number) => sum(gs.map(f));
  const reconciles = [byStyle, byLine, byBracket].every(
    (gs) =>
      groupsSum(gs, (g) => g.usageVarianceCents) === total.usageVarianceCents &&
      groupsSum(gs, (g) => g.priceVarianceCents) === total.priceVarianceCents &&
      groupsSum(gs, (g) => g.labourVarianceCents) === total.labourVarianceCents &&
      groupsSum(gs, (g) => g.orders) === total.orders &&
      Math.abs(groupsSum(gs, (g) => g.plannedMinutes) - total.plannedMinutes) < 1e-6
  );
  const orderSum =
    sum(good.map((o) => o.usageVarianceCents ?? 0)) === total.usageVarianceCents && sum(good.map((o) => o.labourVarianceCents ?? 0)) === total.labourVarianceCents;
  const checks: VarianceCheck[] = [
    { id: "groups", label: "Style, line and bracket groups each sum to the grand total", ok: reconciles, detail: `${good.length} valid order(s).` },
    { id: "orders", label: "Order variances sum to the grand total", ok: orderSum, detail: `Usage R${fromCents(total.usageVarianceCents).toFixed(2)}, labour R${fromCents(total.labourVarianceCents).toFixed(2)}.` },
    { id: "valid", label: "Every order has valid (non-negative, numeric) measurements", ok: bad === 0, detail: bad === 0 ? "All valid." : `${bad} order(s) excluded.` },
    { id: "complete", label: "Every order has the prices and routing for every variance", ok: total.complete, detail: total.complete ? "All measures available." : "Some measures are unavailable for some orders (see warnings)." },
    { id: "workbook-columns", label: "The workbook's own variance columns agree with the calculation", ok: wb === 0, detail: wb === 0 ? "No difference (or the workbook gives none)." : `${wb} order(s) differ.` },
  ];

  const assumptions: VarianceAssumption[] = [
    { id: "sign", text: "Rand variances are positive when unfavourable: more fabric than planned, a higher price than standard, or more minutes than planned." },
    { id: "standard-price", text: "The planned (standard) fabric price on the production order is the standard price for both the usage and the price variance." },
    { id: "cost-per-minute", text: "Labour variance uses the SMV-weighted average cost per minute of the style's Routing_SMV operations (Routing_SMV.costPerMinute); production orders carry no operation split." },
    { id: "recovery", text: "Labour recovery % is total planned minutes over total actual minutes x 100 for every group, never an average of order percentages." },
    { id: "brackets", text: `Order-size brackets (lower bound inclusive): ${bracketLabels(breaks).join(", ")}. The boundaries are a setting, not workbook data.` },
  ];

  return { config: { bracketBreaks: breaks }, orders, byStyle, byLine, byBracket, total, checks, assumptions, warnings };
}
