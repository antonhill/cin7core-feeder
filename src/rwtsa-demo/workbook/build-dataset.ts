import { TAB_CONTRACTS, TAB_NAMES, type TabName } from "@/rwtsa-demo/contracts/tabs";
import type {
  BomRow,
  CustomerRow,
  ImportPoRow,
  ItemRow,
  LandedCostRow,
  PaymentFecRow,
  ProductionOrderRow,
  QuoteRow,
  RoutingRow,
  StockFileRow,
} from "@/rwtsa-demo/contracts/tabs";
import type { DatasetSource, Provenance, RwtsaDataset, SalesFileAverages, SalesPoint, StockRow } from "@/rwtsa-demo/dataset";
import { finding, hasErrors, MAX_ROWS_LISTED, type Finding } from "@/rwtsa-demo/findings";
import { computeAvailable, reconcile } from "@/rwtsa-demo/reconcile";
import { parseTab, type FieldHeaderOverrides, type ParsedTab } from "@/rwtsa-demo/workbook/parse-tab";
import type { ReadResult } from "@/rwtsa-demo/workbook/read";

export type HeaderOverrides = Partial<Record<TabName, FieldHeaderOverrides>>;

export interface BuildOptions {
  readonly provenance: Provenance;
  readonly source: DatasetSource;
  /** Local-only mapping of our canonical field keys to the real workbook's header text. */
  readonly headerOverrides?: HeaderOverrides;
}

export interface BuildResult {
  readonly ok: boolean;
  /** Present only when there are no error findings. A partially valid dataset is never returned. */
  readonly dataset: RwtsaDataset | null;
  readonly findings: readonly Finding[];
  /** Per-tab parsed row counts, for the structure-only validation report. */
  readonly parsedRowCounts: Readonly<Partial<Record<TabName, number>>>;
}

const EPS = 1e-9;

function rowsOf<T>(parsed: ParsedTab | undefined): T[] {
  return (parsed?.rows ?? []) as unknown as T[];
}

