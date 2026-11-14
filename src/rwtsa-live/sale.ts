// RWTSA (read-only): verify ONE sales order against what the owner expects. Two GETs: /saleList?Search= (resolve the sale ID from the order number) and /sale?ID= (the detail).
// Never writes. Every check is PASS / FAIL / UNVERIFIED: a response shape this collector does not recognise is UNVERIFIED, never a pass and never a quiet "no such order".
// Allocation is reported as INDIRECT evidence only (an authorised order with no backorder on any line); the independent proof is the per-SKU Allocated figure on the Cin7 availability report.
import type { ReadOnlyClient } from "./client";
import { RwtsaLiveError } from "./types";

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.filter(isRow) : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v.trim() : null);
const fin = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bad = (m: string): never => { throw new RwtsaLiveError("BAD_RESPONSE", m); };
const fold = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const LIST_LIMIT = 50;

export interface SaleExpectations { orderNumber: string; customer: string; sourceReference: string; lineCount: number; totalExTax: number }
export type CheckStatus = "PASS" | "FAIL" | "UNVERIFIED";
export interface SaleCheck { id: "customer" | "sourceReference" | "lineCount" | "totalExTax" | "orderStatus"; status: CheckStatus; detail: string }
export interface SaleAllocation { status: "NO_BACKORDER_INDIRECT_EVIDENCE" | "BACKORDER_PRESENT" | "UNVERIFIED"; backorderUnits: number | null; linesWithBackorder: number; fulfilmentCount: number | null; note: string }
export interface SaleEvidence {
  takenAt: string; requests: number; methodsUsed: string[]; expectations: SaleExpectations;
  status: "SALE_FOUND" | "SALE_NOT_FOUND" | "UNVERIFIED";
  unverifiedReason: string | null;
  saleId: string | null;
  observed: { customer: string | null; orderStatus: string | null; totalBeforeTax: number | null; lineCount: number | null; distinctSkus: number | null; linesTotalSum: number | null; additionalChargesTotalSum: number | null; sourceReferenceField: string | null } | null;
  checks: SaleCheck[];
  allocation: SaleAllocation | null;
  /** MATCH only if every check PASSes; allocation stays INDIRECT evidence so the strongest verdict is MATCH_ALLOCATION_INDIRECT. */
  verdict: "MATCH_ALLOCATION_INDIRECT" | "MISMATCH" | "UNVERIFIED" | "NOT_FOUND";
  responseTopLevelFields: string[]; orderFields: string[];
}

