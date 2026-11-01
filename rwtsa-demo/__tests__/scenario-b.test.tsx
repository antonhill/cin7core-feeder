import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { colOf, sheet, synthBuffer } from "@/rwtsa-demo/__tests__/helpers";
import ScenarioBPage from "../app/scenario-b/page";

/** Scenario B: the real page module on SYNTHETIC data (hand-checked figures) and on workbooks with gaps. */

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "rwtsa-scenario-b-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

const synthetic = () => {
  vi.stubEnv("RWTSA_SOURCE", "synthetic");
  vi.stubEnv("RWTSA_WORKBOOK_PATH", "");
};
const page = async (q: Record<string, string> = {}) => renderToStaticMarkup(await ScenarioBPage({ searchParams: Promise.resolve(q) }));
const decode = (t: string) => t.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = (m: string) => decode(m.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
const indicator = (m: string, id: string) => {
  const r = new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`).exec(m);
  return r ? decode(r[1]).trim() : null;
};
const attr = (m: string, testid: string, name: string) => [...m.matchAll(new RegExp(`data-testid="${testid}"[^>]*? ${name}="([^"]*)"`, "g"))].map((x) => x[1]);
const groupKeys = (m: string) => attr(m, "group-row", "data-key");
const sizeRows = (m: string) => [...m.matchAll(/data-testid="size-row" data-size="([^"]*)" data-total="([^"]*)" data-selling="([^"]*)" data-status="([^"]*)"/g)].map((x) => ({ size: x[1], total: x[2] === "" ? null : Number(x[2]), selling: x[3] === "" ? null : Number(x[3]), status: x[4] }));

