// RWTSA Phase 3 (read-only): evidence for ONE manufacture order from three GETs - the order list, the order (planned recipe) and its run (actuals).
// It never writes, never makes a fourth request, and never invents a field the API did not return. It does NOT treat planned quantities, or an actual
// quantity that merely equals the plan, as proof of material consumption: independent proof is an Inventory Movement export (see verdicts.consumption).
import type { ReadOnlyClient } from "./client";
import { RwtsaLiveError } from "./types";

type Row = Record<string, unknown>;
const LIST_LIMIT = 1000;
const EPS = 1e-9;
const bad = (m: string): never => { throw new RwtsaLiveError("BAD_RESPONSE", m); };
const isRow = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.filter(isRow) : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v.trim() : null);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const num = (v: unknown): number => numOrNull(v) ?? 0;
/** A numeric field that is present but not a finite number is MALFORMED (never silently read as 0). Absent -> null. */
const present = (v: unknown) => v !== undefined && v !== null;
const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
/** "Name:type" pairs (never values), unioned across rows. */
function fields(xs: readonly Row[]): string[] {
  const m = new Map<string, Set<string>>();
  for (const r of xs) for (const [k, v] of Object.entries(r)) (m.get(k) ?? m.set(k, new Set()).get(k)!).add(typeOf(v));
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([k, ts]) => [...ts].sort().map((t) => `${k}:${t}`));
}

/** `recipeQuantity` is the quantity as stated on the ORDER recipe; its basis is `order.bomQuantity` (not assumed). The run reports its own expected quantity for the run quantity. */
export interface PlannedComponent { sku: string; recipeQuantity: number; wastage: number }
export interface RunComponent { sku: string; actual: number; expected: number; wastage: number; unitCost: number; location: string | null; backflush: boolean | null }
export interface RunOperation {
  id: string; order: number; name: string | null; workCenter: string | null; status: string; plannedTime: number | null; actualTime: number | null; startDate: string | null; endDate: string | null;
  components: RunComponent[]; resourceCostTotal: number | null; resourceCostLines: number;
}
export interface OutputLine { sku: string | null; quantity: number; received: boolean; receivedDate: string | null; location: string | null }
export interface ProductionEvidence {
  takenAt: string; requests: number; methodsUsed: string[];
  contract: Record<"orderListFields" | "orderFields" | "orderOperationFields" | "orderComponentFields" | "orderResourceFields" | "runFields" | "runOperationFields" | "runComponentFields" | "runResourceCostFields" | "runOutputFields", string[]>;
  order: { productionOrderId: string; orderNumber: string; status: string | null; productSku: string | null; quantity: number | null; plannedComponents: PlannedComponent[]; bomQuantity: number | null; plannedResources: { operation: string | null; code: string | null; name: string | null; quantity: number | null; cost: number | null; totalCost: number | null }[] };
  run: { runId: string; number: number; status: string; quantity: number; operations: RunOperation[]; output: OutputLine[] } | null;
  verdicts: {
    orderStatus: { status: string };
    consumption: { status: "NOT_PROVEN_NO_RUN" | "NOT_PROVEN_NO_COMPONENTS" | "NOT_PROVEN_MALFORMED_RESPONSE" | "NOT_PROVEN_ACTUAL_ZERO" | "REPORTED_EQUAL_TO_PLAN_NOT_INDEPENDENTLY_PROVEN" | "REPORTED_DIFFERS_FROM_PLAN_NOT_INDEPENDENTLY_PROVEN"; plannedComponentsMissingFromRun: string[]; movementExportStillRequired: true; note: string };
    receipt: { status: "NOT_RECEIVED" | "OUTPUT_PRESENT_NOT_RECEIVED" | "PARTIALLY_RECEIVED" | "RECEIVED" | "MALFORMED_RESPONSE"; receivedQuantity: number; outputLines: number; receivedLines: number };
    operationTimes: { status: "ACTUAL_REPORTED_ALL_OPERATIONS" | "PARTIAL" | "NOT_AVAILABLE"; note: string };
    labourCost: { status: "ACTUAL_OPERATION_COST_REPORTED" | "PARTIAL_OPERATION_COST" | "NOT_AVAILABLE_ACTUAL_COST" | "PLANNED_ONLY"; note: string };
  };
  findings: string[];
}

