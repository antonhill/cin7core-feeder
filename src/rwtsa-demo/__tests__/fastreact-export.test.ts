import { describe, expect, it } from "vitest";
import { buildExport, type ExchangeSource, type ExportOptions, type Supplement } from "@/rwtsa-demo/fastreact/export";

/** Synthetic fixtures only: invented codes, nothing from any real workbook. */
const SOURCE: ExchangeSource = {
  provenance: "synthetic",
  sourceLabel: "synthetic:seed=1",
  customers: ["CUST-A", "CUST-B", "CUST-B", "CUST-C"],
  items: [
    { sku: "V-L-S", styleCode: "VEST1", productionCode: "ZV1::LIME", description: "Vest" },
    { sku: "V-L-M", styleCode: "VEST1", productionCode: "ZV1::LIME", description: "Vest" },
    { sku: "J-N-S", styleCode: "JKT1", productionCode: "ZJ1::NAVY", description: "Jacket" },
    { sku: "X-N-S", styleCode: "UNUSED", productionCode: "ZX1::NAVY", description: "Unused" },
  ],
  orders: [
    { orderNo: "PO-2", styleCode: "JKT1", qty: 300 },
    { orderNo: "PO-1", styleCode: "VEST1", qty: 1200 },
  ],
};

const SUPP: Supplement = {
  orders: {
    "PO-1": { customer: "CUST-A", deliveryDate: "2026-12-04", status: null },
    "PO-2": { customer: "CUST-B", deliveryDate: "2026-12-11", status: null },
  },
  productTypes: {
    VEST1: { code: "VEST" },
    JKT1: { code: "JACKET" },
  },
};

const OPT: ExportOptions = { delimiter: "tab", dateFormat: "YYYY-MM-DD", headerStyle: "standard", selectedOrders: null, updates: [] };

const file = (r: ReturnType<typeof buildExport>, id: string) => r.files.find((f) => f.id === id)!;
const withOrder = (o: Partial<ExchangeSource["orders"][number]>, i = 0): ExchangeSource => ({
  ...SOURCE,
  orders: SOURCE.orders.map((x, k) => (k === i ? { ...x, ...o } : x)),
});

