import type { RwtsaDataset } from "@/rwtsa-demo/dataset";
import { detectAnomalies } from "./anomaly";
import { daysBetween, lastCompleteMonth, monthOf, monthsBetweenExclusive, monthsEndingAt } from "./calendar";
import { resolveConfig, type RedFlagConfigInput } from "./config";
import { demandForecast, WEEKS_PER_MONTH, type DemandForecast } from "./forecast";
import { allocateUnits, classifyPoStatus, etaWeek } from "./inbound";
import { availableOf } from "./stock";
import type { AnomalyRow, Assumption, Exclusion, InboundReport, RedFlagConfig, RedFlagResult, SkuResult, WindowInfo } from "./types";
import { rollUpStyles } from "./rollup";

const EPS = 1e-9;

function validateExclusions(ds: RwtsaDataset, exclusions: readonly Exclusion[]): Map<string, Map<string, string>> {
  const skus = new Set(ds.tables.items.map((i) => i.sku));
  const months = new Set(ds.months);
  const out = new Map<string, Map<string, string>>();
  for (const e of exclusions) {
    const reason = e.reason.trim();
    if (reason === "") throw new Error("An exclusion needs a non-empty reason.");
    if (!skus.has(e.sku)) throw new Error("Exclusion names an unknown SKU.");
    if (!months.has(e.month)) throw new Error("Exclusion names an unknown month.");
    const m = out.get(e.sku) ?? new Map<string, string>();
    m.set(e.month, reason);
    out.set(e.sku, m);
  }
  return out;
}

function resolveWindow(ds: RwtsaDataset, cfg: RedFlagConfig): WindowInfo {
  const stockMonth = lastCompleteMonth(cfg.stockDate);
  const lastHistoryMonth = ds.months.length > 0 ? ds.months[ds.months.length - 1] : null;
  const end = cfg.historyAnchor === "strict" || lastHistoryMonth === null ? stockMonth : lastHistoryMonth;
  const months = monthsEndingAt(end, cfg.forecastWindowMonths);
  const have = new Set(ds.months);
  return {
    anchor: cfg.historyAnchor,
    months,
    lastHistoryMonth,
    stockMonth,
    gapMonths: lastHistoryMonth === null ? [] : monthsBetweenExclusive(lastHistoryMonth, stockMonth),
    missingMonths: months.filter((m) => !have.has(m)),
  };
}

