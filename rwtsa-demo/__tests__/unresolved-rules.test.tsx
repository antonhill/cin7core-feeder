import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { originalShapedBuffer } from "@/rwtsa-demo/fixtures/original-shaped";
import ScenarioAPage from "../app/scenario-a/page";
import ScenarioBPage from "../app/scenario-b/page";
import ScenarioCPage from "../app/scenario-c/page";
import ScenarioDPage from "../app/scenario-d/page";
import ValidationPage from "../app/validation/page";

/**
 * A LOCAL workbook with the original workbook's structure (synthetic values) must load directly, and every commercial rule
 * the workbook does not establish must be shown by name, with the outputs it affects withheld until it is resolved.
 */

let tmp: string;
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "rwtsa-unresolved-"));
  writeFileSync(join(tmp, "orig.xlsx"), await originalShapedBuffer());
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

async function withFile(name: string, mutate: Parameters<typeof originalShapedBuffer>[0]) {
  writeFileSync(join(tmp, name), await originalShapedBuffer(mutate));
  vi.stubEnv("RWTSA_SOURCE", "");
  vi.stubEnv("RWTSA_WORKBOOK_PATH", join(tmp, name));
  vi.stubEnv("RWTSA_STATE_DIR", join(tmp, "state"));
}
const local = () => {
  vi.stubEnv("RWTSA_SOURCE", "");
  vi.stubEnv("RWTSA_WORKBOOK_PATH", join(tmp, "orig.xlsx"));
  vi.stubEnv("RWTSA_STATE_DIR", join(tmp, "state"));
};
const synthetic = () => {
  vi.stubEnv("RWTSA_SOURCE", "synthetic");
  vi.stubEnv("RWTSA_WORKBOOK_PATH", "");
  vi.stubEnv("RWTSA_STATE_DIR", join(tmp, "state"));
};
const decode = (t: string) => t.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = (m: string) => decode(m.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
const sp = (q: Record<string, string>) => ({ searchParams: Promise.resolve(q) });
const A = async (q: Record<string, string> = {}) => renderToStaticMarkup(await ScenarioAPage(sp(q)));
const B = async (q: Record<string, string> = {}) => renderToStaticMarkup(await ScenarioBPage(sp(q)));
const C = async (q: Record<string, string> = {}) => renderToStaticMarkup(await ScenarioCPage(sp(q)));
const D = async (q: Record<string, string> = {}) => renderToStaticMarkup(await ScenarioDPage(sp(q)));
const indicator = (m: string, id: string) => {
  const r = new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`).exec(m);
  return r ? decode(r[1]).trim() : null;
};
const ruleIds = (m: string) => [...m.matchAll(/data-testid="rule-row" data-id="([^"]*)"/g)].map((x) => x[1]);
const badge = (m: string) => /data-testid="rules-badge"[^>]*>(?:<[^>]*>)*([^<]*)</.exec(m)?.[1]?.trim() ?? null;

describe("the original-shaped workbook loads directly as a LOCAL workbook", () => {
  it("every page shows LOCAL WORKBOOK, STRUCTURE PASS and an available engine; nothing is synthetic", async () => {
    local();
    for (const render of [A, B, C, D]) {
      const t = text(await render());
      expect(t).toContain("LOCAL WORKBOOK");
      expect(t).toContain("STRUCTURE PASS");
      expect(t).toContain("ENGINE AVAILABLE");
      expect(t).not.toContain("SYNTHETIC");
    }
  });
  it("the validator-only READY flags are separate: A and B are NOT READY (tender marker, overhead and efficiency absent), C and D READY", async () => {
    local();
    expect(text(await A())).toContain("NOT READY");
    expect(text(await B())).toContain("NOT READY");
    expect(/data-testid="readiness"[^>]*>(?:<[^>]*>)*READY</.test(await C())).toBe(true);
    expect(/data-testid="readiness"[^>]*>(?:<[^>]*>)*READY</.test(await D())).toBe(true);
  });
});

describe("Scenario A: unresolved rules withhold the affected outputs", () => {
  it("lists the open rules and withholds ALL results until history and overdue treatments are chosen", async () => {
    local();
    const m = await A();
    expect(ruleIds(m)).toEqual(["overdue-on-water", "sales-history-gap", "tender-classification"]);
    expect(m).not.toContain('data-testid="indicators"');
    expect(m).not.toContain('data-testid="row-key"');
    expect(text(m)).toMatch(/results are withheld/i);
    expect(badge(m)).toBe("RULES: 3 OPEN");
  });
  it("choosing only one of the two treatments keeps results withheld", async () => {
    local();
    expect(ruleIds(await A({ anchor: "last" }))).toEqual(["overdue-on-water", "tender-classification"]);
    expect(await A({ anchor: "last" })).not.toContain('data-testid="indicators"');
    expect(ruleIds(await A({ overdue: "week1" }))).toEqual(["sales-history-gap", "tender-classification"]);
  });
  it("with both treatments chosen the projection is shown, and ONLY the tender-dependent proposed orders stay withheld", async () => {
    local();
    const m = await A({ anchor: "last", overdue: "week1" });
    expect(ruleIds(m)).toEqual(["tender-classification"]);
    expect(m).toContain('data-testid="indicators"');
    expect(indicator(m, "ind-shortage")).not.toBeNull();
    const cells = [...m.matchAll(/data-testid="proposed-cell" data-state="([^"]*)"/g)].map((x) => x[1]);
    expect(cells.length).toBe(10);
    expect(new Set(cells)).toEqual(new Set(["withheld"]));
    expect(text(m)).toContain("Proposed order quantities are withheld");
    expect(badge(m)).toBe("RULES: 1 OPEN");
  });
  it("the choice is honoured: 'do not count it' removes the overdue shipment from the inbound", async () => {
    local();
    const week1 = await A({ anchor: "last", overdue: "week1", view: "style" });
    const excl = await A({ anchor: "last", overdue: "exclude", view: "style" });
    const inbound = (m: string) => [...m.matchAll(/data-testid="row-key" data-key="([^"]*)"/g)].length;
    expect(inbound(week1)).toBe(2);
    expect(week1).not.toBe(excl);
  });
  it("the page shows the unmatched PO line as a limitation instead of hiding it", async () => {
    local();
    expect(text(await A({ anchor: "last", overdue: "week1" }))).toMatch(/match no SKU or style in Items/i);
  });
  it("SYNTHETIC data has no open rules and nothing withheld (existing behaviour unchanged)", async () => {
    synthetic();
    const m = await A();
    expect(ruleIds(m)).toEqual([]);
    expect(m).toContain('data-testid="indicators"');
    expect(badge(m)).toBe("RULES: NONE OPEN");
    expect([...m.matchAll(/data-testid="proposed-cell" data-state="([^"]*)"/g)].every((x) => x[1] === "value")).toBe(true);
  });
});

describe("rule detection is not fooled by edge cases", () => {
  it("an on-water line whose ETA equals the stock date counts as overdue (the engine treats week 0 as overdue)", async () => {
    await withFile("eta-equal.xlsx", (wb) => {
      const ws = wb.getWorksheet("ImportPOs")!;
      ws.getCell("K2").value = "2026-12-01"; // no longer overdue
      ws.getCell("K3").value = "2026-10-31"; // exactly the stock date
    });
    expect(ruleIds(await A())).toContain("overdue-on-water");
  });
  it("a PARTIAL tender column (some SKUs unmarked) keeps the tender rule open", async () => {
    await withFile("tender-partial.xlsx", (wb) => {
      const ws = wb.getWorksheet("Items")!;
      ws.getCell("N1").value = "Tender";
      ws.getCell("N2").value = "Yes";
      ws.getCell("N3").value = "No";
    });
    expect(ruleIds(await A({ anchor: "last", overdue: "week1" }))).toEqual(["tender-classification"]);
  });
  it("a COMPLETE tender column closes the tender rule", async () => {
    await withFile("tender-full.xlsx", (wb) => {
      const ws = wb.getWorksheet("Items")!;
      ws.getCell("N1").value = "Tender";
      for (let r = 2; r <= 11; r++) ws.getCell(`N${r}`).value = r === 2 ? "Yes" : "No";
    });
    expect(ruleIds(await A({ anchor: "last", overdue: "week1" }))).toEqual([]);
  });
  it("overhead and efficiency on only SOME routing lines keeps the overhead rule open", async () => {
    await withFile("overhead-partial.xlsx", (wb) => {
      const ws = wb.getWorksheet("Routing_SMV")!;
      ws.getCell("E4").value = "Overhead";
      ws.getCell("F4").value = "Efficiency";
      ws.getCell("E5").value = 0.1;
      ws.getCell("F5").value = 0.85;
    });
    expect(ruleIds(await B({ scale: "fraction" }))).toEqual(["overhead-efficiency-margin"]);
  });
});

describe("Scenario B: overhead, efficiency and margin", () => {
  it("names the unresolved rule and withholds cost totals and selling prices (nothing assumed)", async () => {
    local();
    const m = await B({ scale: "fraction" });
    expect(ruleIds(m)).toEqual(["overhead-efficiency-margin"]);
    expect(badge(m)).toBe("RULES: 1 OPEN");
    expect(indicator(m, "ind-costs")).toBe("0 of 10");
    expect(text(m)).toContain("Product cost totals and selling prices are withheld");
  });
  it("no cost total or selling price is populated anywhere while the rule is open", async () => {
    local();
    const m = await B({ scale: "fraction" });
    const sizes = [...m.matchAll(/data-testid="size-row" data-size="([^"]*)" data-total="([^"]*)" data-selling="([^"]*)"/g)];
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.every((x) => x[2] === "" && x[3] === "")).toBe(true);
    expect(indicator(m, "sel-total")).toBe("-");
    expect(indicator(m, "sel-selling")).toBe("-");
  });
  it("production variance is unaffected and still shown", async () => {
    local();
    expect(indicator(await B(), "ind-orders")).toBe("2");
  });
});

describe("Scenario C: paid or open exposure", () => {
  it("withholds the open USD exposure until the exposure basis is chosen, and says why", async () => {
    local();
    const m = await C();
    expect(ruleIds(m)).toEqual(["payment-status"]);
    expect(indicator(m, "ind-exposure")).toBe("Withheld");
    expect(text(m)).toMatch(/no paid-status column/i);
    expect(m).not.toContain('data-testid="bucket-row"');
    expect(badge(m)).toBe("RULES: 1 OPEN");
  });
  it("choosing 'due on or after the as-at date is open' shows the exposure, labelled as a chosen basis", async () => {
    local();
    const m = await C({ exposure: "due" });
    expect(ruleIds(m)).toEqual([]);
    expect(indicator(m, "ind-exposure")).not.toBe("Withheld");
    expect(text(m)).toContain("Basis chosen on this page");
  });
  it("while withheld, nothing says which payments are open: no open flag, no paid-status note, no 'fall due before' warning", async () => {
    local();
    const m = await C();
    expect(m).not.toContain("data-open=");
    expect(text(m)).not.toMatch(/fall due before|before as-at date|paid status unknown/i);
    const chosen = await C({ exposure: "due" });
    expect(chosen).toContain("data-open=");
  });
  it("landed cost itself is unaffected by the exposure rule", async () => {
    local();
    expect(indicator(await C(), "ind-landed")).not.toBeNull();
  });
  it("SYNTHETIC data shows exposure without a rule", async () => {
    synthetic();
    const m = await C();
    expect(ruleIds(m)).toEqual([]);
    expect(indicator(m, "ind-exposure")).not.toBe("Withheld");
  });
});

describe("Scenario D and the validation page", () => {
  it("Scenario D has no open commercial rule on this workbook", async () => {
    local();
    const m = await D();
    expect(ruleIds(m)).toEqual([]);
    expect(badge(m)).toBe("RULES: NONE OPEN");
    expect(indicator(m, "ind-total")).toBe("4");
  });
  it("the validation page shows the sheet layout and row accounting without any cell value", async () => {
    local();
    const m = renderToStaticMarkup(await ValidationPage());
    const rows = [...m.matchAll(/data-testid="layout-row" data-tab="([^"]*)" data-layout="([^"]*)" data-header-row="([^"]*)"/g)].map((x) => `${x[1]}:${x[2]}:${x[3]}`);
    expect(rows).toEqual(expect.arrayContaining(["BOM:report:4", "Routing_SMV:report:4", "ProductionOrders:report:3", "LandedCost:report:4", "Payments_FEC:report:3", "Items:standard:1"]));
    expect(text(m)).toContain("Sheet layout and row accounting");
    expect(text(m)).toContain("ReadMe");
    expect(m).not.toContain("SYN-VEST-A");
  });
});
