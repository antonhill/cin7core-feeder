import { describe, expect, it } from "vitest";
import { createReadOnlyClient } from "@/rwtsa-live/client";
import { inspectProductionOrder } from "@/rwtsa-live/production";
import { ACCOUNT, APPKEY, fakeFetch, noSleep } from "./helpers";

const creds = { accountId: ACCOUNT, applicationKey: APPKEY, instanceLabel: "i" };
const FG = "FG-1", C1 = "CMP-A", C2 = "CMP-B";
type Routes = Parameters<typeof fakeFetch>[0];
const listBody = (rows: unknown[]) => ({ Total: rows.length, ProductionOrderListItems: rows });
const LIST_ROW = { TaskID: "t1", ProductionOrderID: "po-1", Type: "O", OrderNumber: "MO-00001", ProductSku: FG, Status: "COMPLETED", CompletionDate: "2026-11-05T00:00:00" };
const orderBody = { ProductionOrders: [{ ProductionOrderID: "po-1", OrderNumber: "MO-00001", Status: "COMPLETED", ProductSku: FG, Quantity: 10, BomQuantity: 1, Operations: [
  { Name: "Cut", WorkCenterName: "Cutting", Components: [{ ProductSku: C1, Quantity: 5.5, WastageQty: 0 }, { ProductSku: C2, Quantity: 3, WastageQty: 0 }], Resources: [{ ResourceCode: "LAB", ResourceName: "Labour", Quantity: 10, Cost: 2.7, TotalCost: 27 }] },
] }] };
const runBody = (o: { c1?: number; c2?: number; status?: string; output?: unknown[] | null; opStatus?: string } = {}) => ({ Runs: [{ RunID: "r1", Number: 1, Status: o.status ?? "COMPLETED", Quantity: 10, Operations: [
  { OperationID: "op1", Order: 1, Name: "Cut", WorkCenterName: "Cutting", Status: o.opStatus ?? "COMPLETED", PlannedTime: 30, ActualTime: 41, StartDate: "2026-11-04T08:00:00", EndDate: "2026-11-04T09:00:00",
    Components: [{ ProductCode: C1, Quantity: o.c1 ?? 5.5, ExpectedQuantity: 5.5, WastageQty: 0, UnitCost: 18.5, LocationName: "Factory Store", IsBackflush: true }, { ProductCode: C2, Quantity: o.c2 ?? 3, ExpectedQuantity: 3, WastageQty: 0, UnitCost: 18.5, LocationName: "Factory Store", IsBackflush: false }],
    ResourceCosts: [{ ExpenseAccount: "5000", Cost: 27 }], FinishedProducts: [] }], Output: o.output === null ? [] : (o.output ?? [{ ProductCode: FG, Quantity: 10, WastageQuantity: 0, Received: true, ReceivedDate: "2026-11-05T00:00:00", LocationName: "Factory Store" }]) }] });
const mk = (routes: Routes) => { const f = fakeFetch(routes); return { f, c: createReadOnlyClient({ creds, fetchImpl: f.impl, sleep: noSleep, now: () => 0, minIntervalMs: 0 }) }; };
const routes = (over: Partial<Record<string, () => { status?: number; body?: unknown }>> = {}): Routes => ({
  "/production/orderList": () => ({ body: listBody([LIST_ROW, { ...LIST_ROW, TaskID: "t2", Type: "R" }]) }),
  "/production/order": () => ({ body: orderBody }),
  "/production/order/run": () => ({ body: runBody() }),
  ...over,
});