/** Validates every tab and, only if the whole workbook is clean of errors, builds the typed dataset. */
export function buildDataset(read: ReadResult, opts: BuildOptions): BuildResult {
  const findings: Finding[] = [...read.findings];
  const parsed: Partial<Record<TabName, ParsedTab>> = {};
  const parsedRowCounts: Partial<Record<TabName, number>> = {};

  for (const tab of TAB_NAMES) {
    const raw = read.tables[tab];
    if (!raw) continue; // missing_tab already reported by the reader
    const p = parseTab(TAB_CONTRACTS[tab], raw, opts.headerOverrides?.[tab] ?? {});
    parsed[tab] = p;
    parsedRowCounts[tab] = p.rows.length;
    findings.push(...p.findings);
  }

  const items = rowsOf<ItemRow>(parsed.Items);
  const stockFile = rowsOf<StockFileRow>(parsed.Stock);
  const importPos = rowsOf<ImportPoRow>(parsed.ImportPOs);
  const bom = rowsOf<BomRow>(parsed.BOM);
  const routing = rowsOf<RoutingRow>(parsed.Routing_SMV);
  const productionOrders = rowsOf<ProductionOrderRow>(parsed.ProductionOrders);
  const landedCost = rowsOf<LandedCostRow>(parsed.LandedCost);
  const paymentsFec = rowsOf<PaymentFecRow>(parsed.Payments_FEC);
  const customers = rowsOf<CustomerRow>(parsed.Customers);
  const quotes = rowsOf<QuoteRow>(parsed.Quotes);

  // SalesHistory: unpivot the YYYY-MM columns into (sku, month, qty) points.
  const sales = parsed.SalesHistory;
  const salesHistory: SalesPoint[] = [];
  const salesFileAverages: SalesFileAverages[] = [];
  if (sales) {
    sales.rows.forEach((r, i) => {
      const sku = r.sku as string;
      sales.months.forEach((month, m) => salesHistory.push({ sku, month, qty: sales.monthQty[i][m] }));
      salesFileAverages.push({ sku, avg6: (r.avg6 as number | null) ?? null, avg12: (r.avg12 as number | null) ?? null });
    });
  }

  // Cross-tab checks (only meaningful once Items parsed).
  const itemSkus = new Set(items.map((i) => i.sku));
  const itemStyles = new Set(items.map((i) => i.styleCode));
  const orphan = (tab: TabName, field: string, code: "orphan_sku" | "orphan_style", values: (string | null)[], rowNumbers: number[], known: Set<string>) => {
    let count = 0;
    const rows: number[] = [];
    values.forEach((v, i) => {
      if (v !== null && !known.has(v)) {
        count++;
        if (rows.length < MAX_ROWS_LISTED) rows.push(rowNumbers[i]);
      }
    });
    if (count > 0) findings.push(finding({ severity: "error", code, tab, field, count, rows }));
  };

  if (parsed.Items) {
    if (parsed.SalesHistory) orphan("SalesHistory", "sku", "orphan_sku", parsed.SalesHistory.rows.map((r) => r.sku as string), parsed.SalesHistory.rowNumbers, itemSkus);
    if (parsed.Stock) {
      orphan("Stock", "sku", "orphan_sku", parsed.Stock.rows.map((r) => r.sku as string), parsed.Stock.rowNumbers, itemSkus);
      orphan("Stock", "styleCode", "orphan_style", parsed.Stock.rows.map((r) => r.styleCode as string | null), parsed.Stock.rowNumbers, itemStyles);
    }
    if (parsed.ImportPOs) {
      orphan("ImportPOs", "sku", "orphan_sku", parsed.ImportPOs.rows.map((r) => r.sku as string | null), parsed.ImportPOs.rowNumbers, itemSkus);
      orphan("ImportPOs", "styleCode", "orphan_style", parsed.ImportPOs.rows.map((r) => r.styleCode as string | null), parsed.ImportPOs.rowNumbers, itemStyles);
    }
    if (parsed.LandedCost) orphan("LandedCost", "sku", "orphan_sku", parsed.LandedCost.rows.map((r) => r.sku as string), parsed.LandedCost.rowNumbers, itemSkus);
    if (parsed.BOM) orphan("BOM", "styleCode", "orphan_style", parsed.BOM.rows.map((r) => r.styleCode as string), parsed.BOM.rowNumbers, itemStyles);
    if (parsed.Routing_SMV) orphan("Routing_SMV", "styleCode", "orphan_style", parsed.Routing_SMV.rows.map((r) => r.styleCode as string), parsed.Routing_SMV.rowNumbers, itemStyles);
    if (parsed.ProductionOrders) {
      orphan("ProductionOrders", "styleCode", "orphan_style", parsed.ProductionOrders.rows.map((r) => r.styleCode as string), parsed.ProductionOrders.rowNumbers, itemStyles);
    }

    // DP-16: a tender / customer-order-only SKU must carry no standing reorder level.
    const tenderWithLevel = parsed.Items.rows.flatMap((r, i) => (r.isTender === true && typeof r.minLevel === "number" && r.minLevel > 0 ? [parsed.Items!.rowNumbers[i]] : []));
    if (tenderWithLevel.length > 0) findings.push(finding({ severity: "warning", code: "tender_with_min_level", tab: "Items", field: "minLevel", count: tenderWithLevel.length, rows: tenderWithLevel }));
  }

  // Stock: computed Available per the brief, and a count of disagreements with the file's own Available column.
  const stock: StockRow[] = stockFile.map((s) => ({ ...s, availableComputed: computeAvailable(s) }));
  if (parsed.Stock) {
    const mismatchRows = stock.flatMap((s, i) => (s.available !== null && Math.abs(s.available - s.availableComputed) > EPS ? [parsed.Stock!.rowNumbers[i]] : []));
    if (mismatchRows.length > 0) findings.push(finding({ severity: "warning", code: "available_mismatch", tab: "Stock", field: "available", count: mismatchRows.length, rows: mismatchRows }));
  }

  // Quotes: a lost quote must carry a reason (CRM-06).
  if (parsed.Quotes) {
    const lostNoReason = parsed.Quotes.rows.flatMap((r, i) => (r.status === "lost" && r.lostReason === null ? [parsed.Quotes!.rowNumbers[i]] : []));
    if (lostNoReason.length > 0) findings.push(finding({ severity: "warning", code: "lost_without_reason", tab: "Quotes", field: "lostReason", count: lostNoReason.length, rows: lostNoReason }));
  }

  const ok = !hasErrors(findings);
  if (!ok) return { ok: false, dataset: null, findings, parsedRowCounts };

  const months = sales?.months ?? [];
  const tables: RwtsaDataset["tables"] = { items, salesHistory, salesFileAverages, stock, importPos, bom, routing, productionOrders, landedCost, paymentsFec, customers, quotes };
  const dataset: RwtsaDataset = {
    schemaVersion: 1,
    provenance: opts.provenance,
    source: opts.source,
    months,
    tables,
    reconciliation: reconcile(tables, months),
    findings,
  };
  return { ok: true, dataset, findings, parsedRowCounts };
}
