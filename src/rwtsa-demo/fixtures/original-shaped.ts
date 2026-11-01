import ExcelJS from "exceljs";

/**
 * SYNTHETIC workbook that reproduces the STRUCTURAL characteristics of the advisor's protected workbook, with invented
 * values only (every name carries a `SYN-` prefix). It exists so the layout support in workbook/layouts.ts can be tested
 * without any confidential data:
 *
 *   - a supplementary `ReadMe` sheet,
 *   - tabular sheets whose headers use different wording from the contract's canonical names,
 *   - an Items sheet with a trailing merged note row,
 *   - REPORT-layout sheets (BOM, Routing_SMV, ProductionOrders, LandedCost, Payments_FEC): title rows above the header
 *     (header on row 3 or 4), identifiers and rates stated in title / text lines, summary and note rows below the data,
 *   - BOM "Applies to sizes" lists, numbers stored as text, and a Labour line that points at the routing,
 *   - composite product references ("<style> - all sizes"), per-unit FOB, style-level landed-cost lines,
 *   - percent-formatted cells, Yes/No bond text with a trailing description, and Date cells.
 *
 * Hand-checkable figures are exposed in `ORIGINAL_SHAPED` so tests assert exact numbers.
 */

export const ORIGINAL_SHAPED = {
  styleA: "SYN-VEST-A",
  styleB: "SYN-JKT-B",
  sizes: ["S", "M", "L", "XL", "2XL"] as const,
  shipment: "PO-SYN-1",
  planningFx: 18,
  customsFx: 18.5,
  freightTotal: 4200,
  cpm: 2.7,
  totalSmv: 8,
  /** Style A non-labour component cost per size: S,M,L use the 32cm zip, XL and 2XL the 34cm zip. */
  nonLabourSML: 44.85,
  nonLabourXLUp: 45.35,
  labour: 21.6,
  /** Rows (1-based, as on the sheet) the layout code must account for as notes or summaries. */
  itemsNoteRow: 13,
} as const;

const S = ORIGINAL_SHAPED.sizes;
const A = ORIGINAL_SHAPED.styleA;
const B = ORIGINAL_SHAPED.styleB;
const MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];
const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);

function put(ws: ExcelJS.Worksheet, row: number, values: unknown[], fmt: Record<number, string> = {}): void {
  values.forEach((v, i) => {
    if (v === null || v === undefined) return;
    const c = ws.getRow(row).getCell(i + 1);
    c.value = v as ExcelJS.CellValue;
    if (fmt[i + 1]) c.numFmt = fmt[i + 1];
  });
}
const f = (result: number | string | Date) => ({ formula: "1+1", result }) as ExcelJS.CellFormulaValue;