describe("production evidence collector (three GETs, read-only)", () => {
  it("makes exactly three GET requests to the three approved paths with the right query, and nothing else", async () => {
    const { f, c } = mk(routes());
    await inspectProductionOrder(c, "MO-00001");
    expect(f.calls.map((x) => `${x.method} ${new URL(x.url).pathname.replace("/ExternalApi/v2", "")}`)).toEqual(["GET /production/orderList", "GET /production/order", "GET /production/order/run"]);
    expect(new URL(f.calls[1].url).searchParams.get("ProductionOrderID")).toBe("po-1");
    expect(new URL(f.calls[2].url).searchParams.get("ProductionOrderID")).toBe("po-1");
    expect(new URL(f.calls[0].url).searchParams.get("Limit")).toBe("1000");
  });
  it("extracts the status, planned recipe, actual consumption, times, costs and the finished-goods receipt", async () => {
    const { c } = mk(routes());
    const e = await inspectProductionOrder(c, "MO-00001");
    expect(e.order).toMatchObject({ orderNumber: "MO-00001", status: "COMPLETED", productSku: FG });
    expect(e.order.plannedComponents).toEqual([{ sku: C1, recipeQuantity: 5.5, wastage: 0 }, { sku: C2, recipeQuantity: 3, wastage: 0 }]);
    expect(e.run?.operations[0]).toMatchObject({ name: "Cut", status: "COMPLETED", plannedTime: 30, actualTime: 41, resourceCostTotal: 27 });
    expect(e.run?.operations[0].components).toEqual([{ sku: C1, actual: 5.5, expected: 5.5, wastage: 0, unitCost: 18.5, location: "Factory Store", backflush: true }, { sku: C2, actual: 3, expected: 3, wastage: 0, unitCost: 18.5, location: "Factory Store", backflush: false }]);
    expect(e.run?.output).toEqual([{ sku: FG, quantity: 10, received: true, receivedDate: "2026-11-05T00:00:00", location: "Factory Store" }]);
    expect(e.requests).toBe(3);
  });
  it("records the observed field names and types (the contract) without values", async () => {
    const { c } = mk(routes());
    const e = await inspectProductionOrder(c, "MO-00001");
    expect(e.contract.runComponentFields).toEqual(expect.arrayContaining(["ProductCode:string", "Quantity:number", "ExpectedQuantity:number"]));
    expect(e.contract.orderListFields).toEqual(expect.arrayContaining(["OrderNumber:string", "Type:string"]));
    expect(JSON.stringify(e.contract)).not.toContain(C1);
  });
  it("never treats planned-equal actual quantities as proof of consumption (the movement export stays required)", async () => {
    const { c } = mk(routes());
    const e = await inspectProductionOrder(c, "MO-00001");
    expect(e.verdicts.consumption.status).toBe("REPORTED_EQUAL_TO_PLAN_NOT_INDEPENDENTLY_PROVEN");
    expect(e.verdicts.consumption.movementExportStillRequired).toBe(true);
  });
  it("zero actual quantities are NOT PROVEN; actuals that differ from plan are reported as such; either way the export requirement is retained", async () => {
    const zero = await inspectProductionOrder(mk(routes({ "/production/order/run": () => ({ body: runBody({ c1: 0, c2: 0 }) }) })).c, "MO-00001");
    expect(zero.verdicts.consumption.status).toBe("NOT_PROVEN_ACTUAL_ZERO");
    const diff = await inspectProductionOrder(mk(routes({ "/production/order/run": () => ({ body: runBody({ c1: 5.9 }) }) })).c, "MO-00001");
    expect(diff.verdicts.consumption.status).toBe("REPORTED_DIFFERS_FROM_PLAN_NOT_INDEPENDENTLY_PROVEN");
    for (const v of [zero, diff]) expect(v.verdicts.consumption.movementExportStillRequired).toBe(true);
  });
  it("no run at all, a non-complete run, or no received output is reported honestly", async () => {
    const none = await inspectProductionOrder(mk(routes({ "/production/order/run": () => ({ body: { Runs: [] } }) })).c, "MO-00001");
    expect(none.run).toBeNull(); expect(none.verdicts.consumption.status).toBe("NOT_PROVEN_NO_RUN");
    const open = await inspectProductionOrder(mk(routes({ "/production/order/run": () => ({ body: runBody({ status: "IN PROGRESS", opStatus: "PLANNED", c1: 0, c2: 0, output: null }) }) })).c, "MO-00001");
    expect(open.verdicts.receipt.status).toBe("NOT_RECEIVED");
    const unrec = await inspectProductionOrder(mk(routes({ "/production/order/run": () => ({ body: runBody({ output: [{ ProductCode: FG, Quantity: 10, Received: false }] }) }) })).c, "MO-00001");
    expect(unrec.verdicts.receipt.status).toBe("OUTPUT_PRESENT_NOT_RECEIVED");
    const ok = await inspectProductionOrder(mk(routes()).c, "MO-00001");
    expect(ok.verdicts.receipt.status).toBe("RECEIVED");
  });
  it("an output line without an explicit Received:true is not a receipt", async () => {
    const e = await inspectProductionOrder(mk(routes({ "/production/order/run": () => ({ body: runBody({ output: [{ ProductCode: FG, Quantity: 10 }] }) }) })).c, "MO-00001");
    expect(e.verdicts.receipt.status).toBe("OUTPUT_PRESENT_NOT_RECEIVED");
    expect(e.verdicts.receipt.receivedQuantity).toBe(0);
  });
  it("uses the latest run (highest Number) when an order has several", async () => {
    const older = runBody().Runs[0]; const newer = { ...runBody({ status: "IN PROGRESS", output: null, c1: 0, c2: 0 }).Runs[0], RunID: "r2", Number: 2 };
    const e = await inspectProductionOrder(mk(routes({ "/production/order/run": () => ({ body: { Runs: [older, newer] } }) })).c, "MO-00001");
    expect(e.run?.runId).toBe("r2");
    expect(e.verdicts.receipt.status).toBe("NOT_RECEIVED");
  });
  it("does not use the operation-level finished-product quantity (documented as unreliable)", async () => {
    const body = runBody(); (body.Runs[0].Operations[0] as Record<string, unknown>).FinishedProducts = [{ ProductSKU: FG, OutputQuantity: 2 }];
    const e = await inspectProductionOrder(mk(routes({ "/production/order/run": () => ({ body }) })).c, "MO-00001");
    expect(e.run?.output[0].quantity).toBe(10);
    expect(JSON.stringify(e)).not.toContain('"outputQuantity":2');
  });
  it("stops after the list, with no further request, when the order is absent or ambiguous", async () => {
    const absent = mk(routes({ "/production/orderList": () => ({ body: listBody([{ ...LIST_ROW, OrderNumber: "MO-00002" }]) }) }));
    await expect(inspectProductionOrder(absent.c, "MO-00001")).rejects.toThrow(/not found/i);
    expect(absent.f.calls).toHaveLength(1);
    const two = mk(routes({ "/production/orderList": () => ({ body: listBody([LIST_ROW, { ...LIST_ROW, TaskID: "t9", ProductionOrderID: "po-9" }]) }) }));
    await expect(inspectProductionOrder(two.c, "MO-00001")).rejects.toThrow(/more than one/i);
    expect(two.f.calls).toHaveLength(1);
  });
  it("only Type O rows identify the order (routing rows share the order number and must not double count)", async () => {
    const f = mk(routes({ "/production/orderList": () => ({ body: listBody([{ ...LIST_ROW, Type: "R", ProductionOrderID: "po-R" }, LIST_ROW]) }) }));
    const e = await inspectProductionOrder(f.c, "MO-00001");
    expect(new URL(f.f.calls[1].url).searchParams.get("ProductionOrderID")).toBe("po-1");
    expect(e.order.productionOrderId).toBe("po-1");
  });
  it("flags a list that may have more pages instead of making an unapproved extra request", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ ...LIST_ROW, TaskID: `x${i}`, OrderNumber: `MO-9${i}`, ProductionOrderID: `p${i}` }));
    rows[3] = { ...LIST_ROW, TaskID: "found" };
    const { f, c } = mk(routes({ "/production/orderList": () => ({ body: listBody(rows) }) }));
    const e = await inspectProductionOrder(c, "MO-00001");
    expect(e.findings.join(" ")).toMatch(/may have more/i);
    expect(f.calls).toHaveLength(3);
  });
  it("keeps the labour/resource cost honest: totals only where the API gives them, otherwise 'not available'", async () => {
    const body = runBody(); (body.Runs[0].Operations[0] as Record<string, unknown>).ResourceCosts = [];
    const e = await inspectProductionOrder(mk(routes({ "/production/order/run": () => ({ body }) })).c, "MO-00001");
    expect(e.run?.operations[0].resourceCostTotal).toBeNull();
    expect(e.verdicts.labourCost.status).toMatch(/NOT_AVAILABLE|PLANNED_ONLY/);
  });
  it("an unexpected response shape fails closed with a clear error and no invented fields", async () => {
    await expect(inspectProductionOrder(mk(routes({ "/production/orderList": () => ({ body: { Weird: [] } }) })).c, "MO-00001")).rejects.toThrow(/shape/i);
    await expect(inspectProductionOrder(mk(routes({ "/production/order": () => ({ body: { Nope: 1 } }) })).c, "MO-00001")).rejects.toThrow(/shape/i);
  });
});