export async function inspectProductionOrder(client: ReadOnlyClient, orderNumber: string, opts: { takenAt?: string } = {}): Promise<ProductionEvidence> {
  const findings: string[] = [];
  // 1. the list: identifies the order (Type "O" only: routing rows share the order number)
  const list = await client.get<Row>("/production/orderList", { Page: 1, Limit: LIST_LIMIT });
  if (!isRow(list) || !Array.isArray(list.ProductionOrderListItems)) bad("Unexpected response shape from the production order list (ProductionOrderListItems is missing).");
  const listRows = rows(list.ProductionOrderListItems);
  if (listRows.length >= LIST_LIMIT) findings.push(`The order list returned ${listRows.length} rows and may have more pages; no further page was requested (outside the approved three requests).`);
  const hits = listRows.filter((r) => r.Type === "O" && r.OrderNumber === orderNumber);
  const ids = [...new Set(hits.map((r) => str(r.ProductionOrderID)).filter((x): x is string => !!x))];
  if (ids.length === 0) throw new RwtsaLiveError("BAD_RESPONSE", listRows.length >= LIST_LIMIT
    ? "The manufacture order was not found on the first page of the order list; the list may be truncated and the order may be on a later page (not searched: outside the approved requests)."
    : "The manufacture order was not found in the order list (no further request was made).");
  if (ids.length > 1) throw new RwtsaLiveError("BAD_RESPONSE", "More than one manufacture order matched that number (no further request was made).");
  const productionOrderId = ids[0];
  const listStatus = str(hits[0].Status);

  // 2. the order: the PLANNED recipe
  const od = await client.get<Row>("/production/order", { ProductionOrderID: productionOrderId, ReturnAttachmentsContent: "false" });
  const orderRows = isRow(od) ? rows(od.ProductionOrders) : [];
  if (orderRows.length === 0) bad("Unexpected response shape from the production order (ProductionOrders is missing or empty).");
  const o = orderRows[0];
  if (str(o.ProductionOrderID) !== productionOrderId || (o.OrderNumber !== undefined && str(o.OrderNumber) !== orderNumber)) bad("The production order response is for a different order (or does not identify itself); nothing was recorded.");
  const ops = rows(o.Operations);
  const compRows = ops.flatMap((op) => rows(op.Components));
  const resRows = ops.flatMap((op) => rows(op.Resources).map((r) => ({ op, r })));
  const planned = new Map<string, PlannedComponent>();
  for (const c of compRows) {
    const sku = str(c.ProductSku); if (!sku) continue;
    const cur = planned.get(sku) ?? { sku, recipeQuantity: 0, wastage: 0 };
    cur.recipeQuantity += num(c.Quantity); cur.wastage += num(c.WastageQty); planned.set(sku, cur);
  }

  // 3. the run: ACTUALS
  const rd = await client.get<Row>("/production/order/run", { ProductionOrderID: productionOrderId });
  if (!isRow(rd) || !Array.isArray(rd.Runs)) bad("Unexpected response shape from the production run (Runs is missing).");
  const allRuns = rows(rd.Runs);
  const isVoid = (r: Row) => /^(voided?|cancell?ed)$/i.test(String(r.Status ?? "").trim());
  for (const r of allRuns) if (str(r.ProductionOrderID) !== null && str(r.ProductionOrderID) !== productionOrderId) bad("The production run response is for a different order; nothing was recorded.");
  if (!allRuns.some((r) => str(r.ProductionOrderID) !== null)) findings.push("The run response does not carry the order id; the association with this order rests on the request filter.");
  const runRows = allRuns.filter((r) => !isVoid(r)).sort((a, b) => num(b.Number) - num(a.Number));
  if (allRuns.length > runRows.length) findings.push(`${allRuns.length - runRows.length} voided/cancelled run(s) were ignored.`);
  if (runRows.length > 1) findings.push(`More than one live run exists (${runRows.length}); the latest was used and runs were not merged.`);
  const rr = runRows[0] ?? null;
  const runOps = rr ? rows(rr.Operations) : [];
  const runComps = runOps.flatMap((op) => rows(op.Components));
  const runCosts = runOps.flatMap((op) => rows(op.ResourceCosts));
  const outRows = rr ? rows(rr.Output) : [];

  const malformed = new Set<string>();
  const strict = (v: unknown, what: string): number => { if (!present(v)) return 0; if (typeof v === "number" && Number.isFinite(v)) return v; malformed.add(what); return 0; };
  const reqNum = (v: unknown, what: string): number => { if (typeof v === "number" && Number.isFinite(v)) return v; malformed.add(what); return 0; };
  const run: ProductionEvidence["run"] = rr ? {
    runId: String(rr.RunID ?? ""), number: num(rr.Number), status: String(rr.Status ?? ""), quantity: num(rr.Quantity),
    operations: runOps.map((op) => {
      const costs = rows(op.ResourceCosts);
      const costOk = costs.length > 0 && costs.every((c) => typeof c.Cost === "number" && Number.isFinite(c.Cost));
      if (costs.some((c) => present(c.Cost) && !(typeof c.Cost === "number" && Number.isFinite(c.Cost)))) malformed.add("operation resource cost");
      return {
        id: String(op.OperationID ?? ""), order: num(op.Order), name: str(op.Name), workCenter: str(op.WorkCenterName), status: String(op.Status ?? ""),
        plannedTime: numOrNull(op.PlannedTime), actualTime: numOrNull(op.ActualTime), startDate: str(op.StartDate), endDate: str(op.EndDate),
        components: rows(op.Components).map((c) => ({ sku: str(c.ProductCode) ?? "", actual: reqNum(c.Quantity, "component actual quantity"), expected: reqNum(c.ExpectedQuantity, "component expected quantity"), wastage: strict(c.WastageQty, "component wastage"), unitCost: strict(c.UnitCost, "component unit cost"), location: str(c.LocationName), backflush: typeof c.IsBackflush === "boolean" ? c.IsBackflush : null })),
        resourceCostTotal: costOk ? costs.reduce((t, c) => t + (c.Cost as number), 0) : null, resourceCostLines: costs.length,
      };
    }).sort((a, b) => a.order - b.order),
    // The run-level Output[] is the reliable receipt; the operation-level FinishedProducts quantity is documented as unreliable and is deliberately NOT read.
    output: outRows.map((x) => ({ sku: str(x.ProductCode), quantity: reqNum(x.Quantity, "output quantity"), received: x.Received === true, receivedDate: str(x.ReceivedDate), location: str(x.LocationName) })),
  } : null;

  if (malformed.size) findings.push(`Malformed numeric field(s) in the run response: ${[...malformed].sort().join("; ")}. The affected verdicts are not claimed.`);
  const allComps = run ? run.operations.flatMap((x) => x.components) : [];
  const runSkus = new Set(allComps.map((c) => c.sku));
  const missing = [...planned.keys()].filter((s) => !runSkus.has(s));
  if (missing.length) findings.push(`${missing.length} planned component(s) do not appear in the run.`);
  const compMalformed = [...malformed].some((m) => m.startsWith("component"));
  const consumptionStatus: ProductionEvidence["verdicts"]["consumption"]["status"] = !run ? "NOT_PROVEN_NO_RUN" : compMalformed ? "NOT_PROVEN_MALFORMED_RESPONSE" : allComps.length === 0 ? "NOT_PROVEN_NO_COMPONENTS"
    : allComps.every((c) => Math.abs(c.actual) < EPS) ? "NOT_PROVEN_ACTUAL_ZERO"
    : allComps.every((c) => Math.abs(c.actual - c.expected) < EPS) ? "REPORTED_EQUAL_TO_PLAN_NOT_INDEPENDENTLY_PROVEN" : "REPORTED_DIFFERS_FROM_PLAN_NOT_INDEPENDENTLY_PROVEN";
  const received = run ? run.output.filter((x) => x.received).reduce((t, x) => t + x.quantity, 0) : 0;
  const receivedLines = run ? run.output.filter((x) => x.received).length : 0;
  const receiptStatus: ProductionEvidence["verdicts"]["receipt"]["status"] = [...malformed].includes("output quantity") ? "MALFORMED_RESPONSE" : !run || run.output.length === 0 ? "NOT_RECEIVED"
    : received > 0 && receivedLines === run.output.length ? "RECEIVED" : received > 0 ? "PARTIALLY_RECEIVED" : "OUTPUT_PRESENT_NOT_RECEIVED";
  const withActual = run ? run.operations.filter((x) => x.actualTime !== null && x.actualTime > 0).length : 0;
  const withCost = run ? run.operations.filter((x) => x.resourceCostTotal !== null).length : 0;
  const nOps = run ? run.operations.length : 0;

  return {
    takenAt: opts.takenAt ?? new Date().toISOString(), requests: client.requests(), methodsUsed: client.methodsUsed(),
    contract: {
      orderListFields: fields(listRows), orderFields: fields([o]), orderOperationFields: fields(ops), orderComponentFields: fields(compRows), orderResourceFields: fields(resRows.map((x) => x.r)),
      runFields: fields(rr ? [rr] : []), runOperationFields: fields(runOps), runComponentFields: fields(runComps), runResourceCostFields: fields(runCosts), runOutputFields: fields(outRows),
    },
    order: {
      productionOrderId, orderNumber, status: str(o.Status) ?? listStatus, productSku: str(o.ProductSku), quantity: numOrNull(o.Quantity), bomQuantity: numOrNull(o.BomQuantity),
      plannedComponents: [...planned.values()],
      plannedResources: resRows.map(({ op, r }) => ({ operation: str(op.Name), code: str(r.ResourceCode), name: str(r.ResourceName), quantity: numOrNull(r.Quantity), cost: numOrNull(r.Cost), totalCost: numOrNull(r.TotalCost) })),
    },
    run,
    verdicts: {
      orderStatus: { status: str(o.Status) ?? listStatus ?? "UNKNOWN" },
      consumption: { status: consumptionStatus, plannedComponentsMissingFromRun: missing, movementExportStillRequired: true,
        note: "The run view reports an actual-quantity field per component, but the API alone cannot show that stock was really issued (an actual equal to the plan is indistinguishable from a copied plan; zero proves nothing). The Inventory Movement Details export remains the independent evidence." },
      receipt: { status: receiptStatus, receivedQuantity: received, outputLines: run ? run.output.length : 0, receivedLines },
      operationTimes: { status: nOps > 0 && withActual === nOps ? "ACTUAL_REPORTED_ALL_OPERATIONS" : withActual > 0 ? "PARTIAL" : "NOT_AVAILABLE", note: "Planned and actual times are shown as Cin7 reports them; their units are not asserted here and must be confirmed against the Cin7 screen." },
      labourCost: !run ? { status: "PLANNED_ONLY", note: "No run: only planned resource costs exist." }
        : { status: nOps > 0 && withCost === nOps ? "ACTUAL_OPERATION_COST_REPORTED" : withCost > 0 ? "PARTIAL_OPERATION_COST" : "NOT_AVAILABLE_ACTUAL_COST", note: "The run reports one actual cost per operation; a per-resource labour split and any overhead are not reported by this endpoint." },
    },
    findings,
  };
}