export function runRedFlag(ds: RwtsaDataset, input: RedFlagConfigInput = {}, exclusions: readonly Exclusion[] = []): RedFlagResult {
  const cfg = resolveConfig(input);
  const H = cfg.horizonWeeks;
  const excl = validateExclusions(ds, exclusions);
  const win = resolveWindow(ds, cfg);
  const inWindow = new Set(win.months);

  const items = ds.tables.items;
  const stockBy = new Map(ds.tables.stock.map((s) => [s.sku, s]));
  const obsBy = new Map<string, Map<string, number | null>>();
  for (const p of ds.tables.salesHistory) {
    const m = obsBy.get(p.sku) ?? new Map<string, number | null>();
    m.set(p.month, p.qty);
    obsBy.set(p.sku, m);
  }

  // --- demand forecast and anomalies, per SKU ---
  const forecasts = new Map<string, DemandForecast>();
  const monthly = new Map<string, number | null>();
  const anomalies: AnomalyRow[] = [];
  const anomalyStatus = new Map<string, "none" | "review" | "excluded">();
  for (const it of items) {
    const obs = obsBy.get(it.sku) ?? new Map<string, number | null>();
    const excludedMonths = new Set(excl.get(it.sku)?.keys() ?? []);
    const f = demandForecast(win.months, obs, excludedMonths);
    forecasts.set(it.sku, f);
    monthly.set(it.sku, f.status === "ok" ? f.total / f.count : null);

    const series = ds.months.map((month) => ({ month, qty: obs.get(month) ?? null }));
    const det = detectAnomalies(series, cfg.anomaly);
    let status: "none" | "review" | "excluded" = "none";
    for (const fl of det.flagged) {
      const reason = excl.get(it.sku)?.get(fl.month) ?? null;
      const row: AnomalyRow = { sku: it.sku, styleCode: it.styleCode, month: fl.month, qty: fl.qty, median: det.median as number, inWindow: inWindow.has(fl.month), excluded: reason !== null, reason };
      anomalies.push(row);
      if (row.inWindow) status = row.excluded ? (status === "review" ? "review" : "excluded") : "review";
    }
    anomalyStatus.set(it.sku, status);
  }

  // --- inbound purchase orders ---
  const weeksBy = new Map<string, number[]>(items.map((i) => [i.sku, Array.from({ length: H }, () => 0)]));
  const inbound = { onWaterUnits: 0, onOrderUnits: 0, overdueAssumedWeek1Units: 0, overdueExcludedUnits: 0, overdueOnOrderUnits: 0, beyondHorizonUnits: 0, receivedExcludedUnits: 0, unclassifiedUnits: 0, unallocatedStyleUnits: 0, unmatchedUnits: 0 };
  const onWaterPoBySku = new Map<string, number>();
  const itemBySku = new Map(items.map((i) => [i.sku, i]));
  const membersByStyle = new Map<string, typeof items>();
  for (const it of items) membersByStyle.set(it.styleCode, [...(membersByStyle.get(it.styleCode) ?? []), it]);
  let usedDemandCurve = false;

  for (const po of ds.tables.importPos) {
    const cls = classifyPoStatus(po.status);
    if (cls === "received") {
      inbound.receivedExcludedUnits += po.qty;
      continue;
    }
    if (cls === "unclassified") {
      inbound.unclassifiedUnits += po.qty;
      continue;
    }

    // Which SKUs does this line belong to?
    let parts: [string, number][] | null;
    if (po.sku !== null && po.sku !== "") {
      parts = itemBySku.has(po.sku) ? [[po.sku, po.qty]] : null;
      if (parts === null) {
        inbound.unmatchedUnits += po.qty;
        continue;
      }
    } else {
      const members = po.styleCode ? (membersByStyle.get(po.styleCode) ?? []) : [];
      if (members.length === 0) {
        inbound.unmatchedUnits += po.qty;
        continue;
      }
      let weights: [string, number][];
      if (cfg.sizeCurve.kind === "explicit") {
        const curve = cfg.sizeCurve.weights;
        weights = members.map((m) => [m.sku, curve[m.size] ?? 0]);
      } else if (cfg.sizeCurve.kind === "demand-proportional") {
        weights = members.map((m) => [m.sku, monthly.get(m.sku) ?? 0]);
        usedDemandCurve = true;
      } else {
        weights = [];
      }
      parts = weights.length === 0 ? null : allocateUnits(po.qty, weights);
      if (parts === null) {
        inbound.unallocatedStyleUnits += po.qty;
        continue;
      }
    }

    if (cls === "on-water") for (const [sku, u] of parts) onWaterPoBySku.set(sku, (onWaterPoBySku.get(sku) ?? 0) + u);

    let week = etaWeek(cfg.stockDate, po.etaStores);
    if (week <= 0) {
      if (cls === "on-order") {
        inbound.overdueOnOrderUnits += po.qty;
        continue;
      }
      if (cfg.overdueOnWater === "exclude") {
        inbound.overdueExcludedUnits += po.qty;
        continue;
      }
      week = 1;
      inbound.overdueAssumedWeek1Units += po.qty;
    }
    if (week > H) {
      inbound.beyondHorizonUnits += po.qty;
      continue;
    }
    for (const [sku, u] of parts) (weeksBy.get(sku) as number[])[week - 1] += u;
    if (cls === "on-water") inbound.onWaterUnits += po.qty;
    else inbound.onOrderUnits += po.qty;
  }

  // Stock in-transit vs on-water POs: kept SEPARATE. The projection uses purchase orders only, so nothing is counted twice;
  // a disagreement is exposed, not resolved.
  let consistent = 0;
  let mismatched = 0;
  let inTransitUnits = 0;
  let onWaterPoUnits = 0;
  for (const it of items) {
    const st = stockBy.get(it.sku);
    const a = st?.inTransit ?? 0;
    const b = onWaterPoBySku.get(it.sku) ?? 0;
    inTransitUnits += a;
    onWaterPoUnits += b;
    if (a === 0 && b === 0) continue;
    if (Math.abs(a - b) < 0.5) consistent += 1;
    else mismatched += 1;
  }
  const inboundReport: InboundReport = { ...inbound, reconciliation: { skusConsistent: consistent, skusMismatched: mismatched, inTransitStockUnits: inTransitUnits, onWaterPoUnits } };

  // --- projection per SKU ---
  const skus: SkuResult[] = items.map((it) => {
    const st = stockBy.get(it.sku);
    const f = forecasts.get(it.sku) as DemandForecast;
    const m = monthly.get(it.sku) ?? null;
    const weekly = m === null ? null : m / WEEKS_PER_MONTH;
    const available = st ? availableOf(st) : null;
    const reported = st?.available ?? null;
    const tender = it.isTender === true;
    const minLevel = it.minLevel;
    const evaluable = !tender && minLevel !== null;
    const inboundWeeks = weeksBy.get(it.sku) as number[];
    const inboundTotal = inboundWeeks.reduce((a, b) => a + b, 0);

    const limits: string[] = [];
    if (st === undefined) limits.push("No Stock row: opening Available is unknown.");
    if (f.status === "insufficient") limits.push(f.missingMonths.length > 0 ? `Demand history missing for the forecast window (${f.missingMonths.join(", ")}): no forecast.` : "No demand observations remain in the forecast window: no forecast.");
    if (!tender && minLevel === null) limits.push("No minimum stock level: shortage is not evaluated.");

    const balances: number[] = [];
    let firstBreachWeek: number | null = null;
    let shortfall = 0;
    if (available !== null && weekly !== null) {
      let bal = available;
      const due = cfg.committedDue[it.sku] ?? {};
      for (let w = 1; w <= H; w++) {
        bal = bal + inboundWeeks[w - 1] - weekly - (due[w] ?? 0);
        balances.push(bal);
        if (minLevel !== null) {
          if (firstBreachWeek === null && bal < minLevel - EPS) firstBreachWeek = w;
          shortfall = Math.max(shortfall, minLevel - bal);
        }
      }
    }
    if (tender || minLevel === null) {
      firstBreachWeek = null;
      shortfall = 0;
    }
    if (shortfall < EPS) shortfall = 0;
    const proposedOrder = tender || shortfall === 0 ? 0 : Math.ceil(shortfall - EPS);
    const monthsOfCover = available === null || m === null || m <= 0 ? null : Math.max(0, available / m);

    return {
      sku: it.sku,
      styleCode: it.styleCode,
      size: it.size,
      tenderExempt: tender,
      minLevel,
      available,
      availableReported: reported,
      availableDifference: available !== null && reported !== null ? available - reported : null,
      forecast: f,
      monthlyForecast: m,
      weeklyForecast: weekly,
      inboundWeeks,
      inboundTotal,
      balances,
      firstBreachWeek,
      shortfall,
      proposedOrder,
      monthsOfCover,
      anomalyStatus: anomalyStatus.get(it.sku) ?? "none",
      excludedMonths: [...(excl.get(it.sku)?.keys() ?? [])].sort(),
      evaluable,
      limitation: limits.length > 0 ? limits.join(" ") : null,
    };
  });

  const styles = rollUpStyles(skus, anomalies, H);

  const breaches = skus.filter((s) => s.firstBreachWeek !== null);
  const summary = {
    skuCount: skus.length,
    shortageSkus: skus.filter((s) => !s.tenderExempt && s.shortfall > 0).length,
    firstBreachWeek: breaches.length === 0 ? null : Math.min(...breaches.map((s) => s.firstBreachWeek as number)),
    totalShortfall: skus.reduce((a, s) => a + s.shortfall, 0),
    totalProposedOrder: skus.reduce((a, s) => a + s.proposedOrder, 0),
    anomaliesToReview: anomalies.filter((a) => a.inWindow && !a.excluded).length,
    anomaliesExcluded: anomalies.filter((a) => a.excluded).length,
    tenderExemptSkus: skus.filter((s) => s.tenderExempt).length,
    skusWithoutForecast: skus.filter((s) => s.forecast.status === "insufficient").length,
    availableMismatchSkus: skus.filter((s) => s.availableDifference !== null && Math.abs(s.availableDifference) > EPS).length,
  };

  // --- assumptions and limitations (all visible in the UI) ---
  const assumptions: Assumption[] = [
    { id: "available-start", text: "The projection starts from Available (JHB + Durban + Cape Town + Factory Store - Committed). Committed stock is already deducted there and is never deducted again; dated commitments are zero unless a separate schedule is supplied. Bond and In transit are not in opening Available." },
    { id: "weekly-forecast", text: `Weekly forecast = monthly average over the demand window / ${WEEKS_PER_MONTH}. Week 1 is the 7 days after the stock date (${cfg.stockDate}); purchase orders arrive in the week of their ETA to stores.` },
    { id: "inbound-source", text: "Inbound comes from open purchase orders only. Stock 'In transit' is not added to the projection, so nothing is counted twice; any disagreement between the two is shown, not resolved." },
  ];
  if (cfg.historyAnchor === "last-available" && win.gapMonths.length > 0) {
    assumptions.push({
      id: "history-gap",
      text: `Sales history ends in ${win.lastHistoryMonth}, but stock is dated ${cfg.stockDate}. Demand for ${win.gapMonths.join(", ")} is not in the workbook and is NOT invented. The forecast uses the ${cfg.forecastWindowMonths} month(s) to ${win.lastHistoryMonth} as the best available view of demand. This is an assumption to be confirmed.`,
    });
  }
  if (cfg.overdueOnWater === "week-1") {
    assumptions.push({ id: "overdue-on-water", text: "An overdue shipment still marked on the water is assumed to arrive in week 1 (demonstration assumption). Overdue shipments only on order are not assumed to arrive." });
  } else {
    assumptions.push({ id: "overdue-on-water", text: "Overdue shipments still marked on the water are excluded from inbound (no arrival assumed)." });
  }
  if (usedDemandCurve) assumptions.push({ id: "size-curve-demand", text: "Style-level purchase orders are split to sizes in proportion to each SKU's current forecast demand (assumption: no supplied size curve)." });

  const limitations: string[] = [];
  if (cfg.historyAnchor === "strict" && win.missingMonths.length > 0) limitations.push(`Strict anchoring to the stock date needs ${win.months.join(", ")}; the workbook has no sales for ${win.missingMonths.join(", ")}, so affected SKUs have no forecast.`);
  if (summary.skusWithoutForecast > 0) limitations.push(`${summary.skusWithoutForecast} SKU(s) have no forecast because demand history is missing or fully excluded; they are not included in shortage totals.`);
  if (skus.some((s) => s.available === null)) limitations.push(`${skus.filter((s) => s.available === null).length} SKU(s) have no Stock row.`);
  if (skus.some((s) => !s.tenderExempt && s.minLevel === null)) limitations.push(`${skus.filter((s) => !s.tenderExempt && s.minLevel === null).length} non-tender SKU(s) have no minimum level, so shortage is not evaluated for them.`);
  if (inboundReport.reconciliation.skusMismatched > 0) limitations.push(`Stock in-transit and on-water purchase orders disagree for ${inboundReport.reconciliation.skusMismatched} SKU(s) (stock ${inboundReport.reconciliation.inTransitStockUnits} units, purchase orders ${inboundReport.reconciliation.onWaterPoUnits} units). They are kept separate; the projection uses purchase orders only.`);
  if (inboundReport.unallocatedStyleUnits > 0) limitations.push(`${inboundReport.unallocatedStyleUnits} units on style-level purchase orders could not be split to sizes (no usable size curve) and are held unallocated.`);
  if (inboundReport.unmatchedUnits > 0) limitations.push(`${inboundReport.unmatchedUnits} units on purchase-order lines match no SKU or style in Items.`);
  if (inboundReport.unclassifiedUnits > 0) limitations.push(`${inboundReport.unclassifiedUnits} units on purchase-order lines have an unrecognised status and are excluded.`);
  if (inboundReport.overdueOnOrderUnits > 0) limitations.push(`${inboundReport.overdueOnOrderUnits} units are overdue and only on order: excluded (no arrival date can be assumed).`);
  if (summary.availableMismatchSkus > 0) limitations.push(`Computed Available differs from the workbook's Available for ${summary.availableMismatchSkus} SKU(s); the brief's formula is used.`);

  return {
    config: cfg,
    window: win,
    skus,
    styles,
    anomalies,
    inbound: inboundReport,
    summary,
    assumptions,
    limitations,
    labels: {
      proposedOrder: "Proposed order quantity: a suggestion from the maximum projected shortfall against the minimum level. It is not an authorised purchase order.",
      tenderExempt: "Tender / customer-order-only: excluded from automatic ordering.",
    },
  };
}

// Re-exported so callers need only this module for the stock-date helpers used in screens.
export { daysBetween, monthOf };