export function buildOriginalShapedWorkbook(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();

  // ---- ReadMe (supplementary): documentation only ----
  const rm = wb.addWorksheet("ReadMe");
  put(rm, 2, [null, "SYN demonstration data slice"]);
  put(rm, 3, [null, "Synthetic. Structure only."]);
  rm.mergeCells("B6:D6");
  put(rm, 6, [null, "Synthetic data note"]);

  // ---- Items: tabular, real-style headers, trailing blank + merged note row ----
  const items = wb.addWorksheet("Items");
  put(items, 1, ["SKU", "Style code", "Description", "Production Z-code", "Fabric", "Colour", "Size", "Source", "UoM", "Min level", "Reorder point", "Std cost (ZAR)", "Std sell price (ZAR)"]);
  let r = 2;
  for (const style of [A, B]) {
    for (const z of S) {
      const cost = style === A ? 66.45 : 50;
      put(items, r, [`${style}-${z}`, style, `${style} ${z}`, `Z-${style}`, "SYN fabric", "Navy", z, style === A ? "Local" : "Import", "Each", 10, 20, style === A ? f(cost) : cost, style === A ? f(Math.round(cost * 1.6 * 100) / 100) : cost * 1.6]);
      r++;
    }
  }
  // Row 12 is left blank; the merged note sits on row 13.
  items.mergeCells(`G${ORIGINAL_SHAPED.itemsNoteRow}:I${ORIGINAL_SHAPED.itemsNoteRow}`);
  put(items, ORIGINAL_SHAPED.itemsNoteRow, [null, null, null, null, null, null, "Std sell price = Std cost x 1.6 (synthetic note)"]);

  // ---- SalesHistory ----
  const sales = wb.addWorksheet("SalesHistory");
  put(sales, 1, ["SKU", "Style code", "Colour", "Size", ...MONTHS, "6-mo avg", "12-mo avg"]);
  r = 2;
  for (const style of [A, B]) for (const z of S) {
    const q = MONTHS.map((_, i) => 10 + i);
    put(sales, r, [`${style}-${z}`, style, "Navy", z, ...q, f(14.5), f(14.5)]);
    r++;
  }

  // ---- Stock ----
  const stock = wb.addWorksheet("Stock");
  put(stock, 1, ["SKU", "Style code", "Colour", "Size", "JHB", "Durban", "Cape Town", "Bond (not available)", "Factory store", "In transit", "Committed (SO)", "Available (excl. Bond)"]);
  r = 2;
  for (const style of [A, B]) for (const z of S) {
    put(stock, r, [`${style}-${z}`, style, "Navy", z, 20, 5, 5, 40, 10, 3, 4, f(36)]);
    r++;
  }

  // ---- ImportPOs: tabular; composite product text; Yes/No bond with description; ISO date text ----
  const pos = wb.addWorksheet("ImportPOs");
  put(pos, 1, ["PO no", "Supplier (anon)", "Country", "Currency", "Incoterm", "SKU / style", "Qty", "Unit price (USD)", "ETD", "ETA port (Durban)", "ETA JHB stores", "Status", "Bond on arrival"]);
  const bondNo = "No (duty-free, direct to stores)";
  put(pos, 2, ["PO-SYN-1", "SYN Supplier (anon)", "China", "USD", "FOB", `${A} - all sizes`, 100, 10, "2026-08-20", "2026-09-20", "2026-09-30", "On the water", "Yes"]);
  put(pos, 3, ["PO-SYN-1", "SYN Supplier (anon)", "China", "USD", "FOB", `${B}-M (single size)`, 50, 20, "2026-08-20", "2026-10-20", "2026-11-10", "On the water", "Yes"]);
  put(pos, 4, ["PO-SYN-2", "SYN Supplier (anon)", "China", "USD", "FOB", `${B} - all sizes`, 200, 20, "2026-10-15", "2026-11-20", "2026-12-05", "On order", bondNo]);
  put(pos, 5, ["PO-SYN-3", "SYN Supplier (anon)", "China", "USD", "FOB", "SYN-UNKNOWN-X (not in master)", 40, 5, "2026-10-20", "2026-11-25", "2026-12-10", "On order", "Yes"]);

  // ---- BOM: report layout (title rows, header on row 4, size lists, text numbers, Labour line, roll-up + note below) ----
  const bom = wb.addWorksheet("BOM");
  put(bom, 1, ["Bill of material - one BOM per style (synthetic)"]);
  put(bom, 2, [`Style: ${A} · SYN Reflective Vest · Local CMT`]);
  put(bom, 4, ["Component", "Type", "Applies to sizes", "Qty / unit", "UoM", "Std cost (ZAR)", "Notes"]);
  put(bom, 5, ["Main fabric", "Fabric", "All", "1.2", "m", "30.00", "text numbers"]);
  put(bom, 6, ["Zip 32cm", "Trim", "S, M, L", "1", "ea", "4.00", "short zip"]);
  put(bom, 7, ["Zip 34cm", "Trim", "XL, 2XL", "1", "ea", "4.50", "long zip"]);
  put(bom, 8, ["Thread", "Trim", "All (per size)", "0.5", "cone", "2.00"]);
  put(bom, 9, ["Label", "Consumable", "All", 1, "ea", 0.75]);
  put(bom, 10, ["Labour (from routing)", "Labour", "All", "per routing", "min", "(from routing)"]);
  put(bom, 11, ["Logo print", "Service", "All (customer logo)", "1", "ea", "2.50"]);
  put(bom, 12, ["Poly bag", "Packaging", "All", "1", "ea", "0.60"]);
  put(bom, 15, ["Cost roll-up (synthetic)"]);
  put(bom, 16, ["Materials, trims and thread", null, null, null, null, 44.85]);
  put(bom, 17, ["Labour (SMV 8.00 x R2.70)", null, null, null, null, 21.6]);
  put(bom, 18, ["Total built-up cost", null, null, null, null, 66.45]);
  put(bom, 20, ["This total ties to the Items tab (synthetic note)."]);

  // ---- Routing_SMV: report layout; style in title, cost per minute in a text line, summary + build-up rows below ----
  const rt = wb.addWorksheet("Routing_SMV");
  put(rt, 1, [`Routing / Standard Minute Values - ${A} (unbundled: overhead, efficiency and margin are separate lines)`]);
  put(rt, 2, ["Cost-per-minute (direct + indirect labour only): R2.70. Overhead, efficiency and margin are SEPARATE lines below."]);
  put(rt, 4, ["Op no", "Operation", "Machine / type", "SMV (min)"]);
  put(rt, 5, [10, "Cut", "Table", 2]);
  put(rt, 6, [20, "Sew", "Lockstitch", 3]);
  put(rt, 7, [30, "Finish", "Hand", 3]);
  put(rt, 8, [null, "Total SMV per garment", null, f(8)]);
  put(rt, 9, [null, "Direct CMT cost = Total SMV x R2.70", null, f(21.6)]);
  put(rt, 11, [null, "Cost build-up (unbundled - separate lines):"]);
  put(rt, 12, [null, "Factory overhead recovery (per min)", "synthetic", f(6.8)]);
  put(rt, 13, [null, "Efficiency allowance", "synthetic", f(3.6)]);
  put(rt, 14, [null, "Margin", "synthetic", f(3.2)]);

  // ---- ProductionOrders: report layout, header on row 3, composite style, percent-formatted recovery, note below ----
  const po = wb.addWorksheet("ProductionOrders");
  put(po, 1, ["Production orders - planned vs actual (synthetic)"]);
  put(po, 3, ["Prod order", "Style", "Qty", "Planned SMV/unit", "Planned minutes", "Actual minutes", "Planned fabric (m)", "Actual fabric (m)", "Planned fabric price", "Actual fabric price", "Labour recovery %", "Usage variance (m)", "Price variance (ZAR)", "Production line"]);
  put(po, 4, ["PRD-SYN-1", `${A} (long run)`, 100, 8, f(800), 1000, f(120), 126, 30, 31, f(0.8), f(6), f(126), "Line 1"], { 11: "0.0%" });
  put(po, 5, ["PRD-SYN-2", `${A} (short run)`, 20, 8, f(160), 240, f(24), 25.2, 30, 31, f(160 / 240), f(1.2), f(25.2), "Line 2"], { 11: "0.0%" });
  put(po, 7, ["Amber cells are actuals; white cells are formulas (synthetic note)."]);

  // ---- LandedCost: report layout; shipment in title, FX and freight in a text line; per-unit FOB; style-level lines ----
  const lc = wb.addWorksheet("LandedCost");
  put(lc, 1, [`Landed cost - one shipment (${ORIGINAL_SHAPED.shipment}). FOB + duty on customs value + freight allocated by volumetric share.`]);
  put(lc, 2, ["Planning FX (est): 18.00 · Customs/settlement FX (actual): 18.50 · Freight blocks: Ocean 3,000 + SA landside 1,000 + Docs/agency 200 (ZAR) = 4,200, allocated by CBM share across this shipment only."]);
  put(lc, 4, ["Product", "Qty", "FOB (USD/unit)", "CBM total", "CBM share", "Duty %", "FOB (ZAR) @ customs FX", "Duty (ZAR)", "Allocated freight (ZAR)", "Landed unit cost (ZAR)"]);
  put(lc, 5, [A, 100, 10, 6, f(0.6), 0.15, f(18500), f(2775), f(2520), f(237.95)], { 5: "0.0%", 6: "0%" });
  put(lc, 6, [B, 50, 20, 4, f(0.4), 0.2, f(18500), f(3700), f(1680), f(477.6)], { 5: "0.0%", 6: "0%" });

  // ---- Payments_FEC: report layout, header on row 3, Date cells ----
  const pay = wb.addWorksheet("Payments_FEC");
  put(pay, 1, ["Import payments and forward cover (synthetic)"]);
  put(pay, 3, ["PO no", "Supplier (anon)", "Shipment date", "Terms (days)", "Due date", "USD amount", "FEC reference", "FEC locked rate", "ZAR value @ FEC", "Remark"]);
  put(pay, 4, ["PO-SYN-1", "SYN Supplier (anon)", utc("2026-10-16"), 30, f(utc("2026-11-15")), 3000, "FEC-SYN-1", 18.2, f(54600), "balance"]);
  put(pay, 5, ["PO-SYN-2", "SYN Supplier (anon)", utc("2026-10-31"), 30, f(utc("2026-11-30")), 1500, null, null, null, "no cover"]);
  put(pay, 6, ["PO-SYN-1", "SYN Supplier (anon)", utc("2026-08-31"), 30, f(utc("2026-09-30")), 500, null, null, null, "deposit"]);
  pay.getCell("C4").numFmt = "yyyy-mm-dd";

  // ---- Customers / Quotes: tabular, real-style headers ----
  const cu = wb.addWorksheet("Customers");
  put(cu, 1, ["Customer code", "Customer name (anon)", "Classification", "Rep", "Second rep (link acct)", "Contact name", "Role", "Email (anon)", "Phone (anon)", "Credit terms"]);
  put(cu, 2, ["SYN-C1", "SYN Customer One", "Retail", "Rep A", null, "Contact 1", "Buyer", "x1", "p1", "30"]);
  put(cu, 3, ["SYN-C2", "SYN Customer Two", "Tender", "Rep B", null, "Contact 2", "Buyer", "x2", "p2", "30"]);
  put(cu, 4, ["SYN-C3", "SYN Customer Three", "Export", "Rep A", null, "Contact 3", "Buyer", "x3", "p3", "60"]);
  const q = wb.addWorksheet("Quotes");
  put(q, 1, ["Quote no", "Date", "Customer code", "Rep", "Style", "Qty", "Value (ZAR)", "Status", "Converted order no", "Lost reason", "Follow-up due"]);
  put(q, 2, ["Q-SYN-1", "2026-09-01", "SYN-C1", "Rep A", A, 100, 10000, "Won", "SO-SYN-1", null, "2026-09-10"]);
  put(q, 3, ["Q-SYN-2", "2026-09-05", "SYN-C2", "Rep B", B, 50, 5000, "Lost", null, "Price", "2026-09-12"]);
  put(q, 4, ["Q-SYN-3", "2026-10-01", "SYN-C3", "Rep A", A, 20, 2000, "Open", null, null, "2026-10-12"]);
  put(q, 5, ["Q-SYN-4", "2026-10-02", "SYN-C1", "Rep A", B, 10, 1000, "Won", "SO-SYN-2", null, "2026-10-15"]);

  return wb;
}

export async function originalShapedBuffer(mutate?: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = buildOriginalShapedWorkbook();
  mutate?.(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
