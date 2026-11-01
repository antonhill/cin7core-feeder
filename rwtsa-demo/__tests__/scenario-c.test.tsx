import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { colOf, sheet, synthBuffer } from "@/rwtsa-demo/__tests__/helpers";
import ScenarioCPage from "../app/scenario-c/page";

/** Scenario C: the real page module on SYNTHETIC data (hand-checked figures) and on workbooks with gaps. */

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "rwtsa-scenario-c-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

const synthetic = () => {
  vi.stubEnv("RWTSA_SOURCE", "synthetic");
  vi.stubEnv("RWTSA_WORKBOOK_PATH", "");
};
const page = async (q: Record<string, string> = {}) => renderToStaticMarkup(await ScenarioCPage({ searchParams: Promise.resolve(q) }));
const decode = (t: string) => t.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = (m: string) => decode(m.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
const indicator = (m: string, id: string) => {
  const r = new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`).exec(m);
  return r ? decode(r[1]).trim() : null;
};
const lines = (m: string) => [...m.matchAll(/data-testid="line" data-shipment="([^"]*)" data-sku="([^"]*)" data-landed="([^"]*)" data-freight="([^"]*)"/g)].map((x) => ({ shipment: x[1], sku: x[2], landed: x[3] === "" ? null : Number(x[3]), freight: x[4] === "" ? null : Number(x[4]) }));
const line = (m: string, shipment: string, sku: string) => lines(m).find((l) => l.shipment === shipment && l.sku === sku)!;

describe("provenance, readiness and layers", () => {
  it("shows provenance, structure, READY, engine and that only the TOOLBOX rows are calculated here", async () => {
    synthetic();
    const m = await page();
    const t = text(m);
    expect(t).toContain("SYNTHETIC");
    expect(t).toContain("STRUCTURE PASS");
    expect(t).toContain("READY");
    expect(t).toContain("ENGINE AVAILABLE");
    expect(t).toContain("CALCULATED HERE: TOOLBOX");
    expect(t).toContain("Where each function lives");
    expect(t).toContain("CIN7 CORE");
    expect(t).toContain("XERO");
    expect(t).toContain("TOOLBOX");
    expect(t).toContain("TO BE VERIFIED INDEPENDENTLY");
    expect(t).toContain("neither reads nor writes either");
  });
  it("has no state-changing form, no script and no remote reference (read-only)", async () => {
    synthetic();
    const m = await page();
    expect(m).not.toMatch(/method="post"/i);
    expect(m).not.toContain("<script");
    expect(m).not.toMatch(/https?:\/\//i);
  });
});

describe("shipment-specific landed cost on the synthetic workbook", () => {
  it("allocates each shipment's freight by CBM share within that shipment", async () => {
    synthetic();
    const m = await page();
    // SHIP-SYN-1: freight R9,000 over CBM 4.2 / 6.3 / 2.1 -> 3,000 / 4,500 / 1,500
    expect(line(m, "SHIP-SYN-1", "SYN-VEST-A-M").freight).toBe(300000);
    expect(line(m, "SHIP-SYN-1", "SYN-VEST-B-L").freight).toBe(450000);
    expect(line(m, "SHIP-SYN-1", "SYN-VEST-A-XL").freight).toBe(150000);
    // SHIP-SYN-2: freight R6,000 over CBM 2.8 / 4.9 -> 2,181.82 / 3,818.18
    expect(line(m, "SHIP-SYN-2", "SYN-VEST-A-M").freight).toBe(218182);
    expect(line(m, "SHIP-SYN-2", "SYN-VEST-TT-L").freight).toBe(381818);
  });
  it("the SKU in two shipments gets a separate allocation in each (R3,000.00 and R2,181.82), never a shared one", async () => {
    synthetic();
    const m = await page();
    expect(line(m, "SHIP-SYN-1", "SYN-VEST-A-M").freight).not.toBe(line(m, "SHIP-SYN-2", "SYN-VEST-A-M").freight);
    const sku = /data-testid="sku-row" data-sku="SYN-VEST-A-M" data-shipments="(\d+)"/.exec(m);
    expect(sku?.[1]).toBe("2");
  });
  it("landed cost = customs value (FOB x customs FX) + duty + freight: R31,020.00 for the first line", async () => {
    synthetic();
    const m = await page();
    expect(line(m, "SHIP-SYN-1", "SYN-VEST-A-M").landed).toBe(27900_00 + 120_00 + 3000_00);
    expect(line(m, "SHIP-SYN-2", "SYN-VEST-A-M").landed).toBe(18900_00 + 80_00 + 218182);
  });
  it("freight allocated equals the shipment freight on every shipment row", async () => {
    synthetic();
    const t = text(await page());
    expect(t).toContain("R9,000.00 / R9,000.00");
    expect(t).toContain("R6,000.00 / R6,000.00");
  });
  it("every reconciliation check is OK on clean data, including the five identities", async () => {
    synthetic();
    const m = await page();
    const checks = [...m.matchAll(/data-testid="check" data-id="([^"]*)" data-ok="([^"]*)"/g)].map((x) => [x[1], x[2]]);
    expect(checks.length).toBeGreaterThanOrEqual(7);
    expect(checks.every(([, ok]) => ok === "true")).toBe(true);
  });
  it("shipment rows add up to the grand total shown in the indicator", async () => {
    synthetic();
    const m = await page();
    const total = [...m.matchAll(/data-testid="shipment-row" data-key="[^"]*" data-landed="(\d+)"/g)].reduce((a, x) => a + Number(x[1]), 0);
    const shown = indicator(m, "ind-landed")!.replace(/[R,.]/g, "");
    expect(String(total)).toBe(shown);
    const fromLines = lines(m).reduce((a, l) => a + (l.landed ?? 0), 0);
    expect(fromLines).toBe(total);
  });
  it("estimated versus actual: the FX variance uses planning FX 18.0 vs customs FX 18.6 and names both sources", async () => {
    synthetic();
    const m = await page();
    const t = text(m);
    expect(t).toContain("LandedCost.planningFx");
    expect(t).toContain("LandedCost.customsFx");
    // first line FOB $1,500: (18.6 - 18.0) x 1,500 = +R900.00
    expect(t).toContain("+R900.00");
    expect(indicator(m, "ind-variance")).toMatch(/^\+R/);
  });
  it("states its assumptions, including what the duty column is taken to mean", async () => {
    synthetic();
    const t = text(await page());
    expect(t).toContain("Customs value is taken to be the FOB value converted at the customs FX rate");
    expect(t).toContain("Duty is the ZAR amount in the workbook");
    expect(t).toContain("whole cents (largest remainder)");
  });
});

describe("controls", () => {
  it("offers duty rate, shipment, issues, as-at date and bucket as a plain GET form", async () => {
    synthetic();
    const m = await page();
    expect(m).toContain('data-testid="controls"');
    for (const n of ["duty", "ship", "issues", "asof", "bucket"]) expect(m, n).toContain(`name="${n}"`);
  });
  it("a duty rate recalculates duty on customs value and says the rate is an assumption", async () => {
    synthetic();
    const base = await page();
    const m = await page({ duty: "10" });
    // 10% of R27,900.00 = R2,790.00 instead of R120.00
    expect(line(m, "SHIP-SYN-1", "SYN-VEST-A-M").landed).toBe(27900_00 + 2790_00 + 3000_00);
    expect(line(m, "SHIP-SYN-1", "SYN-VEST-A-M").landed).not.toBe(line(base, "SHIP-SYN-1", "SYN-VEST-A-M").landed);
    expect(text(m)).toContain("This rate is an assumption entered on screen");
  });
  it("filters by shipment", async () => {
    synthetic();
    const m = await page({ ship: "SHIP-SYN-2" });
    expect(new Set(lines(m).map((l) => l.shipment))).toEqual(new Set(["SHIP-SYN-2"]));
    expect(lines(m)).toHaveLength(2);
  });
  it("invalid controls are reported, replaced by defaults, and never echoed", async () => {
    synthetic();
    const m = await page({ duty: "150", asof: "<b>x</b>", bucket: "day" });
    expect(m).toContain('data-testid="settings-errors"');
    expect(m).not.toContain("<b>x</b>");
    expect(lines(m).length).toBe(5);
  });
});

describe("USD exposure by due date and FX comparison", () => {
  it("counts payments due on or after the as-at date (the earlier two are listed, not counted)", async () => {
    synthetic();
    const m = await page();
    const t = text(m);
    expect(indicator(m, "ind-exposure")).toBe("$13,950.00"); // 4,050 + 3,150 + 6,750
    expect(t).toContain("before as-at date; paid status unknown");
    expect(t).toContain("Not a forward-contract register");
  });
  it("buckets by month; covered (FEC) and uncovered add up", async () => {
    synthetic();
    const m = await page();
    const bars = [...m.matchAll(/data-testid="exposure-bar" data-key="([^"]*)" data-covered="(\d+)" data-uncovered="(\d+)"/g)].map((x) => [x[1], Number(x[2]), Number(x[3])]);
    expect(bars).toEqual([["2026-11", 405000, 0], ["2026-12", 0, 315000], ["2027-01", 0, 675000]]);
    const w = await page({ bucket: "week" });
    expect([...w.matchAll(/data-testid="exposure-bar" data-key="([^"]*)"/g)].map((x) => x[1])).toEqual(["week 3", "week 6", "week 12"]);
  });
  it("the as-at date changes what is open", async () => {
    synthetic();
    expect(indicator(await page({ asof: "2026-12-15" }), "ind-exposure")).toBe("$6,750.00");
  });
  it("compares planning, FEC and customs per payment and withholds what it cannot match", async () => {
    synthetic();
    const t = text(await page());
    expect(t).toContain("FEC-SYN-2 @ 18.3");
    // PO-SYN-002: $4,050 -> FEC 74,115.00; planning 18.0 -> 72,900.00; customs 18.6 -> 75,330.00
    expect(t).toContain("R74,115.00");
    expect(t).toContain("R72,900.00");
    expect(t).toContain("R75,330.00");
    expect(t).toContain("+R1,215.00");
    expect(t).toContain("-R1,215.00");
  });
});

describe("incomplete or missing inputs are exposed, never invented", () => {
  async function withWorkbook(mutate: Parameters<typeof synthBuffer>[1], name: string) {
    const file = join(tmp, name);
    writeFileSync(file, await synthBuffer({}, mutate));
    vi.stubEnv("RWTSA_SOURCE", "");
    vi.stubEnv("RWTSA_WORKBOOK_PATH", file);
  }
  it("a blank FOB leaves that line without figures, names the field, and withholds the shipment total", async () => {
    await withWorkbook((wb) => {
      const ws = sheet(wb, "LandedCost");
      ws.getRow(2).getCell(colOf(ws, "FOB USD")).value = null;
    }, "no-fob.xlsx");
    const m = await page();
    const t = text(m);
    expect(t).toContain("LOCAL WORKBOOK");
    expect(line(m, "SHIP-SYN-1", "SYN-VEST-A-M").landed).toBeNull();
    expect(t).toContain("fobUsd");
    expect(t).toContain("INCOMPLETE: partial (2 of 3 lines)");
    expect(indicator(m, "ind-incomplete")).toBe("1");
    expect(m).toMatch(/data-testid="check" data-id="complete" data-ok="false"/);
    expect(t).toContain("complete lines only");
    // The other lines of that shipment keep their freight: one gap does not shift the allocation.
    expect(line(m, "SHIP-SYN-1", "SYN-VEST-B-L").freight).toBe(450000);
  });
  it("a missing planning FX still gives the actual landed cost but withholds the estimate and the variance", async () => {
    await withWorkbook((wb) => {
      const ws = sheet(wb, "LandedCost");
      ws.getRow(2).getCell(colOf(ws, "Planning FX")).value = null;
    }, "no-plan.xlsx");
    const m = await page();
    expect(line(m, "SHIP-SYN-1", "SYN-VEST-A-M").landed).toBe(27900_00 + 120_00 + 3000_00);
    expect(text(m)).toContain("planningFx");
  });
  it("workbook freight allocations that differ from the CBM split are flagged", async () => {
    await withWorkbook((wb) => {
      const ws = sheet(wb, "LandedCost");
      ws.getRow(2).getCell(colOf(ws, "Freight allocated")).value = 2500;
    }, "wb-freight.xlsx");
    const m = await page();
    expect(text(m)).toMatch(/workbook's own freight allocation differs/i);
    expect(m).toMatch(/data-testid="check" data-id="workbook-freight" data-ok="false"/);
  });
  it("an unusable workbook gives no engine, no figures and no substituted data", async () => {
    vi.stubEnv("RWTSA_SOURCE", "");
    vi.stubEnv("RWTSA_WORKBOOK_PATH", join(tmp, "missing.xlsx"));
    const m = await page();
    const t = text(m);
    expect(t).toContain("ENGINE UNAVAILABLE");
    expect(t).toContain("NOT READY");
    expect(t).not.toContain("SYNTHETIC");
    expect(lines(m)).toEqual([]);
    expect(m).not.toContain('data-testid="indicators"');
  });
  it("a workbook that is NOT READY for scenario C still runs, and says so plainly", async () => {
    await withWorkbook((wb) => {
      const ws = sheet(wb, "LandedCost");
      for (let r = 2; r <= ws.rowCount; r++) ws.getRow(r).getCell(colOf(ws, "Customs FX")).value = null;
    }, "no-customs.xlsx");
    const m = await page();
    const t = text(m);
    expect(t).toContain("NOT READY");
    expect(t).toContain("does not make the data ready");
    expect(indicator(m, "ind-incomplete")).toBe("5");
    expect(lines(m).every((l) => l.landed === null)).toBe(true);
  });
});