describe("independent review fixes", () => {
  it("a VOIDED run never replaces the real run, and several live runs are surfaced instead of silently merged", async () => {
    const real = runBody().Runs[0]; const voided = { ...runBody({ output: [{ ProductCode: FG, Quantity: 10, Received: true }] }).Runs[0], RunID: "r2", Number: 2, Status: "VOIDED" };
    const e = await inspectProductionOrder(mk(routes({ "/production/order/run": () => ({ body: { Runs: [real, voided] } }) })).c, "MO-00001");
    expect(e.run?.runId).toBe("r1");
    expect(e.findings.join(" ")).toMatch(/voided/i);
    const second = { ...runBody().Runs[0], RunID: "r3", Number: 3 };
    const many = await inspectProductionOrder(mk(routes({ "/production/order/run": () => ({ body: { Runs: [real, second] } }) })).c, "MO-00001");
    expect(many.findings.join(" ")).toMatch(/more than one (live|non-void)/i);
    const allVoid = await inspectProductionOrder(mk(routes({ "/production/order/run": () => ({ body: { Runs: [voided] } }) })).c, "MO-00001");
    expect(allVoid.run).toBeNull();
    expect(allVoid.verdicts.consumption.status).toBe("NOT_PROVEN_NO_RUN");
  });
  it("the order response must be the order that was asked for (id and number)", async () => {
    const wrongId = { ProductionOrders: [{ ...orderBody.ProductionOrders[0], ProductionOrderID: "other" }] };
    await expect(inspectProductionOrder(mk(routes({ "/production/order": () => ({ body: wrongId }) })).c, "MO-00001")).rejects.toThrow(/different order/i);
    const wrongNo = { ProductionOrders: [{ ...orderBody.ProductionOrders[0], OrderNumber: "MO-00002" }] };
    await expect(inspectProductionOrder(mk(routes({ "/production/order": () => ({ body: wrongNo }) })).c, "MO-00001")).rejects.toThrow(/different order/i);
    const noId = { ProductionOrders: [{ ...orderBody.ProductionOrders[0], ProductionOrderID: undefined }] };
    await expect(inspectProductionOrder(mk(routes({ "/production/order": () => ({ body: noId }) })).c, "MO-00001")).rejects.toThrow(/different order|identif/i);
  });
  it("a run whose own order id is present must match; its absence is stated, not assumed", async () => {
    const mism = { Runs: [{ ...runBody().Runs[0], ProductionOrderID: "other" }] };
    await expect(inspectProductionOrder(mk(routes({ "/production/order/run": () => ({ body: mism }) })).c, "MO-00001")).rejects.toThrow(/different order/i);
    const e = await inspectProductionOrder(mk(routes()).c, "MO-00001");
    expect(e.findings.join(" ")).toMatch(/run response does not carry the order id/i);
  });
  it("malformed numbers are never turned into zeros: they are findings and the affected verdict is not claimed", async () => {
    const strQty = runBody(); (strQty.Runs[0].Operations[0].Components[0] as Record<string, unknown>).Quantity = "5";
    const a = await inspectProductionOrder(mk(routes({ "/production/order/run": () => ({ body: strQty }) })).c, "MO-00001");
    expect(a.findings.join(" ")).toMatch(/malformed/i);
    expect(a.verdicts.consumption.status).toBe("NOT_PROVEN_MALFORMED_RESPONSE");
    const badCost = runBody(); (badCost.Runs[0].Operations[0] as Record<string, unknown>).ResourceCosts = [{ ExpenseAccount: "5000", Cost: "12.5" }];
    const b = await inspectProductionOrder(mk(routes({ "/production/order/run": () => ({ body: badCost }) })).c, "MO-00001");
    expect(b.run?.operations[0].resourceCostTotal).toBeNull();
    expect(b.verdicts.labourCost.status).toBe("NOT_AVAILABLE_ACTUAL_COST");
    const badOut = runBody({ output: [{ ProductCode: FG, Quantity: "10", Received: true }] });
    const c = await inspectProductionOrder(mk(routes({ "/production/order/run": () => ({ body: badOut }) })).c, "MO-00001");
    expect(c.verdicts.receipt.status).toBe("MALFORMED_RESPONSE");
  });
  it("a zero actual time is not 'actual time reported'", async () => {
    const z = runBody(); (z.Runs[0].Operations[0] as Record<string, unknown>).ActualTime = 0;
    const e = await inspectProductionOrder(mk(routes({ "/production/order/run": () => ({ body: z }) })).c, "MO-00001");
    expect(e.verdicts.operationTimes.status).toBe("NOT_AVAILABLE");
  });
  it("a partial receipt, or a receipt of zero units, is not a full RECEIVED", async () => {
    const part = await inspectProductionOrder(mk(routes({ "/production/order/run": () => ({ body: runBody({ output: [{ ProductCode: FG, Quantity: 6, Received: true }, { ProductCode: FG, Quantity: 4, Received: false }] }) }) })).c, "MO-00001");
    expect(part.verdicts.receipt.status).toBe("PARTIALLY_RECEIVED");
    const zero = await inspectProductionOrder(mk(routes({ "/production/order/run": () => ({ body: runBody({ output: [{ ProductCode: FG, Quantity: 0, Received: true }] }) }) })).c, "MO-00001");
    expect(zero.verdicts.receipt.status).not.toBe("RECEIVED");
  });
  it("an order missing from a full first page says the list may be truncated", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ ...LIST_ROW, TaskID: `x${i}`, OrderNumber: `MO-9${i}`, ProductionOrderID: `p${i}` }));
    await expect(inspectProductionOrder(mk(routes({ "/production/orderList": () => ({ body: listBody(rows) }) })).c, "MO-00001")).rejects.toThrow(/truncated|later page/i);
  });
  it("states the recipe basis explicitly (BomQuantity) next to the recipe quantities", async () => {
    const e = await inspectProductionOrder(mk(routes()).c, "MO-00001");
    expect(e.order.bomQuantity).toBe(1);
    expect(e.order.plannedComponents[0]).toHaveProperty("recipeQuantity");
  });
});
