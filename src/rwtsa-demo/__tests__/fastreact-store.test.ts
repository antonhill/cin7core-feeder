import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EMPTY_EXCHANGE, ExchangeStoreError, loadExchange, updateExchange } from "@/rwtsa-demo/state/fastreact-store";
import { applyExchangeForm, type FormContext } from "@/rwtsa-demo/state/fastreact-form";
import { buildSampleReturn, sha256Text } from "@/rwtsa-demo/fastreact/return-format";
import type { ExchangeSource } from "@/rwtsa-demo/fastreact/export";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "rwtsa-fr-"));
const NOW = new Date("2026-11-05T12:00:00Z");

const SOURCE: ExchangeSource = {
  provenance: "synthetic",
  sourceLabel: "synthetic:seed=1",
  customers: ["CUST-A", "CUST-B"],
  items: [{ sku: "V-S", styleCode: "VEST1", productionCode: "ZV1", description: null }],
  orders: [{ orderNo: "PO-1", styleCode: "VEST1", qty: 1000 }],
};
const ctx = (dir: string, label = SOURCE.sourceLabel): FormContext => ({ dir, label, source: SOURCE, now: NOW });

describe("exchange store", () => {
  it("returns an empty state when nothing is saved", () => {
    expect(loadExchange(tmp(), "a")).toEqual(EMPTY_EXCHANGE);
  });
  it("round-trips, writes owner-only files, and leaves no temp files", () => {
    const d = tmp();
    updateExchange(d, "a", (s) => ({ ...s, supplement: { ...s.supplement, productTypes: { VEST1: { code: "VEST" } } } }));
    expect(loadExchange(d, "a").supplement.productTypes.VEST1.code).toBe("VEST");
    const files = readdirSync(d);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^fastreact-[0-9a-f]{16}\.json$/);
    expect(statSync(path.join(d, files[0])).mode & 0o777).toBe(0o600);
  });
  it("keeps data sources apart", () => {
    const d = tmp();
    updateExchange(d, "a", (s) => ({ ...s, supplement: { ...s.supplement, productTypes: { VEST1: { code: "VEST" } } } }));
    expect(loadExchange(d, "b")).toEqual(EMPTY_EXCHANGE);
  });
  it("refuses a corrupt file instead of treating it as empty", () => {
    const d = tmp();
    updateExchange(d, "a", (s) => s);
    const f = path.join(d, readdirSync(d)[0]);
    writeFileSync(f, "{not json");
    expect(() => loadExchange(d, "a")).toThrow(ExchangeStoreError);
  });
  it("refuses a file that belongs to another source", () => {
    const d = tmp();
    updateExchange(d, "a", (s) => s);
    const f = path.join(d, readdirSync(d)[0]);
    const j = JSON.parse(readFileSync(f, "utf8"));
    j.source = "other";
    writeFileSync(f, JSON.stringify(j));
    expect(() => loadExchange(d, "a")).toThrow(ExchangeStoreError);
  });
  it("refuses a directory inside a git working tree", () => {
    expect(() => updateExchange(path.join(process.cwd(), "src", "rwtsa-demo", "nope"), "a", (s) => s)).toThrow(ExchangeStoreError);
  });
  it("does not write when the update function throws", () => {
    const d = tmp();
    expect(() => updateExchange(d, "a", () => { throw new Error("x"); })).toThrow();
    expect(readdirSync(d)).toEqual([]);
  });
});

describe("form actions", () => {
  it("saves a valid supplement (customer, date, status, product type)", () => {
    const d = tmp();
    const out = applyExchangeForm(ctx(d), { action: "supplement-save", fields: { "customer:PO-1": "CUST-A", "date:PO-1": "2026-12-04", "status:PO-1": "F", "type:VEST1": "VEST" } });
    expect(out).toBe("supplement-saved");
    const s = loadExchange(d, SOURCE.sourceLabel).supplement;
    expect(s.orders["PO-1"]).toEqual({ customer: "CUST-A", deliveryDate: "2026-12-04", status: "F" });
    expect(s.productTypes.VEST1).toEqual({ code: "VEST" });
  });
  it("saves nothing when any value is invalid", () => {
    const d = tmp();
    for (const fields of <Record<string, string>[]>[
      { "customer:PO-1": "GHOST" },
      { "date:PO-1": "2026-02-30" },
      { "status:PO-1": "X" },
      { "type:VEST1": "=cmd" },
      { "type:VEST1": "T".repeat(16) },
      { "customer:NOPE": "CUST-A" },
      { "type:NOSTYLE": "VEST" },
    ]) {
      expect(applyExchangeForm(ctx(d), { action: "supplement-save", fields }), JSON.stringify(fields)).toBe("invalid-supplement");
    }
    expect(readdirSync(d)).toEqual([]);
  });
  it("treats blank values as 'not supplied' (clears), never as zero or a default", () => {
    const d = tmp();
    applyExchangeForm(ctx(d), { action: "supplement-save", fields: { "customer:PO-1": "CUST-A", "date:PO-1": "2026-12-04" } });
    applyExchangeForm(ctx(d), { action: "supplement-save", fields: { "customer:PO-1": "", "date:PO-1": "" } });
    expect(loadExchange(d, SOURCE.sourceLabel).supplement.orders["PO-1"]).toEqual({ customer: null, deliveryDate: null, status: null });
  });
  it("saves export options and a selection, refusing unknown values", () => {
    const d = tmp();
    expect(applyExchangeForm(ctx(d), { action: "options-save", fields: { delimiter: "csv", dateFormat: "DD/MM/YYYY", headerStyle: "compliant" }, selected: ["PO-1"] })).toBe("options-saved");
    expect(loadExchange(d, SOURCE.sourceLabel).options).toEqual({ delimiter: "csv", dateFormat: "DD/MM/YYYY", headerStyle: "compliant", selectedOrders: ["PO-1"] });
    expect(applyExchangeForm(ctx(d), { action: "options-save", fields: { delimiter: "pipe", dateFormat: "YYYY-MM-DD", headerStyle: "standard" }, selected: [] })).toBe("invalid-options");
    expect(applyExchangeForm(ctx(d), { action: "options-save", fields: { delimiter: "tab", dateFormat: "YYYY-MM-DD", headerStyle: "standard" }, selected: ["NOPE"] })).toBe("invalid-options");
  });
});

