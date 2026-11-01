import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { colOf, sheet, synthBuffer } from "@/rwtsa-demo/__tests__/helpers";
import ScenarioDPage from "../app/scenario-d/page";

/**
 * Scenario D: the real page module on the SYNTHETIC workbook. Expected figures are worked out by hand from the fixture:
 * 12 quotes i=0..11, value 10000 + 2500 i; status won,lost,open,won,lost,won,open,lost,won,lost,won,open; rep = One,Two,Three by i mod 3;
 * customer = i mod 5 + 1; quote month = (i mod 9) + 1.
 *   won 5 = 115,000.00 | lost 4 = 92,500.00 | open 3 = 77,500.00 | closed 9 = 207,500.00
 *   count conversion 5/9 = 55.6% | value conversion 115,000/207,500 = 55.4%
 */

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "rwtsa-scenario-d-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

const synthetic = () => {
  vi.stubEnv("RWTSA_SOURCE", "synthetic");
  vi.stubEnv("RWTSA_WORKBOOK_PATH", "");
};
const page = async (q: Record<string, string> = {}) => renderToStaticMarkup(await ScenarioDPage({ searchParams: Promise.resolve(q) }));
const decode = (t: string) => t.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = (m: string) => decode(m.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
const indicator = (m: string, id: string) => {
  const r = new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`).exec(m);
  return r ? decode(r[1]).trim() : null;
};
const rows = (m: string, testid: string): Record<string, string>[] =>
  [...m.matchAll(new RegExp(`<span data-testid="${testid}"([^>]*)></span>`, "g"))].map((x) => Object.fromEntries([...x[1].matchAll(/ data-([a-z-]+)="([^"]*)"/g)].map((a) => [a[1], decode(a[2])])));
const keyed = (m: string, testid: string, key: string) => {
  const r = rows(m, testid).find((x) => x.key === key);
  if (!r) throw new Error(`no ${testid} ${key}`);
  return r;
};

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
  it("labels the layers: CIN7 CORE source records to be verified, TOOLBOX analytics, nothing synchronised", async () => {
    synthetic();
    const t = text(await page());
    expect(t).toContain("CIN7 CORE");
    expect(t).toContain("TOOLBOX");
    expect(t).toContain("TO BE VERIFIED INDEPENDENTLY");
    expect(t).toMatch(/not synchronised with Cin7/i);
    expect(t).toMatch(/creates no quotation or sales order/i);
  });
  it("is read-only: no state-changing form, no script, no remote reference", async () => {
    synthetic();
    const m = await page();
    expect(m).not.toMatch(/method="post"/i);
    expect(m).not.toContain("<script");
    expect(m).not.toMatch(/https?:\/\//i);
    const form = /<form[^>]*data-testid="controls"[^>]*>/.exec(m)?.[0] ?? "";
    expect(form).toContain('method="get"');
    expect(form).toContain('action="/scenario-d"');
  });
});

describe("indicators and the conversion formulas", () => {
  it("shows the six indicators with the hand-checked values", async () => {
    synthetic();
    const m = await page();
    expect(indicator(m, "ind-total")).toBe("12");
    expect(indicator(m, "ind-won")).toBe("5");
    expect(indicator(m, "ind-lost")).toBe("4");
    expect(indicator(m, "ind-open")).toBe("3");
    expect(indicator(m, "ind-count-conv")).toBe("55.6%");
    expect(indicator(m, "ind-value-conv")).toBe("55.4%");
  });
  it("shows won, lost and open values in rand", async () => {
    synthetic();
    const t = text(await page());
    expect(t).toContain("R115,000.00");
    expect(t).toContain("R92,500.00");
    expect(t).toContain("R207,500.00");
  });
  it("the synthetic data is a complete analysis: no findings", async () => {
    synthetic();
    const m = await page();
    expect(indicator(m, "completeness")).toBe("ANALYSIS COMPLETE");
    expect(rows(m, "check").every((c) => c.pass === "true")).toBe(true);
    expect(rows(m, "check").length).toBeGreaterThanOrEqual(6);
  });
});

describe("conversion by representative, customer, period and product", () => {
  it("by representative: counts, closed value and both rates", async () => {
    synthetic();
    const m = await page();
    expect(rows(m, "rep-row").map((r) => r.key)).toEqual(["Rep One", "Rep Three", "Rep Two"]);
    expect(keyed(m, "rep-row", "Rep One")).toMatchObject({ won: "2", lost: "1", open: "1", closed: "3", "closed-cents": "6000000", "count-pct": "66.67", "value-pct": "45.83" });
    expect(keyed(m, "rep-row", "Rep Two")).toMatchObject({ won: "1", lost: "3", open: "0", "count-pct": "25.00", "value-pct": "36.84" });
    expect(keyed(m, "rep-row", "Rep Three")).toMatchObject({ won: "2", lost: "0", open: "2", "count-pct": "100.00", "value-pct": "100.00" });
  });
  it("by customer", async () => {
    synthetic();
    const m = await page();
    expect(rows(m, "customer-row")).toHaveLength(5);
    expect(keyed(m, "customer-row", "SYN Customer 1")).toMatchObject({ quotes: "3", won: "3", lost: "0", "count-pct": "100.00" });
  });
  it("by period (month), and quarter on request", async () => {
    synthetic();
    const m = await page();
    expect(rows(m, "period-row").map((r) => r.key)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"]);
    expect(keyed(m, "period-row", "2026-01")).toMatchObject({ won: "1", lost: "1", "count-pct": "50.00", "value-pct": "23.53" });
    expect(keyed(m, "period-row", "2026-03")).toMatchObject({ won: "0", lost: "0", open: "2", "count-pct": "", "value-pct": "" });
    const q = await page({ grain: "quarter" });
    expect(rows(q, "period-row").map((r) => r.key)).toEqual(["2026-Q1", "2026-Q2", "2026-Q3"]);
    expect(keyed(q, "period-row", "2026-Q1")).toMatchObject({ quotes: "6" });
    expect(text(q)).toContain("Quote date");
  });
  it("by product, when quotes carry one, with value only for single-product quotes", async () => {
    synthetic();
    const m = await page();
    const p = rows(m, "product-row");
    expect(p.length).toBeGreaterThan(0);
    expect(p.reduce((a, r) => a + Number(r.quotes), 0)).toBe(12);
    expect(text(m)).toMatch(/multi-product quote is withheld, not split/i);
  });
  it("N/A, never 0%, where a group has no closed quotes", async () => {
    synthetic();
    const m = await page({ from: "2026-03-01", to: "2026-03-31" });
    expect(indicator(m, "ind-total")).toBe("2");
    expect(indicator(m, "ind-count-conv")).toBe("N/A");
    expect(indicator(m, "ind-value-conv")).toBe("N/A");
  });
});

describe("win/loss by reason and the quote detail", () => {
  it("lists lost reasons by count and value", async () => {
    synthetic();
    const m = await page();
    const r = rows(m, "reason-row");
    expect(r.map((x) => `${x.key}:${x.count}:${x["value-cents"]}`)).toEqual(["lead time:2:4500000", "competitor:1:2000000", "price:1:2750000"]);
    expect(text(m)).toContain("Lead time");
  });
  it("shows every quote with reference, customer, representative, date, status, value, reason and the ORIGINAL sales order", async () => {
    synthetic();
    const m = await page();
    const q = rows(m, "quote-row");
    expect(q).toHaveLength(12);
    expect(q.find((x) => x.ref === "Q-SYN-001")).toMatchObject({ status: "WON", order: "SO-SYN-0001" });
    expect(q.find((x) => x.ref === "Q-SYN-002")).toMatchObject({ status: "LOST", reason: "Lead time", order: "" });
    expect(q.find((x) => x.ref === "Q-SYN-003")).toMatchObject({ status: "OPEN" });
    const t = text(m);
    for (const h of ["Quote reference", "Customer", "Sales representative", "Quote date", "Status", "Quote value", "Lost reason", "Converted sales order"]) expect(t).toContain(h);
  });
});

describe("interactive controls", () => {
  it("representative filter narrows every table and the indicators", async () => {
    synthetic();
    const m = await page({ rep: "Rep Two" });
    expect(indicator(m, "ind-total")).toBe("4");
    expect(indicator(m, "ind-count-conv")).toBe("25.0%");
    expect(rows(m, "rep-row").map((r) => r.key)).toEqual(["Rep Two"]);
    expect(rows(m, "quote-row")).toHaveLength(4);
  });
  it("customer filter", async () => {
    synthetic();
    const m = await page({ customer: "SYN Customer 1" });
    expect(indicator(m, "ind-total")).toBe("3");
    expect(indicator(m, "ind-count-conv")).toBe("100.0%");
  });
  it("period filter is inclusive and names the date used", async () => {
    synthetic();
    const m = await page({ from: "2026-04-15", to: "2026-06-15" });
    expect(indicator(m, "ind-total")).toBe("3"); // 15 Apr, 15 May, 15 Jun
    expect(indicator(m, "ind-count-conv")).toBe("66.7%");
    const m2 = await page({ from: "2026-04-16", to: "2026-06-14" });
    expect(indicator(m2, "ind-total")).toBe("1");
    expect(text(m)).toContain("Quote date");
  });
  it("status filter narrows the quote list only; conversion keeps both won and lost", async () => {
    synthetic();
    const m = await page({ status: "WON" });
    expect(rows(m, "quote-row")).toHaveLength(5);
    expect(rows(m, "quote-row").every((r) => r.status === "WON")).toBe(true);
    expect(indicator(m, "ind-total")).toBe("12");
    expect(indicator(m, "ind-count-conv")).toBe("55.6%");
    expect(text(m)).toMatch(/status filter applies to the quote list only/i);
  });
  it("product filter selects quotes featuring the product", async () => {
    synthetic();
    const all = await page();
    const first = rows(all, "product-row")[0];
    const m = await page({ product: first.key });
    expect(indicator(m, "ind-total")).toBe(first.quotes);
  });
  it("count / value comparison switches the chart measure and keeps the tables", async () => {
    synthetic();
    const c = await page({ compare: "count" });
    const v = await page({ compare: "value" });
    expect(rows(c, "conv-bar").find((b) => b.key === "Rep One")?.pct).toBe("66.67");
    expect(rows(v, "conv-bar").find((b) => b.key === "Rep One")?.pct).toBe("45.83");
    expect(text(c)).toContain("by count");
    expect(text(v)).toContain("by value");
  });
  it("controls list the loaded representatives, customers and products", async () => {
    synthetic();
    const m = await page();
    const tag = (t: string, name: string) => new RegExp(`<${t}[^>]*name="${name}"[^>]*>`).test(m);
    for (const n of ["rep", "customer", "product", "status", "grain", "compare"]) expect(tag("select", n), n).toBe(true);
    expect(m).toContain('value="Rep One"');
    expect(m).toContain('value="SYN Customer 1"');
    expect(/<input[^>]*name="from"[^>]*>/.exec(m)?.[0]).toContain('type="date"');
    expect(/<input[^>]*name="to"[^>]*>/.exec(m)?.[0]).toContain('type="date"');
  });
  it("invalid settings are reported and defaulted, and the invalid text is not echoed", async () => {
    synthetic();
    const m = await page({ from: "9999-99-99<b>", grain: "week", rep: "Nobody At All" });
    const t = text(m);
    expect(rows(m, "settings-error").length).toBeGreaterThanOrEqual(3);
    expect(m).not.toContain("9999-99-99");
    expect(m).not.toContain("Nobody At All");
    expect(indicator(m, "ind-total")).toBe("12");
    expect(t).toMatch(/not in the loaded data/i);
  });
});

describe("incomplete data is exposed, never repaired", () => {
  async function withWorkbook(mutate: Parameters<typeof synthBuffer>[1], name: string) {
    const file = join(tmp, name);
    writeFileSync(file, await synthBuffer({}, mutate));
    vi.stubEnv("RWTSA_SOURCE", "");
    vi.stubEnv("RWTSA_WORKBOOK_PATH", file);
  }
  it("a LOST quote with no reason: NOT READY, ANALYSIS INCOMPLETE, a visible finding, no default reason", async () => {
    await withWorkbook((wb) => {
      const ws = sheet(wb, "Quotes");
      ws.getRow(3).getCell(colOf(ws, "Lost reason")).value = null; // Q-SYN-002 (lost)
    }, "no-reason.xlsx");
    const m = await page();
    const t = text(m);
    expect(t).toContain("LOCAL WORKBOOK");
    expect(t).toContain("NOT READY");
    expect(indicator(m, "completeness")).toBe("ANALYSIS INCOMPLETE");
    expect(t).toMatch(/1 LOST quote\(s\) have no reason/);
    expect(rows(m, "finding-row").find((f) => f.code === "lost_reason_missing")?.refs).toBe("Q-SYN-002");
    expect(rows(m, "reason-row").reduce((a, r) => a + Number(r.count), 0)).toBe(3);
    expect(t).toContain("Reason missing");
    expect(indicator(m, "ind-lost")).toBe("4");
  });
  it("a WON quote with no sales order is shown as an incomplete conversion record, with no order number invented", async () => {
    await withWorkbook((wb) => {
      const ws = sheet(wb, "Quotes");
      ws.getRow(2).getCell(colOf(ws, "Converted order")).value = null; // Q-SYN-001 (won)
    }, "no-so.xlsx");
    const m = await page();
    expect(indicator(m, "completeness")).toBe("ANALYSIS INCOMPLETE");
    expect(rows(m, "quote-row").find((x) => x.ref === "Q-SYN-001")).toMatchObject({ status: "WON", order: "" });
    expect(text(m)).toContain("No sales order recorded");
  });
  it("an unrecognised status is UNCLASSIFIED, reported, shown, and excluded from the rates", async () => {
    await withWorkbook((wb) => {
      const ws = sheet(wb, "Quotes");
      ws.getRow(4).getCell(colOf(ws, "Status")).value = "Awaiting board"; // Q-SYN-003 (open)
    }, "odd-status.xlsx");
    const m = await page();
    expect(indicator(m, "ind-open")).toBe("2");
    expect(indicator(m, "ind-count-conv")).toBe("55.6%");
    expect(rows(m, "quote-row").find((x) => x.ref === "Q-SYN-003")).toMatchObject({ status: "UNCLASSIFIED" });
    expect(text(m)).toContain("Awaiting board");
    expect(text(m)).toMatch(/not recognised/i);
    expect(indicator(m, "completeness")).toBe("ANALYSIS INCOMPLETE");
  });
  it("without a product column, product analysis is withheld and says why", async () => {
    await withWorkbook((wb) => {
      const ws = sheet(wb, "Quotes");
      for (let r = 2; r <= ws.rowCount; r++) ws.getRow(r).getCell(colOf(ws, "Product")).value = null;
    }, "no-product.xlsx");
    const m = await page();
    expect(rows(m, "product-row")).toHaveLength(0);
    expect(text(m)).toMatch(/no quote carries a product reference/i);
    expect(/<select[^>]*name="product"/.test(m)).toBe(false);
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
    expect(rows(m, "quote-row")).toHaveLength(0);
  });
  it("no source configured: NO DATA, nothing substituted", async () => {
    vi.stubEnv("RWTSA_SOURCE", "");
    vi.stubEnv("RWTSA_WORKBOOK_PATH", "");
    const m = await page();
    expect(text(m)).toContain("NO DATA");
    expect(text(m)).toContain("ENGINE UNAVAILABLE");
    expect(m).not.toContain('data-testid="indicators"');
  });
  it("never shows the workbook path or file name (the quotes themselves are the only workbook text shown)", async () => {
    await withWorkbook(() => undefined, "SENTINEL_FILE_NAME_D.xlsx");
    const m = await page();
    expect(m).not.toContain("SENTINEL_FILE_NAME_D");
    expect(m).not.toContain(tmp);
    expect(m).not.toContain("rwtsa-scenario-d-");
  });
  it("a local workbook with every column present passes structure and is labelled units-unverified, not verified", async () => {
    await withWorkbook(() => undefined, "ok.xlsx");
    const t = text(await page());
    expect(t).toContain("LOCAL WORKBOOK");
    expect(t).toContain("STRUCTURE VALIDATED, UNITS AND SCALE UNVERIFIED");
  });
});