describe("status, layers and read-only", () => {
  it("shows provenance, structure, READY, engine and the real-workbook status as separate facts", async () => {
    synthetic();
    const t = text(await page());
    expect(t).toContain("SYNTHETIC");
    expect(t).toContain("STRUCTURE PASS");
    expect(t).toContain("READY");
    expect(t).toContain("ENGINE AVAILABLE");
    expect(t).toContain("REAL WORKBOOK: UNVERIFIED");
    expect(t).toContain("CALCULATED HERE: TOOLBOX");
  });
  it("labels the layers: TOOLBOX calculated here, CIN7 CORE source records, FAST REACT not built", async () => {
    synthetic();
    const t = text(await page());
    expect(t).toContain("CIN7 CORE");
    expect(t).toContain("TOOLBOX");
    expect(t).toContain("FAST REACT / EXTERNAL");
    expect(t).toContain("builds no Fast React file");
    expect(t).toContain("TO BE VERIFIED INDEPENDENTLY");
  });
  it("has no state-changing form, no script and no remote reference", async () => {
    synthetic();
    const m = await page();
    expect(m).not.toMatch(/method="post"/i);
    expect(m).not.toContain("<script");
    expect(m).not.toMatch(/https?:\/\//i);
  });
});

describe("production variance", () => {
  it("shows the six indicators", async () => {
    synthetic();
    const m = await page();
    for (const id of ["ind-orders", "ind-recovery", "ind-usage", "ind-price", "ind-labour", "ind-costs"]) expect(indicator(m, id), id).not.toBeNull();
    expect(indicator(m, "ind-orders")).toBe("12");
    expect(indicator(m, "ind-costs")).toBe("24 of 24");
  });
  it("groups by style, production line and order-size bracket", async () => {
    synthetic();
    expect(groupKeys(await page({ by: "style" }))).toEqual(["SYN-VEST-A", "SYN-VEST-B", "SYN-VEST-TT"]);
    expect(groupKeys(await page({ by: "line" }))).toEqual(["Line 1", "Line 2"]);
    expect(groupKeys(await page({ by: "bracket" }))).toEqual(["0-99", "100-249", "250-499", "500-999", "1000-2499", "2500+"]);
  });
  it("the order-size brackets are configurable (lower bound inclusive)", async () => {
    synthetic();
    expect(groupKeys(await page({ by: "bracket", brackets: "100,1000" }))).toEqual(["0-99", "100-999", "1000+"]);
    const m = await page({ by: "bracket", brackets: "120" });
    expect(groupKeys(m)).toEqual(["0-119", "120+"]);
  });
  it("lists all twelve orders with their variances", async () => {
    synthetic();
    const m = await page();
    expect(attr(m, "order-row", "data-order")).toHaveLength(12);
    expect(attr(m, "order-row", "data-valid").every((x) => x === "true")).toBe(true);
  });
  it("group labour variances add up to the grand total whichever way they are grouped", async () => {
    synthetic();
    const totals: number[] = [];
    for (const by of ["style", "line", "bracket"]) totals.push(attr(await page({ by }), "group-row", "data-labour").reduce((a, x) => a + Number(x), 0));
    expect(new Set(totals).size).toBe(1);
    const orders = attr(await page(), "order-row", "data-labour").reduce((a, x) => a + Number(x), 0);
    expect(orders).toBe(totals[0]);
  });
  it("the recovery chart has one bar per group and its values match the table (weighted, not averaged)", async () => {
    synthetic();
    const m = await page({ by: "bracket" });
    expect(m).toContain('data-testid="recovery-chart"');
    const bars = attr(m, "recovery-bar", "data-pct");
    expect(bars).toEqual(attr(m, "group-row", "data-recovery"));
    expect(bars).toHaveLength(6);
    expect(Number(bars[0])).toBeLessThan(Number(bars[5])); // short runs recover less
  });
  it("states the sign convention, the weighted recovery rule and the cost-per-minute source", async () => {
    synthetic();
    const t = text(await page());
    expect(t).toContain("Positive rand variances are unfavourable");
    expect(t).toContain("never an average of order percentages");
    expect(t).toContain("SMV-weighted average cost per minute");
  });
});

describe("per-size costing", () => {
  it("costs size M of the first style at R114.50 and the selling price at R183.20", async () => {
    synthetic();
    const m = await page({ style: "SYN-VEST-A", size: "M" });
    const t = text(m);
    expect(indicator(m, "sel-total")).toBe("R114.50");
    expect(indicator(m, "sel-selling")).toBe("R183.20");
    expect(indicator(m, "sel-reference")).toBe("R102.00");
    expect(t).toContain("+R12.50 (+12.3%)");
  });
  it("size 3XL uses the longer zip: R117.00, and the substitution is listed", async () => {
    synthetic();
    const m = await page({ style: "SYN-VEST-A", size: "3XL" });
    expect(indicator(m, "sel-total")).toBe("R117.00");
    expect(text(m)).toContain("ZIP-SHORT replaced by ZIP-LONG");
    const lines = attr(m, "cost-line", "data-code");
    expect(lines).toContain("ZIP-LONG");
    expect(lines).not.toContain("ZIP-SHORT");
  });
  it("lists every size of the style with its cost, and per-size differences", async () => {
    synthetic();
    const rows = sizeRows(await page({ style: "SYN-VEST-A" }));
    expect(rows.map((r) => r.size)).toEqual(["S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"]);
    expect(rows.map((r) => r.total)).toEqual([11450, 11450, 11450, 11450, 11450, 11700, 11700, 11700]);
    expect(rows.every((r) => r.status === "complete")).toBe(true);
    expect(text(await page({ style: "SYN-VEST-A" }))).toContain("+R2.50");
  });
  it("the two-tone style includes the contrast fabric", async () => {
    synthetic();
    const m = await page({ style: "SYN-VEST-TT", size: "M" });
    expect(indicator(m, "sel-total")).toBe("R133.70");
    expect(attr(m, "cost-line", "data-code")).toContain("FABRIC-NAVY");
  });
  it("shows the cost composition, and the parts add up to the total", async () => {
    synthetic();
    const m = await page({ style: "SYN-VEST-A", size: "M" });
    expect(m).toContain('data-testid="composition"');
    const parts = attr(m, "composition-part", "data-cents").map(Number);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(11450);
    expect(attr(m, "composition-part", "data-part")).toEqual(["fabric-materials", "trims-thread", "print-packaging", "labour", "efficiency", "overhead"]);
  });
  it("the BOM breakdown shows quantity and unit cost for each component", async () => {
    synthetic();
    const t = text(await page({ style: "SYN-VEST-A", size: "M" }));
    expect(t).toContain("Reflective fabric");
    expect(t).toContain("55.00");
    expect(t).toContain("R66.00");
  });
  it("markup and the size rule are controls", async () => {
    synthetic();
    expect(indicator(await page({ style: "SYN-VEST-A", size: "M", markup: "2" }), "sel-selling")).toBe("R229.00");
    expect(indicator(await page({ style: "SYN-VEST-A", size: "3XL", rule: "add" }), "sel-total")).toBe("R123.00"); // keeps the short zip (R6.00) as well as the long one: 117 + 6
  });
  it("the percentage scale is never assumed for a local workbook, and a chosen scale applies", async () => {
    vi.stubEnv("RWTSA_SOURCE", "");
    const file = join(tmp, "plain.xlsx");
    writeFileSync(file, await synthBuffer());
    vi.stubEnv("RWTSA_WORKBOOK_PATH", file);
    const none = await page({ style: "SYN-VEST-A", size: "M" });
    expect(indicator(none, "sel-total")).toBe("-");
    expect(text(none)).toContain("percentage scale");
    expect(text(none)).toContain("This is a hint only");
    expect(indicator(none, "ind-costs")).toBe("0 of 24");
    const chosen = await page({ style: "SYN-VEST-A", size: "M", scale: "fraction" });
    expect(indicator(chosen, "sel-total")).toBe("R114.50");
    expect(text(chosen)).toContain("because it was chosen, not because the workbook says so");
    expect(text(chosen)).toContain("STRUCTURE VALIDATED, UNITS AND SCALE UNVERIFIED");
  });
  it("a different chosen scale changes the result, so the choice matters", async () => {
    synthetic();
    const m = await page({ style: "SYN-VEST-A", size: "M", scale: "percent" });
    // 0.85 read as a percent is 0.85% efficiency: implausible, so the cost is withheld instead of being shown.
    expect(indicator(m, "sel-total")).toBe("-");
    expect(text(m)).toContain("efficiency value out of range");
  });
  it("a tiny negative variance never renders as -0.00", async () => {
    synthetic();
    expect(text(await page())).not.toContain("-0.00");
  });
  it("invalid controls are reported, replaced by defaults, and never echoed", async () => {
    synthetic();
    const m = await page({ markup: "0.2", scale: "<i>x</i>", brackets: "5,3", by: "x" });
    expect(m).toContain('data-testid="settings-errors"');
    expect(m).not.toContain("<i>x</i>");
    expect(indicator(m, "ind-orders")).toBe("12");
  });
});

describe("incomplete inputs are exposed, never invented", () => {
  async function withWorkbook(mutate: Parameters<typeof synthBuffer>[1], name: string) {
    const file = join(tmp, name);
    writeFileSync(file, await synthBuffer({}, mutate));
    vi.stubEnv("RWTSA_SOURCE", "");
    vi.stubEnv("RWTSA_WORKBOOK_PATH", file);
  }
  it("a missing component price withholds the cost for the sizes that use it and names the component", async () => {
    await withWorkbook((wb) => {
      const ws = sheet(wb, "BOM");
      for (let r = 2; r <= ws.rowCount; r++) if (ws.getRow(r).getCell(colOf(ws, "Component code")).value === "THREAD") ws.getRow(r).getCell(colOf(ws, "Unit cost")).value = null;
    }, "no-thread.xlsx");
    const m = await page({ scale: "fraction", style: "SYN-VEST-A", size: "M" });
    const t = text(m);
    expect(indicator(m, "sel-total")).toBe("-");
    expect(t).toContain("unit cost of THREAD");
    expect(t).toContain("Nothing has been estimated in its place");
    expect(sizeRows(m).every((r) => r.status === "incomplete" && r.total === null)).toBe(true);
    expect(m).toMatch(/data-testid="check" data-id="costing:complete" data-ok="false"/);
  });
  it("a blank actual price leaves the price variance blank for that order and says how many orders it covers", async () => {
    await withWorkbook((wb) => {
      const ws = sheet(wb, "ProductionOrders");
      ws.getRow(2).getCell(colOf(ws, "Actual price")).value = null;
    }, "no-price.xlsx");
    const m = await page({ scale: "fraction" });
    expect(attr(m, "order-row", "data-price")[0]).toBe("");
    expect(text(m)).toContain("11 of 12");
    expect(text(m)).toContain("have no actual price");
    expect(m).toMatch(/data-testid="check" data-id="variance:complete" data-ok="false"/);
  });
  it("an unusable workbook gives no engine, no figures and no substituted data", async () => {
    vi.stubEnv("RWTSA_SOURCE", "");
    vi.stubEnv("RWTSA_WORKBOOK_PATH", join(tmp, "missing.xlsx"));
    const m = await page();
    const t = text(m);
    expect(t).toContain("ENGINE UNAVAILABLE");
    expect(t).toContain("NOT READY");
    expect(t).not.toContain("SYNTHETIC");
    expect(m).not.toContain('data-testid="indicators"');
  });
  it("a workbook that is NOT READY for scenario B still runs, and says so plainly", async () => {
    await withWorkbook((wb) => {
      const ws = sheet(wb, "Routing_SMV");
      for (let r = 2; r <= ws.rowCount; r++) ws.getRow(r).getCell(colOf(ws, "Efficiency")).value = null;
    }, "no-eff.xlsx");
    const m = await page({ scale: "fraction" });
    const t = text(m);
    expect(t).toContain("NOT READY");
    expect(t).toContain("does not make the data ready");
    expect(indicator(m, "ind-costs")).toBe("0 of 24");
    expect(t).toContain("efficiency");
  });
});
