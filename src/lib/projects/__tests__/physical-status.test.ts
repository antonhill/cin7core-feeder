import { describe, expect, it } from "vitest";
import { buildPhysicalStatus, type PhysicalInputs } from "../physical-status";
import { loadPhysicalStatus, type PhysicalPort } from "../physical-store";
import { FakeDb } from "./fake-db";

const base = (): PhysicalInputs => ({
  ordered: [{ sku: "A", name: "Feeder", quantity: 10 }, { sku: "B", name: "Door", quantity: 4 }],
  invoices: [], fulfilments: [],
  stock: { A: { onHand: 3, allocated: 1, available: 2 }, B: { onHand: 10, allocated: 0, available: 10 } },
  assemblies: [],
});
const row = (i: PhysicalInputs, sku: string) => buildPhysicalStatus(i).rows.find((r) => r.sku === sku)!;

describe("physical status", () => {
  it("ordered, remaining and shortfall; commercial progress plays no part", () => {
    const r = row(base(), "A");
    expect(r).toMatchObject({ ordered: 10, invoiced: 0, shipped: 0, remaining: 10, onHand: 3, available: 2, shortfall: 8 });
    expect(row(base(), "B")).toMatchObject({ remaining: 4, shortfall: 0 });
  });
  it("invoiced and shipped are independent: invoicing at R0 does not ship, shipping does not invoice", () => {
    const i = base();
    i.invoices = [{ invoiceNumber: "INV-1", status: "DRAFT", lines: [{ sku: "A", quantity: 6 }] }];
    i.fulfilments = [{ number: 1, packLines: [{ sku: "A", quantity: 2 }], shipped: true }, { number: 2, packLines: [{ sku: "A", quantity: 5 }], shipped: false }];
    expect(row(i, "A")).toMatchObject({ invoiced: 6, shipped: 2, remaining: 8 });
  });
  it("voided invoices free their quantity", () => {
    const i = base();
    i.invoices = [{ invoiceNumber: "INV-1", status: "VOIDED", lines: [{ sku: "A", quantity: 6 }] }, { invoiceNumber: "INV-2", status: "AUTHORISED", lines: [{ sku: "A", quantity: 1 }] }];
    expect(row(i, "A").invoiced).toBe(1);
  });
  it("unknown is null, never zero: unreadable invoice lines / quantities blank the figure and are not silently summed", () => {
    const i = base();
    i.invoices = [{ invoiceNumber: "INV-1", status: "DRAFT", lines: null }];
    i.fulfilments = [{ number: 1, packLines: [{ sku: "A", quantity: null }], shipped: true }];
    expect(row(i, "A")).toMatchObject({ invoiced: null, shipped: null, remaining: null, shortfall: null });
    i.ordered[0].quantity = null;
    const out = buildPhysicalStatus(i);
    expect(out.exceptions.some((e) => e.code === "UNREADABLE_QUANTITY" && e.sku === "A")).toBe(true);
  });
  it("flags over-invoicing, over-shipping, unread stock, and activity on a SKU that is not on the order", () => {
    const i = base();
    i.invoices = [{ invoiceNumber: "INV-1", status: "DRAFT", lines: [{ sku: "A", quantity: 11 }, { sku: "ZZ", quantity: 1 }] }];
    i.fulfilments = [{ number: 1, packLines: [{ sku: "B", quantity: 5 }], shipped: true }];
    delete i.stock["B"];
    const codes = buildPhysicalStatus(i).exceptions.map((e) => `${e.code}:${e.sku}`).sort();
    expect(codes).toEqual(["OVER_INVOICED:A", "OVER_SHIPPED:B", "STOCK_NOT_READ:B", "UNORDERED_SKU_ACTIVITY:ZZ"]);
  });
  it("assembly records are labelled per SKU (account-wide); a SKU with none shows none", () => {
    const i = base();
    i.assemblies = [{ sku: "A", status: "COMPLETED", quantity: 4 }, { sku: "A", status: "IN PROGRESS", quantity: 2 }, { sku: "A", status: "VOIDED", quantity: 9 }];
    expect(row(i, "A")).toMatchObject({ hasAssemblyRecords: true, assemblyCompleted: 4, assemblyInProgress: 2 });
    expect(row(i, "B")).toMatchObject({ hasAssemblyRecords: false, assemblyCompleted: null });
  });
});

describe("physical store (read-only)", () => {
  it("returns not-linked without touching Cin7, and reads through the port when linked; never writes", async () => {
    const db = new FakeDb();
    let reads = 0;
    const port: PhysicalPort = {
      async readSale() { reads++; return { cogsCents: 1234, ordered: [{ sku: "A", name: "n", quantity: 2 }], invoices: [], fulfilments: [] }; },
      async readStock() { return { onHand: 5, allocated: 0, available: 5 }; },
      async readAssemblies() { throw new Error("assembly list unavailable"); },
    };
    db.rows("projects").push({ id: "p", org_id: "o", baseline_snapshot: {} });
    expect(await loadPhysicalStatus(db as never, port, { orgId: "o", projectId: "p" })).toMatchObject({ linked: false, rows: [], saleNumber: null });
    expect(reads).toBe(0);
    db.rows("project_cin7_sale_links").push({ id: "l", org_id: "o", project_id: "p", cin7_sale_id: "S", cin7_sale_number: "SO-1", instance_id: "i" });
    const r = await loadPhysicalStatus(db as never, port, { orgId: "o", projectId: "p" });
    expect(r).toMatchObject({ linked: true, saleNumber: "SO-1" });
    expect(r.linked && r.rows[0]).toMatchObject({ sku: "A", ordered: 2, available: 5, shortfall: 0, hasAssemblyRecords: false }); // an assembly outage does not break the view
    expect(db.writes).toEqual([]);
  });
});
