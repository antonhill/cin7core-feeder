import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { originalShapedBuffer } from "@/rwtsa-demo/fixtures/original-shaped";
import ScenarioAPage from "../app/scenario-a/page";

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
const indicator = (m: string, id: string) => {
  const r = new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`).exec(m);
  return r ? decode(r[1]).trim() : null;
};
const ruleIds = (m: string) => [...m.matchAll(/data-testid="rule-row" data-id="([^"]*)"/g)].map((x) => x[1]);


const states = (m: string) => Object.fromEntries([...m.matchAll(/data-testid="eligibility-row" data-id="([^"]*)" data-state="([^"]*)"/g)].map((x) => [x[1], x[2]]));

describe("Scenario A core: forecast basis, stale history and the 6 v 12 month comparison", () => {
  it("shows the last observed month, the stock date, the missing months, the window and a stale-history warning", async () => {
    local();
    const m = await A();
    expect(indicator(m, "basis-last-month")).toMatch(/^\d{4}-\d{2}$/);
    expect(indicator(m, "basis-stock-date")).toBe("2026-10-31");
    expect(indicator(m, "basis-gap")).not.toBe("none");
    expect(indicator(m, "basis-window")).toMatch(/6 month\(s\)/);
    expect(text(m)).toMatch(/STALE HISTORY/);
    expect(text(m)).toMatch(/none is invented/i);
  });
  it("compares six- and twelve-month averages with the workbook's own references and says how many agree", async () => {
    local();
    const t = text(await A());
    expect(t).toMatch(/Six-month: \d+ of \d+ SKUs agree with the workbook's own 6-month average/);
    expect(t).toMatch(/Twelve-month: \d+ of \d+ agree with its 12-month average/);
  });
  it("the stale-history rule follows the data, not the source: synthetic history that ends before the stock month shows it too", async () => {
    synthetic();
    const m = await A();
    expect(text(m)).toMatch(/STALE HISTORY/);
    expect(indicator(m, "basis-last-month")).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe("Scenario A core: narrow withholding", () => {
  it("a missing tender classification does not stop demand, shortage or projection; only proposed orders are withheld", async () => {
    local();
    const st = states(await A());
    expect(["available", "committed", "history", "forecast", "projection", "first-shortage", "shortfall"].every((k) => st[k] !== "withheld")).toBe(true);
    expect(st["proposed-orders"]).toBe("withheld");
  });
  it("with a complete tender marker the proposed orders are no longer withheld", async () => {
    await withFile("tender-full-core.xlsx", (wb) => {
      const ws = wb.getWorksheet("Items")!;
      ws.getCell("N1").value = "Tender";
      for (let r = 2; r <= 11; r++) ws.getCell(`N${r}`).value = "No";
    });
    const m = await A();
    expect(states(m)["proposed-orders"]).not.toBe("withheld");
    expect(new Set([...m.matchAll(/data-testid="proposed-cell" data-state="([^"]*)"/g)].map((x) => x[1]))).toEqual(new Set(["value"]));
  });
  it("history that is only stale (nothing overdue) still marks projection and shortage as resting on an assumption", async () => {
    await withFile("no-overdue.xlsx", (wb) => {
      const ws = wb.getWorksheet("ImportPOs")!;
      for (let r = 2; r <= 5; r++) ws.getCell(`K${r}`).value = "2027-03-01"; // ImportPOs has 4 data rows
    });
    const st = states(await A());
    expect(st.projection).toBe("assumption");
    expect(st.shortfall).toBe("assumption");
  });
  it("an unresolved overdue rule never withholds history, stock, committed or forecast", async () => {
    local();
    const m = await A();
    expect(ruleIds(m)).toContain("overdue-on-water");
    const st = states(m);
    expect(st.available).toBe("available");
    expect(st.committed).toBe("available");
    expect(st.projection).toBe("assumption");
  });
});

describe("Scenario A core: Rev2 size curve, overdue treatment and cover", () => {
  it("applies and labels the Rev2 curve with its provenance, and the allocation reconciles exactly to the style-level quantity", async () => {
    local();
    const m = await A();
    expect(text(m)).toMatch(/Curve applied: RWTSA Rev2 size curve/);
    expect(text(m)).toMatch(/Rev 2 \(29 Oct 2026\), section B 'Size split'/);
    expect(text(m)).toMatch(/reconciles exactly/);
    const lines = [...m.matchAll(/data-testid="alloc-line" data-sum="(\d+)" data-qty="(\d+)"/g)];
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l[1] === l[2])).toBe(true);
  });
  it("the curve can be switched off, and then style-level quantities stay unallocated (nothing invented)", async () => {
    local();
    const m = await A({ curve: "none" });
    expect(text(m)).toMatch(/held unallocated/);
  });
  it("overdue on-water units are kept apart, never counted as received, and the treatment is a labelled demonstration assumption", async () => {
    local();
    const ex = text(await A());
    const w1 = text(await A({ overdue: "week1" }));
    expect(ex).toMatch(/never counted as received/);
    expect(ex).toMatch(/excluded from usable inbound \(conservative demonstration assumption\)/);
    expect(w1).toMatch(/assumed to arrive in week 1 \(demonstration assumption\)/);
    expect(ex).toMatch(/In transit is never added/);
  });
  it("shows opening cover and cover including inbound, with the inbound units included", async () => {
    synthetic();
    const m = await A();
    const units = [...m.matchAll(/data-testid="cover-inbound" data-units="([^"]*)"/g)];
    expect(units.length).toBe(24);
    expect(text(m)).toContain("Cover: opening (months)");
    expect(text(m)).toContain("Cover incl. inbound (months)");
  });
});

describe("Scenario A core: DP-13 formulas by horizon, both labelled", () => {
  it("shows the approved minimum-shortfall rule and the RFP net requirement for 13 and 26 weeks, and records the owner decision", async () => {
    synthetic();
    const m = await A();
    const rows = [...m.matchAll(/data-testid="horizon-row" data-key="([^"]*)" data-a13="([^"]*)" data-n13="([^"]*)" data-a26="([^"]*)" data-n26="([^"]*)"/g)];
    expect(rows.length).toBe(24);
    const t = text(m);
    expect(t).toMatch(/Approved rule \(unchanged\)/);
    expect(t).toMatch(/RFP DP-13 net requirement/);
    expect(t).toMatch(/OWNER DECISION REQUIRED/);
    expect(t).toContain("13 wk: approved");
    expect(t).toContain("26 wk: RFP net");
  });
  it("the horizon table is the same whichever horizon drives the main table", async () => {
    synthetic();
    const pick = (m: string) => [...m.matchAll(/data-testid="horizon-row" data-key="([^"]*)" data-a13="([^"]*)" data-n13="([^"]*)" data-a26="([^"]*)" data-n26="([^"]*)"/g)].map((x) => x.slice(1).join("|"));
    expect(pick(await A({ horizon: "13" }))).toEqual(pick(await A({ horizon: "26" })));
  });
  it("proposed quantities in the comparison are withheld while tender classification is open", async () => {
    local();
    const m = await A();
    expect(text(m)).toMatch(/13 wk: approved/);
    expect(m).toContain("Withheld");
    // the quantities must not be present anywhere in the markup either
    const rows = [...m.matchAll(/data-testid="horizon-row" data-key="[^"]*" data-a13="([^"]*)" data-n13="([^"]*)" data-a26="([^"]*)" data-n26="([^"]*)"/g)];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.slice(1).every((v) => v === ""))).toBe(true);
  });
});

describe("Scenario A core: controls and defaults", () => {
  it("a local workbook defaults to the conservative overdue treatment and the Rev2 curve; synthetic keeps its own defaults", async () => {
    local();
    const m = await A();
    expect(/name="overdue"[^>]*>(?:(?!<\/select>).)*<option value="exclude" selected=""/.test(m)).toBe(true);
    expect(/name="curve"[^>]*>(?:(?!<\/select>).)*<option value="rev2" selected=""/.test(m)).toBe(true);
    synthetic();
    const s = await A();
    expect(/name="overdue"[^>]*>(?:(?!<\/select>).)*<option value="week1" selected=""/.test(s)).toBe(true);
  });
  it("there is no 'not chosen' state and no wholesale withholding message", async () => {
    local();
    const m = await A();
    expect(text(m)).not.toMatch(/Not chosen/);
    expect(text(m)).not.toMatch(/Results withheld/);
  });
});
