import { describe, expect, it } from "vitest";
import { growerTemplateSections, TEMPLATE_HEADER } from "../template";
import { buildCustomerSummary } from "../customer-summary";
import { evaluateDraft } from "../evaluate";
import { parseMasterRows } from "../master-parse";
import { referencedSkus } from "../commercial";
import { GROWER_RULES } from "../rules";
import { GROWER_TEMPLATE } from "../final-feedback";
import { readyDraft } from "./golden";
import { testPriceSource } from "./test-snapshot";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "../snapshot";

describe("Grower House Template v1 — read-only detail", () => {
  it("uses the exact client-facing name, a version and Active status", () => {
    expect(GROWER_TEMPLATE.name).toBe("Grower House Template v1");
    expect(TEMPLATE_HEADER).toMatchObject({ name: "Grower House Template v1", version: "1.0", status: "Active" });
  });
  const sections = growerTemplateSections();
  it("has the eleven confirmed sections in order", () => {
    expect(sections.map((s) => s.name)).toEqual(["Site & Rooms", "Feeders", "Drinkers", "Slats", "Lighting", "M75 Feed Distribution", "Penning", "Doors", "Ventilation", "Delivery", "Installation"]);
  });
  it("is required by default; ventilation is the optional section", () => {
    expect(sections.filter((s) => !s.required).map((s) => s.name)).toEqual(["Ventilation"]);
    for (const s of sections.filter((x) => x.required && x.n > 1 && x.n < 9)) expect(s.requirementNote).toMatch(/excluded at the customer's request/);
  });
  it("every section shows rule refs, behaviour, mapping reference and override policy", () => {
    for (const s of sections) {
      expect(s.ruleRefs.length).toBeGreaterThan(0);
      expect(s.behaviour.length).toBeGreaterThan(10);
      expect(s.mappingRef.length).toBeGreaterThan(0);
      expect(s.overridePolicy.length).toBeGreaterThan(0);
    }
  });
  it("rule refs point at real rules (no drift from the engine)", () => {
    const real = new Set(GROWER_RULES.map((r) => r.id));
    for (const ref of sections.flatMap((s) => s.ruleRefs).filter((r) => r.startsWith("GROWER-") && !/GEO|ROOMS/.test(r))) expect(real.has(ref)).toBe(true);
  });
  it("states the final rules in plain words", () => {
    const by = Object.fromEntries(sections.map((s) => [s.name, s]));
    expect(by.Lighting.behaviour).toMatch(/ceil\(room floor area \/ 25\)/);
    expect(by.Feeders.mappingRef).toMatch(/PNQ082.*PNQ082-WINDOW/);
    expect(by.Penning.behaviour).toMatch(/R1,300.*R1,500.*R2,200/);
    expect(by["M75 Feed Distribution"].behaviour).toMatch(/NQ3132 is N\/A/);
    expect(by.Ventilation.behaviour).toMatch(/AS\.03/);
  });
});

describe("customer-facing quote is a SUMMARY, not the BOM", () => {
  const ev = evaluateDraft(readyDraft(), { priceSource: testPriceSource(), withholdCost: true });
  const summary = buildCustomerSummary(ev.budget!)!;
  it("groups the solution into commercial sections that add up to the quote", () => {
    expect(summary.sections.length).toBeGreaterThanOrEqual(7);
    expect(summary.sections.length).toBeLessThan(ev.budget!.lines.length + 3);
    const sum = Math.round(summary.sections.reduce((a, s) => a + s.amountExVat, 0) * 100);
    expect(sum).toBe(Math.round(summary.subtotalExVat * 100));
    expect(summary.totalIncVat).toBeCloseTo(summary.subtotalExVat + summary.vat, 2);
  });
  it("exposes no SKU, cost, component or stock line", () => {
    const text = JSON.stringify(summary);
    for (const sku of ["PNQ082", "NQ1161", "ERT053", "QCA00003", "NQ3132", "HNQ7046", "SYSH-2750-3"]) expect(text).not.toContain(sku);
    expect(text).not.toMatch(/cost|margin|component|landed/i);
  });
  it("does not exist for an incomplete quote", () => {
    const d = readyDraft();
    const bad = evaluateDraft({ ...d, estimator: { ...d.estimator, unitPrices: {} } }, { priceSource: testPriceSource(), withholdCost: true });
    expect(buildCustomerSummary(bad.budget!)).toBeNull();
  });
});

describe("Master workbook snapshot builder", () => {
  const rows = [
    ["NewQuip Master", "", "", "", "", "", ""],
    ["SKU", "Description", "Cost", "ROE", "Freight", "MU", "Retail Price ex VAT"],
    ["PNQ082", "CCM feeder", 1000, 1, 1.2, 1.4, 1680],
    ["IGNORED", "not a POC SKU", 1, 1, 1, 1, 1],
    ["NQ3132", "Drive unit", 0, 1, 1, 1, 0],
  ];
  it("keeps only the wanted SKUs and reports the missing ones — nothing is invented", () => {
    const r = parseMasterRows(rows, ["PNQ082", "NQ3132", "ERT053"]);
    expect(Object.keys(r.entries)).toEqual(["PNQ082", "NQ3132"]);
    expect(r.missing).toEqual(["ERT053"]);
    expect(r.entries.PNQ082).toMatchObject({ cost: 1000, roe: 1, freight: 1.2, mu: 1.4, retailExVat: 1680 });
  });
  it("finds the header by NAME, and refuses a sheet without the pricing columns", () => {
    expect(() => parseMasterRows([["SKU", "Price"], ["A", 1]], ["A"])).toThrow(/no header row/);
  });
  it("rejects non-numeric figures", () => {
    expect(() => parseMasterRows([["SKU", "Cost", "ROE", "Freight", "MU", "Retail Price ex VAT"], ["PNQ082", "abc", 1, 1, 1, 1]], ["PNQ082"])).toThrow(/non-numeric/);
  });
  it("covers every SKU the Grower mappings reference, including the feeder window variant", () => {
    expect(referencedSkus()).toEqual(expect.arrayContaining(["PNQ082", "PNQ082-WINDOW", "NQ1161", "NQ3132"]));
  });
  it("the committed snapshot honestly says whether the Master has been imported", () => {
    if (Object.keys(NEWQUIP_MASTER_POC_SNAPSHOT.entries).length === 0) expect(NEWQUIP_MASTER_POC_SNAPSHOT.sourceFile).toMatch(/NOT YET IMPORTED/);
    else expect(NEWQUIP_MASTER_POC_SNAPSHOT.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
