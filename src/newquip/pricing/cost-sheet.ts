// COST-SHEET RETURN (preparation only). NewQuip returns the "Cost approval" sheet with, per SKU, an approved cost, currency, price date, basis, approver and approval date. This PURE module validates those rows and
// returns accepted records with explicit provenance, or rejections with the exact reason. It performs NO import, NO Cin7 write and NO inventory-valuation change: applying an accepted record is a separate,
// separately authorised step. Nothing is ever defaulted or inferred: a row with any missing or doubtful field is REJECTED, never repaired.
export const COST_SHEET_COLUMNS = {
  sku: "SKU",
  cost: "NEWQUIP: approved cost (ZAR ex VAT)",
  currency: "Currency",
  priceDate: "Price date (YYYY-MM-DD)",
  basis: "Basis (last purchase / quote)",
  approvedBy: "Approved by",
  approvalDate: "Approval date",
} as const;

export type CostSheetCurrency = "ZAR" | "EUR" | "USD";
export interface CostSheetRow { [column: string]: unknown }
export interface AcceptedCost {
  sku: string;
  /** The approved unit cost, ex VAT, in `currency` (up to 7 decimals, never rounded). */
  unitCost: number;
  currency: CostSheetCurrency;
  priceDate: string;
  basis: string;
  approvedBy: string;
  approvalDate: string;
  /** Sage "latest" figures are LANDED ZAR costs (purchase cost plus additional landed cost). A ZAR cost must NOT receive the engine's freight factor again; a EUR/USD supplier-native price must. */
  freightTreatment: "landed_zar_no_extra_freight" | "supplier_native_engine_freight";
  provenance: "newquip_cost_sheet";
  /** Always false: accepting a row does not write anything anywhere. */
  applied: false;
}
export interface RejectedCost { row: number; sku: string; reason: string }
export interface CostSheetResult { accepted: AcceptedCost[]; rejected: RejectedCost[] }

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const PLAIN_SKU = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const isRealDate = (s: string): boolean => ISO.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const dateText = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : text(v));

export function ingestCostSheet(rows: readonly CostSheetRow[], today: string): CostSheetResult {
  const out: CostSheetResult = { accepted: [], rejected: [] };
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const rowNo = i + 1;
    const skuRaw = text(r[COST_SHEET_COLUMNS.sku]);
    const reject = (reason: string) => { out.rejected.push({ row: rowNo, sku: skuRaw, reason }); };
    const costCell = r[COST_SHEET_COLUMNS.cost];
    // A row NewQuip has not filled in is simply not answered yet (not an error and not accepted).
    if (costCell === undefined || costCell === null || text(costCell) === "") { reject("Not answered: no approved cost entered."); return; }
    if (!PLAIN_SKU.test(skuRaw)) { reject("The SKU cell is not a plain product code (it still carries a query or a note): resolve the query first."); return; }
    if (seen.has(skuRaw)) { reject("Duplicate SKU in the sheet."); return; }
    const cost = typeof costCell === "number" ? costCell : Number(text(costCell).replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(cost) || cost <= 0) { reject("The approved cost must be a number greater than zero."); return; }
    if (Number(cost.toFixed(7)) !== cost) { reject("The approved cost has more than 7 decimals: it would have to be rounded."); return; }
    const currency = text(r[COST_SHEET_COLUMNS.currency]).toUpperCase();
    if (currency !== "ZAR" && currency !== "EUR" && currency !== "USD") { reject("The currency must be ZAR, EUR or USD."); return; }
    const priceDate = dateText(r[COST_SHEET_COLUMNS.priceDate]);
    if (!isRealDate(priceDate)) { reject("The price date is missing or not a real YYYY-MM-DD date."); return; }
    if (priceDate > today) { reject("The price date is in the future."); return; }
    const basis = text(r[COST_SHEET_COLUMNS.basis]);
    if (basis.length < 4) { reject("The basis (last purchase, quotation or list) is required."); return; }
    const approvedBy = text(r[COST_SHEET_COLUMNS.approvedBy]);
    if (approvedBy.length < 3 || /^\d+$/.test(approvedBy)) { reject("The approver's name is required."); return; }
    const approvalDate = dateText(r[COST_SHEET_COLUMNS.approvalDate]);
    if (!isRealDate(approvalDate)) { reject("The approval date is missing or not a real YYYY-MM-DD date."); return; }
    if (approvalDate > today) { reject("The approval date is in the future."); return; }
    if (approvalDate < priceDate) { reject("The approval date is earlier than the price date."); return; }
    seen.add(skuRaw);
    out.accepted.push({ sku: skuRaw, unitCost: cost, currency, priceDate, basis, approvedBy, approvalDate, freightTreatment: currency === "ZAR" ? "landed_zar_no_extra_freight" : "supplier_native_engine_freight", provenance: "newquip_cost_sheet", applied: false });
  });
  return out;
}