export async function inspectSale(client: ReadOnlyClient, exp: SaleExpectations, opts: { takenAt?: string } = {}): Promise<SaleEvidence> {
  const takenAt = opts.takenAt ?? new Date().toISOString();
  const base = (status: SaleEvidence["status"], verdict: SaleEvidence["verdict"], extra: Partial<SaleEvidence> = {}): SaleEvidence =>
    ({ takenAt, requests: client.requests(), methodsUsed: client.methodsUsed(), expectations: exp, status, unverifiedReason: null, saleId: null, observed: null, checks: [], allocation: null, verdict, responseTopLevelFields: [], orderFields: [], ...extra });

  const list = await client.get<Row>("/saleList", { Search: exp.orderNumber, Page: 1, Limit: LIST_LIMIT });
  if (!isRow(list) || !Array.isArray(list.SaleList)) bad("Unexpected response shape from the sale list (SaleList is missing).");
  const listRows = rows(list.SaleList);
  const hits = listRows.filter((r) => str(r.OrderNumber) === exp.orderNumber);
  if (hits.length === 0) {
    if (listRows.length >= LIST_LIMIT) return base("UNVERIFIED", "UNVERIFIED", { unverifiedReason: "The sale list was full without a match, so it may be truncated or the search filter ignored; absence cannot be concluded." });
    return base("SALE_NOT_FOUND", "NOT_FOUND");
  }
  const ids = [...new Set(hits.map((r) => str(r.SaleID)).filter((x): x is string => !!x))];
  if (hits.length > 1 || ids.length !== 1) return base("UNVERIFIED", "UNVERIFIED", { unverifiedReason: "The order number did not resolve to exactly one sale ID; no detail request was made." });
  const saleId = ids[0];

  const sale = await client.get<Row>("/sale", { ID: saleId });
  if (!isRow(sale)) bad("Unexpected response shape from the sale detail.");
  if (str(sale.ID) !== saleId) bad("The sale detail response is for a different sale (or does not identify itself); nothing was recorded.");
  const top = Object.keys(sale).sort();
  const order = isRow(sale.Order) ? sale.Order : null;
  if (!order) return base("UNVERIFIED", "UNVERIFIED", { saleId, responseTopLevelFields: top, unverifiedReason: "The sale detail has no Order object, so nothing about it can be verified." });
  if (str(order.SaleOrderNumber) !== exp.orderNumber) bad("The sale detail carries a different order number than the one requested; nothing was recorded.");
  const orderFields = Object.keys(order).sort();

  const lines = Array.isArray(order.Lines) ? rows(order.Lines) : null;
  const linesWellFormed = lines !== null && lines.length === (order.Lines as unknown[]).length && lines.every((l) => str(l.SKU) && (fin(l.Quantity) ?? 0) > 0);
  const distinctSkus = lines ? new Set(lines.map((l) => str(l.SKU)).filter(Boolean)).size : null;
  const charges = Array.isArray(order.AdditionalCharges) ? rows(order.AdditionalCharges) : [];
  const sum = (xs: Row[], k: string): number | null => (xs.every((x) => fin(x[k]) !== null) ? xs.reduce((t, x) => t + (x[k] as number), 0) : null);
  const customer = str(sale.Customer);
  const orderStatus = str(order.Status);
  const total = fin(order.TotalBeforeTax);

  // Where the source reference (the quotation number) is recorded: exact match on the customer reference or the external ID.
  const refField = (["CustomerReference", "ExternalID"] as const).find((k) => str(sale[k]) !== null && fold(str(sale[k])!) === fold(exp.sourceReference)) ?? null;
  const refInNote = typeof sale.Note === "string" && fold(sale.Note).includes(fold(exp.sourceReference));
  const refPresent = (["CustomerReference", "ExternalID"] as const).some((k) => str(sale[k]) !== null && str(sale[k]) !== "");

  const checks: SaleCheck[] = [
    customer === null ? { id: "customer", status: "UNVERIFIED", detail: "The sale detail carries no customer name." }
      : fold(customer) === fold(exp.customer) ? { id: "customer", status: "PASS", detail: "Customer name matches." } : { id: "customer", status: "FAIL", detail: "Customer name differs from the expected customer." },
    refField ? { id: "sourceReference", status: "PASS", detail: `The source reference is recorded in ${refField}.` }
      : refInNote ? { id: "sourceReference", status: "UNVERIFIED", detail: "The source reference appears only in the free-text Note, not in a reference field." }
      : refPresent ? { id: "sourceReference", status: "FAIL", detail: "A reference field is set but does not equal the expected source reference." }
      : { id: "sourceReference", status: "UNVERIFIED", detail: "No reference field (CustomerReference, ExternalID) is set, so the source quotation cannot be tied to this order." },
    !linesWellFormed || lines === null ? { id: "lineCount", status: "UNVERIFIED", detail: "Order lines are missing or malformed (blank SKU or non-positive quantity)." }
      : lines.length === exp.lineCount && distinctSkus === exp.lineCount ? { id: "lineCount", status: "PASS", detail: `${lines.length} lines, ${distinctSkus} distinct SKUs.` }
      : { id: "lineCount", status: "FAIL", detail: `${lines.length} lines, ${distinctSkus} distinct SKUs; expected ${exp.lineCount} distinct.` },
    total === null ? { id: "totalExTax", status: "UNVERIFIED", detail: "Order.TotalBeforeTax is missing or not a number." }
      : Math.abs(total - exp.totalExTax) < 0.005 ? { id: "totalExTax", status: "PASS", detail: "Total excluding tax matches." } : { id: "totalExTax", status: "FAIL", detail: `Total excluding tax is ${total}; expected ${exp.totalExTax}.` },
    orderStatus === null ? { id: "orderStatus", status: "UNVERIFIED", detail: "Order.Status is missing." }
      : orderStatus.toUpperCase() === "AUTHORISED" ? { id: "orderStatus", status: "PASS", detail: "Order status is AUTHORISED." } : { id: "orderStatus", status: "FAIL", detail: `Order status is ${orderStatus}, not AUTHORISED.` },
  ];

  const backs = lines ? lines.map((l) => (l.BackorderQuantity === undefined || l.BackorderQuantity === null ? null : fin(l.BackorderQuantity))) : [];
  const backKnown = lines !== null && lines.length > 0 && backs.every((b) => b !== null && b >= 0);
  const backUnits = backKnown ? (backs as number[]).reduce((t, b) => t + b, 0) : null;
  const fulfilments = Array.isArray(sale.Fulfilments) ? sale.Fulfilments.length : null;
  const orderAuthorised = orderStatus?.toUpperCase() === "AUTHORISED";
  const allocation: SaleAllocation = !backKnown || !orderAuthorised
    ? { status: "UNVERIFIED", backorderUnits: backUnits, linesWithBackorder: backKnown ? (backs as number[]).filter((b) => b > 0).length : 0, fulfilmentCount: fulfilments, note: "Backorder quantities are absent on one or more lines, or the order is not authorised, so allocation is not indicated." }
    : backUnits! > 0 ? { status: "BACKORDER_PRESENT", backorderUnits: backUnits, linesWithBackorder: (backs as number[]).filter((b) => b > 0).length, fulfilmentCount: fulfilments, note: "Some quantity is on backorder, so it is not fully allocated." }
    : { status: "NO_BACKORDER_INDIRECT_EVIDENCE", backorderUnits: 0, linesWithBackorder: 0, fulfilmentCount: fulfilments, note: "Authorised with no backorder on any line. This is indirect: the independent evidence is the per-SKU Allocated quantity on the Cin7 availability report or a screenshot of the allocation." };

  const anyFail = checks.some((c) => c.status === "FAIL") || allocation.status === "BACKORDER_PRESENT";
  const anyUnv = checks.some((c) => c.status === "UNVERIFIED") || allocation.status === "UNVERIFIED";
  return base("SALE_FOUND", anyFail ? "MISMATCH" : anyUnv ? "UNVERIFIED" : "MATCH_ALLOCATION_INDIRECT", {
    saleId, checks, allocation, responseTopLevelFields: top, orderFields,
    observed: { customer, orderStatus, totalBeforeTax: total, lineCount: lines ? lines.length : null, distinctSkus, linesTotalSum: lines ? sum(lines, "Total") : null, additionalChargesTotalSum: sum(charges, "Total"), sourceReferenceField: refField },
  });
}