describe("happy path", () => {
  const r = buildExport(SOURCE, SUPP, OPT);

  it("produces the four base files ready and UPDATE explicitly not exportable", () => {
    expect(r.files.map((f) => [f.id, f.status])).toEqual([
      ["CUSTOMER", "READY"],
      ["PRODTYPE", "READY"],
      ["PRODUCTS", "READY"],
      ["ORDERS", "READY"],
      ["UPDATE", "NOT_EXPORTABLE"],
    ]);
    expect(r.baseSetReady).toBe(true);
    expect(file(r, "UPDATE").text).toBeNull();
    expect(file(r, "UPDATE").notExportableReason).toMatch(/no production update data/i);
  });

  it("writes vendor field codes in the header with stable ordering by code", () => {
    expect(file(r, "ORDERS").text).toBe(
      ["O.CODE\tO.PROD\tO.CUST\tO^DD:1\tO^DQ:1", "PO-1\tZV1::LIME\tCUST-A\t2026-12-04\t1200", "PO-2\tZJ1::NAVY\tCUST-B\t2026-12-11\t300"].join("\r\n") + "\r\n",
    );
    expect(file(r, "CUSTOMER").text).toBe("C.CODE\r\nCUST-A\r\nCUST-B\r\nCUST-C\r\n");
    expect(file(r, "PRODTYPE").text).toBe("T.CODE\r\nJACKET\r\nVEST\r\n");
    expect(file(r, "PRODUCTS").text).toBe("P.CODE\tP.TYPE\r\nZJ1::NAVY\tJACKET\r\nZV1::LIME\tVEST\r\n");
  });

  it("exports only products referenced by the selected orders (full current position of the selection)", () => {
    expect(file(r, "PRODUCTS").text).not.toMatch(/ZX1/);
    expect(file(r, "PRODUCTS").rowCount).toBe(2);
  });

  it("de-duplicates customer contact rows without treating them as an error", () => {
    expect(file(r, "CUSTOMER").rowCount).toBe(3);
    expect(file(r, "CUSTOMER").status).toBe("READY");
  });

  it("carries no add/amend/delete action flag and no synchronisation field", () => {
    for (const f of r.files) if (f.text) expect(f.text.split("\r\n")[0]).not.toMatch(/ACTION|DELETE|AMEND|SYNC/i);
  });

  it("is deterministic and independent of input order", () => {
    const shuffled: ExchangeSource = { ...SOURCE, orders: [...SOURCE.orders].reverse(), customers: [...SOURCE.customers].reverse(), items: [...SOURCE.items].reverse() };
    const r2 = buildExport(shuffled, SUPP, OPT);
    expect(r2.files.map((f) => f.text)).toEqual(r.files.map((f) => f.text));
    expect(r2.files.map((f) => f.sha256)).toEqual(r.files.map((f) => f.sha256));
  });

  it("hashes each file's exact text", () => {
    expect(file(r, "ORDERS").sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("states encoding and line ending", () => {
    expect(r.encoding).toMatch(/UTF-8/);
    expect(r.lineEnding).toBe("CRLF");
  });
});

describe("formats", () => {
  it("writes quoted CSV with .csv names", () => {
    const r = buildExport(SOURCE, SUPP, { ...OPT, delimiter: "csv" });
    expect(file(r, "ORDERS").name).toBe("ORDERS.csv");
    expect(file(r, "ORDERS").text!.split("\r\n")[0]).toBe('"O.CODE","O.PROD","O.CUST","O^DD:1","O^DQ:1"');
    expect(file(r, "ORDERS").text!.split("\r\n")[1]).toBe('"PO-1","ZV1::LIME","CUST-A","2026-12-04","1200"');
  });
  it("applies the configured date format", () => {
    const r = buildExport(SOURCE, SUPP, { ...OPT, dateFormat: "DD/MM/YYYY" });
    expect(file(r, "ORDERS").text).toMatch(/04\/12\/2026\t1200/);
  });
  it("applies compliant header names", () => {
    const r = buildExport(SOURCE, SUPP, { ...OPT, headerStyle: "compliant" });
    expect(file(r, "ORDERS").text!.split("\r\n")[0]).toBe("O1CODE\tO1PROD\tO1CUST\tO2DD41\tO2DQ41");
  });
  it("includes O.STATUS only when every order has a documented status", () => {
    const some = buildExport(SOURCE, { ...SUPP, orders: { ...SUPP.orders, "PO-1": { ...SUPP.orders["PO-1"], status: "F" } } }, OPT);
    expect(file(some, "ORDERS").text!.split("\r\n")[0]).not.toMatch(/O\.STATUS/);
    expect(file(some, "ORDERS").notes.join(" ")).toMatch(/O\.STATUS/);
    const all = buildExport(SOURCE, { ...SUPP, orders: { "PO-1": { ...SUPP.orders["PO-1"], status: "F" }, "PO-2": { ...SUPP.orders["PO-2"], status: "P" } } }, OPT);
    expect(file(all, "ORDERS").text!.split("\r\n")[0]).toBe("O.CODE\tO.PROD\tO.CUST\tO^DD:1\tO^DQ:1\tO.STATUS");
    expect(file(all, "ORDERS").text).toMatch(/\t1200\tF\r\n/);
  });
});

describe("selection", () => {
  it("exports only the selected orders and the master data they reference", () => {
    const r = buildExport(SOURCE, SUPP, { ...OPT, selectedOrders: ["PO-1"] });
    expect(file(r, "ORDERS").rowCount).toBe(1);
    expect(file(r, "PRODUCTS").text).toBe("P.CODE\tP.TYPE\r\nZV1::LIME\tVEST\r\n");
    expect(file(r, "PRODTYPE").text).toBe("T.CODE\r\nVEST\r\n");
  });
  it("ignores a selected order that does not exist but reports it", () => {
    const r = buildExport(SOURCE, SUPP, { ...OPT, selectedOrders: ["PO-1", "NOPE"] });
    expect(file(r, "ORDERS").status).toBe("FAILED");
    expect(file(r, "ORDERS").issues.some((i) => /not found/i.test(i.message))).toBe(true);
  });
  it("is not exportable when there are no orders", () => {
    const r = buildExport({ ...SOURCE, orders: [] }, SUPP, OPT);
    expect(file(r, "ORDERS").status).toBe("NOT_EXPORTABLE");
    expect(r.baseSetReady).toBe(false);
  });
});

describe("mandatory fields are never substituted", () => {
  it("fails ORDERS when the customer is missing, with a count and no export text", () => {
    const r = buildExport(SOURCE, { ...SUPP, orders: { ...SUPP.orders, "PO-1": { customer: null, deliveryDate: "2026-12-04", status: null } } }, OPT);
    const o = file(r, "ORDERS");
    expect(o.status).toBe("FAILED");
    expect(o.text).toBeNull();
    expect(o.issues.filter((i) => i.field === "O.CUST" && i.kind === "missing-required")).toHaveLength(1);
    expect(r.baseSetReady).toBe(false);
  });
  it("fails ORDERS when the delivery date is missing", () => {
    const r = buildExport(SOURCE, { ...SUPP, orders: { ...SUPP.orders, "PO-2": { customer: "CUST-B", deliveryDate: null, status: null } } }, OPT);
    expect(file(r, "ORDERS").issues.some((i) => i.field === "O^DD:1" && i.kind === "missing-required")).toBe(true);
  });
  it("fails ORDERS and PRODUCTS when there is no supplement at all", () => {
    const r = buildExport(SOURCE, { orders: {}, productTypes: {} }, OPT);
    expect(file(r, "ORDERS").status).toBe("FAILED");
    expect(file(r, "PRODUCTS").status).toBe("FAILED");
    expect(file(r, "PRODTYPE").status).toBe("NOT_EXPORTABLE");
    expect(file(r, "PRODUCTS").issues.some((i) => i.field === "P.TYPE")).toBe(true);
  });
  it("fails a product whose style has no production code, and cascades to the order that uses it", () => {
    const src: ExchangeSource = { ...SOURCE, items: SOURCE.items.map((i) => (i.styleCode === "JKT1" ? { ...i, productionCode: null } : i)) };
    const r = buildExport(src, SUPP, OPT);
    expect(file(r, "PRODUCTS").issues.some((i) => i.field === "P.CODE" && i.kind === "missing-required")).toBe(true);
    expect(file(r, "ORDERS").status).toBe("FAILED");
    expect(file(r, "ORDERS").issues.some((i) => i.kind === "reference")).toBe(true);
  });
  it("fails when one style carries two different production codes", () => {
    const src: ExchangeSource = { ...SOURCE, items: [...SOURCE.items, { sku: "V-L-L", styleCode: "VEST1", productionCode: "ZV1::OTHER", description: "Vest" }] };
    const r = buildExport(src, SUPP, OPT);
    expect(file(r, "PRODUCTS").issues.some((i) => i.kind === "ambiguous")).toBe(true);
  });
});

describe("referential integrity", () => {
  it("rejects an order whose customer is not in the customer file", () => {
    const r = buildExport(SOURCE, { ...SUPP, orders: { ...SUPP.orders, "PO-1": { customer: "GHOST", deliveryDate: "2026-12-04", status: null } } }, OPT);
    expect(file(r, "ORDERS").issues.some((i) => i.field === "O.CUST" && i.kind === "reference")).toBe(true);
    expect(file(r, "ORDERS").status).toBe("FAILED");
  });
  it("matches references case-insensitively because Fast React upper-cases text", () => {
    const r = buildExport(SOURCE, { ...SUPP, orders: { ...SUPP.orders, "PO-1": { customer: "cust-a", deliveryDate: "2026-12-04", status: null } } }, OPT);
    expect(file(r, "ORDERS").status).toBe("READY");
  });
  it("rejects an order for a style that is not a known product", () => {
    const r = buildExport(withOrder({ styleCode: "NOSUCH" }), SUPP, OPT);
    expect(file(r, "ORDERS").issues.some((i) => i.field === "O.PROD" && i.kind === "reference")).toBe(true);
  });
  it("rejects duplicate order codes, including ones that differ only by case", () => {
    const r = buildExport(withOrder({ orderNo: "po-1" }), { ...SUPP, orders: { ...SUPP.orders, "po-1": SUPP.orders["PO-2"] } }, OPT);
    expect(file(r, "ORDERS").issues.some((i) => i.kind === "duplicate")).toBe(true);
    expect(file(r, "ORDERS").status).toBe("FAILED");
  });
  it("rejects two styles that resolve to the same product code", () => {
    const src: ExchangeSource = { ...SOURCE, items: SOURCE.items.map((i) => (i.styleCode === "JKT1" ? { ...i, productionCode: "zv1::lime" } : i)) };
    const r = buildExport(src, SUPP, OPT);
    expect(file(r, "PRODUCTS").issues.some((i) => i.kind === "duplicate")).toBe(true);
  });
  it("rejects customer codes that collide only by case", () => {
    const r = buildExport({ ...SOURCE, customers: ["CUST-A", "cust-a"] }, SUPP, OPT);
    expect(file(r, "CUSTOMER").issues.some((i) => i.kind === "duplicate")).toBe(true);
  });
});

describe("value validation", () => {
  const bad = (qty: number) => buildExport(withOrder({ qty }), SUPP, OPT);
  it("rejects zero, negative, fractional and non-finite quantities", () => {
    for (const q of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = bad(q);
      expect(file(r, "ORDERS").issues.some((i) => i.field === "O^DQ:1" && i.kind === "invalid"), String(q)).toBe(true);
    }
  });
  it("rejects invalid or ambiguous dates", () => {
    for (const d of ["2026-02-30", "04/12/2026", "2026-12-4", "tomorrow", ""]) {
      const r = buildExport(SOURCE, { ...SUPP, orders: { ...SUPP.orders, "PO-1": { customer: "CUST-A", deliveryDate: d, status: null } } }, OPT);
      expect(file(r, "ORDERS").status, d).toBe("FAILED");
    }
  });
  it("rejects over-length values instead of letting Fast React truncate them", () => {
    const r = buildExport(withOrder({ orderNo: "X".repeat(31) }), { ...SUPP, orders: { ...SUPP.orders, ["X".repeat(31)]: SUPP.orders["PO-1"] } }, OPT);
    expect(file(r, "ORDERS").issues.some((i) => i.field === "O.CODE" && i.kind === "too-long")).toBe(true);
    const c = buildExport({ ...SOURCE, customers: ["C".repeat(16)] }, SUPP, OPT);
    expect(file(c, "CUSTOMER").issues.some((i) => i.field === "C.CODE" && i.kind === "too-long")).toBe(true);
  });
  it("rejects an undocumented order status", () => {
    const r = buildExport(SOURCE, { ...SUPP, orders: { "PO-1": { ...SUPP.orders["PO-1"], status: "Z" }, "PO-2": { ...SUPP.orders["PO-2"], status: "F" } } }, OPT);
    expect(file(r, "ORDERS").issues.some((i) => i.field === "O.STATUS" && i.kind === "invalid")).toBe(true);
  });
  it("refuses codes that would inject a formula or break the delimiter, without altering them", () => {
    for (const c of ["=cmd|' /C calc'!A0", "+1", "@x", "a\tb", "a\nb"]) {
      const r = buildExport({ ...SOURCE, customers: [...SOURCE.customers, c] }, SUPP, OPT);
      expect(file(r, "CUSTOMER").status, JSON.stringify(c)).toBe("FAILED");
      expect(file(r, "CUSTOMER").text).toBeNull();
      expect(file(r, "CUSTOMER").issues.map((i) => i.message).join(" ")).not.toContain(c);
    }
  });
  it("enforces the row limit", () => {
    const customers = Array.from({ length: 5001 }, (_, i) => `C${i}`);
    const r = buildExport({ ...SOURCE, customers }, SUPP, OPT);
    expect(file(r, "CUSTOMER").status).toBe("FAILED");
    expect(file(r, "CUSTOMER").issues.some((i) => i.kind === "limit")).toBe(true);
  });
});

describe("operation identifiers and work content", () => {
  const withWc = (wc: Record<string, number>, wc2: Record<string, number> = wc): Supplement => ({
    ...SUPP,
    productTypes: { VEST1: { code: "VEST", workContent: wc }, JKT1: { code: "JACKET", workContent: wc2 } },
  });
  it("emits T^WC:n columns only for supplied operation external IDs, sorted numerically", () => {
    const r = buildExport(SOURCE, withWc({ "10": 4.5, "2": 1.25 }), OPT);
    expect(file(r, "PRODTYPE").text!.split("\r\n")[0]).toBe("T.CODE\tT^WC:2\tT^WC:10");
    expect(file(r, "PRODTYPE").text!.split("\r\n")[1]).toBe("JACKET\t1.25\t4.5");
  });
  it("never invents an operation ID when none is supplied", () => {
    const r = buildExport(SOURCE, SUPP, OPT);
    expect(file(r, "PRODTYPE").text).not.toMatch(/T\^WC/);
    expect(file(r, "PRODTYPE").notes.join(" ")).toMatch(/operation external IDs/i);
  });
  it("rejects invalid operation identifiers", () => {
    for (const id of ["abc", "0", "-1", "1.5", "", "1e3", " 7"]) {
      const r = buildExport(SOURCE, withWc({ [id]: 1 }), OPT);
      expect(file(r, "PRODTYPE").issues.some((i) => i.kind === "invalid-operation-id"), JSON.stringify(id)).toBe(true);
      expect(file(r, "PRODTYPE").status).toBe("FAILED");
    }
  });
  it("rejects negative, zero-less or non-finite work content", () => {
    for (const v of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = buildExport(SOURCE, withWc({ "1": v }), OPT);
      expect(file(r, "PRODTYPE").status).toBe("FAILED");
    }
  });
  it("rejects an inconsistent set of operations across product types", () => {
    const r = buildExport(SOURCE, withWc({ "1": 2 }, { "2": 3 }), OPT);
    expect(file(r, "PRODTYPE").issues.some((i) => i.kind === "inconsistent")).toBe(true);
  });
});

describe("production update file", () => {
  const upd = (over: object = {}) => ({ order: "PO-1", date: "2026-11-05", qty: 150, ...over });
  it("is written only from explicit update rows, with the essential fields", () => {
    const r = buildExport(SOURCE, SUPP, { ...OPT, updates: [upd()] });
    expect(file(r, "UPDATE").status).toBe("READY");
    expect(file(r, "UPDATE").text).toBe("U.ORDER\tU.DATE\tU.QTY\r\nPO-1\t2026-11-05\t150\r\n");
  });
  it("adds optional section/line/complete columns only when supplied for every row", () => {
    const r = buildExport(SOURCE, SUPP, { ...OPT, updates: [upd({ section: "SEW", line: "Line 1", complete: 0 })] });
    expect(file(r, "UPDATE").text!.split("\r\n")[0]).toBe("U.ORDER\tU.DATE\tU.QTY\tU.SECT\tU.LINE\tU.COMPLETE");
  });
  it("rejects an update for an order that is not exported, a bad date or a bad quantity", () => {
    expect(file(buildExport(SOURCE, SUPP, { ...OPT, updates: [upd({ order: "PO-9" })] }), "UPDATE").status).toBe("FAILED");
    expect(file(buildExport(SOURCE, SUPP, { ...OPT, updates: [upd({ date: "2026-99-01" })] }), "UPDATE").status).toBe("FAILED");
    expect(file(buildExport(SOURCE, SUPP, { ...OPT, updates: [upd({ qty: -1 })] }), "UPDATE").status).toBe("FAILED");
    expect(file(buildExport(SOURCE, SUPP, { ...OPT, updates: [upd({ qty: 2.5 })] }), "UPDATE").status).toBe("FAILED");
  });
  it("rejects a duplicate update row for the same order and date", () => {
    const r = buildExport(SOURCE, SUPP, { ...OPT, updates: [upd(), upd()] });
    expect(file(r, "UPDATE").issues.some((i) => i.kind === "duplicate")).toBe(true);
  });
});

describe("no data", () => {
  it("every file is not exportable when no dataset is available", () => {
    const r = buildExport(null, SUPP, OPT);
    expect(r.files.every((f) => f.status === "NOT_EXPORTABLE" && f.text === null)).toBe(true);
    expect(r.baseSetReady).toBe(false);
  });
});

describe("field-coverage report", () => {
  it("reports every vendor field as mapped, conditional, or deliberately not mapped, with evidence", () => {
    const r = buildExport(SOURCE, SUPP, OPT);
    const cov = file(r, "ORDERS").coverage;
    const by = (code: string) => cov.find((c) => c.code === code)!;
    expect(by("O.CODE").state).toBe("exported");
    expect(by("O.CUST").state).toBe("exported");
    expect(by("O.STATUS").state).toBe("conditional");
    expect(by("O.DESCRIP").state).toBe("not-mapped");
    expect(cov.every((c) => c.evidence.length > 0)).toBe(true);
  });
});