describe("return flow through the store", () => {
  const sample = () => buildSampleReturn(SOURCE.orders, NOW);

  it("preview stores a pending file and changes nothing else; apply needs the matching hash", () => {
    const d = tmp();
    expect(applyExchangeForm(ctx(d), { action: "return-sample" })).toBe("return-previewed");
    const s = loadExchange(d, SOURCE.sourceLabel);
    expect(s.pending?.fileHash).toBe(sha256Text(sample()));
    expect(s.pending?.sourceKind).toBe("synthetic-sample");
    expect(s.returns).toEqual({ orders: {}, history: [] });
    expect(applyExchangeForm(ctx(d), { action: "return-apply", fields: { hash: "0".repeat(64) } })).toBe("no-pending");
    expect(loadExchange(d, SOURCE.sourceLabel).returns.orders).toEqual({});
    expect(applyExchangeForm(ctx(d), { action: "return-apply", fields: { hash: sha256Text(sample()) } })).toBe("return-applied");
    const after = loadExchange(d, SOURCE.sourceLabel);
    expect(after.returns.orders["PO-1"]).toBeDefined();
    expect(after.pending).toBeNull();
    expect(after.returns.history).toHaveLength(1);
  });

  it("loading and applying the same file again leaves stored returns byte-identical", () => {
    const d = tmp();
    applyExchangeForm(ctx(d), { action: "return-sample" });
    applyExchangeForm(ctx(d), { action: "return-apply", fields: { hash: sha256Text(sample()) } });
    const f = path.join(d, readdirSync(d)[0]);
    const before = JSON.stringify(JSON.parse(readFileSync(f, "utf8")).returns);
    expect(applyExchangeForm(ctx(d), { action: "return-sample" })).toBe("return-previewed");
    expect(applyExchangeForm(ctx(d), { action: "return-apply", fields: { hash: sha256Text(sample()) } })).toBe("return-nothing-to-apply");
    expect(JSON.stringify(JSON.parse(readFileSync(f, "utf8")).returns)).toBe(before);
  });

  it("an uploaded file is validated; a bad file is not stored as pending", () => {
    const d = tmp();
    expect(applyExchangeForm(ctx(d), { action: "return-upload", text: "garbage" })).toBe("return-rejected");
    expect(loadExchange(d, SOURCE.sourceLabel).pending).toBeNull();
    expect(applyExchangeForm(ctx(d), { action: "return-upload", text: sample() })).toBe("return-previewed");
    expect(loadExchange(d, SOURCE.sourceLabel).pending?.sourceKind).toBe("upload");
  });

  it("discard clears the pending file; clear-returns resets only applied returns", () => {
    const d = tmp();
    applyExchangeForm(ctx(d), { action: "supplement-save", fields: { "type:VEST1": "VEST" } });
    applyExchangeForm(ctx(d), { action: "return-sample" });
    expect(applyExchangeForm(ctx(d), { action: "return-discard" })).toBe("return-discarded");
    expect(loadExchange(d, SOURCE.sourceLabel).pending).toBeNull();
    applyExchangeForm(ctx(d), { action: "return-sample" });
    applyExchangeForm(ctx(d), { action: "return-apply", fields: { hash: sha256Text(sample()) } });
    expect(applyExchangeForm(ctx(d), { action: "returns-clear" })).toBe("returns-cleared");
    const s = loadExchange(d, SOURCE.sourceLabel);
    expect(s.returns).toEqual({ orders: {}, history: [] });
    expect(s.supplement.productTypes.VEST1.code).toBe("VEST");
  });

  it("rejects an unknown action", () => {
    expect(applyExchangeForm(ctx(tmp()), { action: "format-disk" })).toBe("invalid");
  });

  it("never opens or alters a workbook file", () => {
    const d = tmp();
    const wb = path.join(d, "protected.xlsx");
    writeFileSync(wb, "stand-in");
    chmodSync(wb, 0o444);
    const before = sha256Text(readFileSync(wb, "utf8"));
    applyExchangeForm(ctx(d), { action: "return-sample" });
    applyExchangeForm(ctx(d), { action: "return-apply", fields: { hash: sha256Text(sample()) } });
    expect(sha256Text(readFileSync(wb, "utf8"))).toBe(before);
    expect(existsSync(wb)).toBe(true);
  });
});
