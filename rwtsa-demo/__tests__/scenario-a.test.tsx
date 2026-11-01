import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { colOf, sheet, synthBuffer } from "@/rwtsa-demo/__tests__/helpers";
import ScenarioAPage from "../app/scenario-a/page";
import { POST } from "../app/api/exclusions/route";
import { safeReturnTo } from "../lib/exclusion-route";

/**
 * Scenario A: the real page module and the real exclusion route, in-process, on SYNTHETIC data. These are the UI
 * interaction tests: controls (as a GET form), the summary indicators, the table, the chart, and the exclude / reverse
 * round trip through the route and the local state file.
 */

let tmp: string;
let stateDir: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "rwtsa-scenario-a-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

function synthetic() {
  vi.stubEnv("RWTSA_SOURCE", "synthetic");
  vi.stubEnv("RWTSA_WORKBOOK_PATH", "");
  stateDir = mkdtempSync(join(tmp, "state-"));
  vi.stubEnv("RWTSA_STATE_DIR", stateDir);
}
const page = async (q: Record<string, string> = {}) => renderToStaticMarkup(await ScenarioAPage({ searchParams: Promise.resolve(q) }));
const decode = (t: string) => t.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = (m: string) => decode(m.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
const indicator = (m: string, id: string) => {
  const r = new RegExp(`data-testid="${id}"[^>]*>([^<]*)<`).exec(m);
  return r ? decode(r[1]).trim() : null;
};
const rowKeys = (m: string) => [...m.matchAll(/data-testid="row-key" data-key="([^"]*)"/g)].map((x) => x[1]);
const chartPoints = (m: string) => {
  const r = /data-testid="chart-line" data-points="([^"]*)"/.exec(m);
  return r ? r[1].split(" ").map((p) => Number(p.split(":")[1])) : [];
};
const SELF = "http://127.0.0.1:3100";
function post(fields: [string, string][], headers: Record<string, string> = { host: "127.0.0.1:3100", origin: SELF }) {
  const body = new URLSearchParams();
  for (const [k, v] of fields) body.append(k, v);
  return POST(new Request(`${SELF}/api/exclusions`, { method: "POST", headers, body }));
}

describe("controls and layout", () => {
  it("offers every required control as a plain GET form (no script)", async () => {
    synthetic();
    const m = await page();
    expect(m).toContain('data-testid="controls"');
    for (const name of ["view", "window", "horizon", "anchor", "overdue", "curve", "mult", "floor", "style", "only"]) expect(m, name).toContain(`name="${name}"`);
    expect(m).toContain("<option value=\"13\"");
    expect(m).toContain("<option value=\"26\"");
    expect(m).not.toContain("<script");
    expect(m).not.toMatch(/https?:\/\//i);
  });
  it("shows provenance, structure, readiness, engine and the forecast basis as separate facts", async () => {
    synthetic();
    const m = await page();
    expect(text(m)).toContain("SYNTHETIC");
    expect(text(m)).toContain("STRUCTURE PASS");
    expect(text(m)).toContain("READY");
    expect(text(m)).toContain("ENGINE AVAILABLE");
    expect(text(m)).toContain("FORECAST BASIS: ASSUMED (history ends before the stock date)");
  });
  it("makes the history gap and the overdue-shipment assumption visible", async () => {
    synthetic();
    const m = text(await page());
    expect(m).toContain("Sales history ends in 2026-08, but stock is dated 2026-10-31");
    expect(m).toContain("2026-09, 2026-10");
    expect(m).toContain("NOT invented");
    expect(m).toContain("assumed to arrive in week 1");
    expect(m).toContain("not an authorised purchase order");
  });
});

describe("indicators, table and chart", () => {
  it("shows the five required indicators", async () => {
    synthetic();
    const m = await page();
    for (const id of ["ind-shortage", "ind-first", "ind-shortfall", "ind-anomalies", "ind-tender"]) expect(indicator(m, id), id).not.toBeNull();
    expect(indicator(m, "ind-anomalies")).toBe("8");
    expect(indicator(m, "ind-tender")).toBe("1");
    expect(indicator(m, "ind-first")).toMatch(/^Week \d+$/);
    expect(indicator(m, "ind-shortfall")).toMatch(/units$/);
  });
  it("shows the eleven required columns", async () => {
    synthetic();
    const t = text(await page());
    for (const c of ["SKU", "Style", "Size", "Available", "Inbound", "Weekly forecast", "First breach", "Shortfall", "Months of cover", "Anomaly", "Proposed order"]) expect(t, c).toContain(c);
  });
  it("lists all 24 SKUs, then 3 styles in the style view, and the proposed totals reconcile", async () => {
    synthetic();
    expect(rowKeys(await page())).toHaveLength(24);
    const style = await page({ view: "style" });
    expect(rowKeys(style)).toEqual(["SYN-VEST-A", "SYN-VEST-B", "SYN-VEST-TT"]);
    expect(text(style)).toContain("Results by style");
  });
  it("filters by style and by shortage status", async () => {
    synthetic();
    expect(rowKeys(await page({ style: "SYN-VEST-TT" }))).toHaveLength(8);
    const short = rowKeys(await page({ only: "shortage" }));
    expect(short.length).toBeGreaterThan(0);
    expect(short.length).toBeLessThan(24);
    expect(short).not.toContain("SYN-VEST-TT-5XL"); // the tender SKU is never a shortage
    const spikeStyle = rowKeys(await page({ style: "SYN-VEST-B", only: "shortage", view: "sku" }));
    expect(spikeStyle.length).toBeGreaterThan(0);
    expect(spikeStyle.every((k) => k.startsWith("SYN-VEST-B-"))).toBe(true);
  });
  it("labels the tender SKU as excluded from automatic ordering", async () => {
    synthetic();
    const m = text(await page({ style: "SYN-VEST-TT" }));
    expect(m).toContain("TENDER: NOT AUTO-ORDERED");
    expect(m).toContain("0 (tender)");
  });
  it("the chart draws 14 points (opening + 13 weeks), or 27 for 26 weeks, with the minimum line", async () => {
    synthetic();
    const a = await page({ sel: "SYN-VEST-A-M" });
    expect(chartPoints(a)).toHaveLength(14);
    expect(a).toContain('data-testid="chart-min"');
    const b = await page({ sel: "SYN-VEST-A-M", horizon: "26" });
    expect(chartPoints(b)).toHaveLength(27);
    expect(text(b)).toContain("Week from stock date");
  });
  it("the chart follows the selection and marks the first breach", async () => {
    synthetic();
    const m = await page({ sel: "SYN-VEST-B-M" });
    expect(text(m)).toContain("SYN-VEST-B-M (SYN-VEST-B, M)");
    expect(m).toContain('data-testid="chart-breach"');
    const ok = await page({ sel: "SYN-VEST-TT-5XL" });
    expect(text(ok)).toContain("SYN-VEST-TT-5XL");
  });
  it("the style chart is the sum of its SKUs", async () => {
    synthetic();
    const sku = (k: string) => chartPoints(k);
    const st = chartPoints(await page({ view: "style", sel: "SYN-VEST-A" }));
    let sums: number[] = [];
    for (const size of ["S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"]) {
      const p = sku(await page({ sel: `SYN-VEST-A-${size}` }));
      sums = sums.length ? sums.map((v, i) => v + p[i]) : p;
    }
    st.forEach((v, i) => expect(v).toBeCloseTo(sums[i], 0));
  });
  it("horizon, window and history anchor change the results", async () => {
    synthetic();
    const base = indicator(await page(), "ind-shortfall");
    expect(indicator(await page({ horizon: "26" }), "ind-shortfall")).not.toBe(base);
    expect(indicator(await page({ window: "3" }), "ind-shortfall")).not.toBe(base);
    const strict = await page({ anchor: "strict" });
    expect(text(strict)).toContain("FORECAST BASIS: LIMITED");
    expect(indicator(strict, "ind-shortage")).toBe("0");
    expect(text(strict)).toContain("no forecast");
  });
  it("the overdue-shipment assumption is switchable and the change is visible", async () => {
    synthetic();
    const on = text(await page());
    const off = text(await page({ overdue: "exclude" }));
    expect(on).toContain("assumed to arrive in week 1");
    expect(off).toContain("Overdue shipments still marked on the water are excluded");
  });
  it("invalid controls are reported and replaced by defaults without echoing the input", async () => {
    synthetic();
    const m = await page({ horizon: "14", window: "99", view: "<img src=x>" });
    expect(m).toContain('data-testid="settings-errors"');
    expect(m).not.toContain("<img src=x>");
    expect(chartPoints(m)).toHaveLength(14);
  });
  it("anomaly thresholds are controls: raising the multiple clears the flags", async () => {
    synthetic();
    expect(indicator(await page({ mult: "50" }), "ind-anomalies")).toBe("0");
  });
});

describe("exclusion round trip", () => {
  const flaggedSkus = ["S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"].map((s) => `SYN-VEST-B-${s}`);
  const month = "2026-06";

  it("requires a reason in the form, flags the spike rows, and offers a bulk action", async () => {
    synthetic();
    const m = await page();
    expect((m.match(/data-testid="anomaly"/g) ?? []).length).toBe(8);
    const reasonInputs = m.match(/<input[^>]*name="reason"[^>]*>/g) ?? [];
    expect(reasonInputs.length).toBeGreaterThanOrEqual(9); // 8 rows + 1 bulk form
    expect(reasonInputs.every((t) => /required/.test(t))).toBe(true);
    expect(m).toContain('data-testid="bulk-exclude"');
    expect(text(m)).toContain("Exclude all 8");
  });

  it("excluding with a reason removes the false stock-outs; reversing restores them", async () => {
    synthetic();
    const before = await page();
    const shortBefore = Number(indicator(before, "ind-shortage"));
    expect(shortBefore).toBeGreaterThan(0);

    const res = await post([["action", "exclude"], ["month", month], ["reason", "One-off tender order"], ["returnTo", "/scenario-a?view=sku&horizon=13"], ...flaggedSkus.map((s): [string, string] => ["sku", s])]);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/scenario-a?view=sku&horizon=13&done=excluded");
    expect(readdirSync(stateDir)).toHaveLength(1);

    const after = await page({ done: "excluded" });
    expect(text(after)).toContain("Month excluded from the demand forecast");
    expect(indicator(after, "ind-anomalies")).toBe("0");
    expect(Number(indicator(after, "ind-shortage"))).toBeLessThan(shortBefore);
    expect(text(after)).toContain("EXCLUDED: One-off tender order");
    expect(after).toContain("Reverse exclusion");

    const rev = await post([["action", "reverse"], ["month", month], ["returnTo", "/scenario-a"], ...flaggedSkus.map((s): [string, string] => ["sku", s])]);
    expect(rev.headers.get("location")).toBe("/scenario-a?done=reversed");
    const restored = await page({ done: "reversed" });
    expect(indicator(restored, "ind-anomalies")).toBe("8");
    expect(indicator(restored, "ind-shortage")).toBe(String(shortBefore));
    expect(indicator(restored, "ind-shortfall")).toBe(indicator(before, "ind-shortfall"));
  });

  it("an exclusion stays visible and reversible after the thresholds change so the month is no longer flagged", async () => {
    synthetic();
    await post([["action", "exclude"], ["month", month], ["reason", "Tender"], ["returnTo", "/scenario-a"], ...flaggedSkus.map((s): [string, string] => ["sku", s])]);
    const hidden = await page({ mult: "500" });
    expect(indicator(hidden, "ind-anomalies")).toBe("0");
    expect(hidden).toContain('data-testid="saved-exclusions"');
    expect((hidden.match(/data-testid="saved-exclusion"/g) ?? []).length).toBe(8);
    expect(text(hidden)).toContain("Reverse");
    await post([["action", "reverse"], ["month", month], ["returnTo", "/scenario-a"], ...flaggedSkus.map((s): [string, string] => ["sku", s])]);
    expect(await page({ mult: "500" })).not.toContain('data-testid="saved-exclusions"');
  });

  it("a missing reason changes nothing", async () => {
    synthetic();
    const res = await post([["action", "exclude"], ["month", month], ["reason", "   "], ["returnTo", "/scenario-a"], ["sku", flaggedSkus[0]]]);
    expect(res.headers.get("location")).toBe("/scenario-a?done=reason");
    expect(readdirSync(stateDir)).toHaveLength(0);
    expect(text(await page({ done: "reason" }))).toContain("A reason is required");
    expect(indicator(await page(), "ind-anomalies")).toBe("8");
  });

  it("unknown SKUs/months and malformed requests change nothing", async () => {
    synthetic();
    expect((await post([["action", "exclude"], ["month", month], ["reason", "r"], ["sku", "NOPE"]])).headers.get("location")).toBe("/scenario-a?done=unknown");
    expect((await post([["action", "wipe"], ["month", month], ["reason", "r"], ["sku", flaggedSkus[0]]])).headers.get("location")).toBe("/scenario-a?done=invalid");
    expect(readdirSync(stateDir)).toHaveLength(0);
  });

  it("refuses any Host that is not loopback (DNS rebinding), even with a matching Origin", async () => {
    synthetic();
    const fields: [string, string][] = [["action", "exclude"], ["month", month], ["reason", "r"], ["sku", flaggedSkus[0]]];
    for (const host of ["evil.example", "evil.example:3100", "127.0.0.1.evil.example", "10.0.0.5:3100"]) {
      const origin = ["http:", "//" + host].join("");
      expect((await post(fields, { host, origin })).status, host).toBe(403);
    }
    expect(readdirSync(stateDir)).toHaveLength(0);
    for (const host of ["127.0.0.1:3100", "localhost:3100", "[::1]:3100"]) expect((await post(fields, { host, origin: ["http:", "//" + host].join("") })).status, host).toBe(303);
  });

  it("refuses cross-origin and header-less posts, and writes nothing", async () => {
    synthetic();
    const fields: [string, string][] = [["action", "exclude"], ["month", month], ["reason", "r"], ["sku", flaggedSkus[0]]];
    expect((await post(fields, { host: "127.0.0.1:3100", origin: ["http:", "//evil.example"].join("") })).status).toBe(403);
    expect((await post(fields, { host: "127.0.0.1:3100" })).status).toBe(403);
    expect((await post(fields, { host: "127.0.0.1:3100", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post(fields, { host: "127.0.0.1:3100", "sec-fetch-site": "same-origin" })).status).toBe(303);
    expect(readdirSync(stateDir)).toHaveLength(1);
  });

  it("only ever redirects back to this app's Scenario A page", () => {
    for (const bad of ["//evil.example/x", ["https:", "//evil.example"].join(""), "/other", "/scenario-abc", "/scenario-a\\..", "/scenario-a\r\nSet-Cookie: x=1", null, "/scenario-a?" + "x".repeat(700)]) expect(safeReturnTo(bad), String(bad)).toBe("/scenario-a");
    expect(safeReturnTo("/scenario-a?view=style")).toBe("/scenario-a?view=style");
  });

  it("with no data loaded the route changes nothing", async () => {
    vi.stubEnv("RWTSA_SOURCE", "");
    vi.stubEnv("RWTSA_WORKBOOK_PATH", "");
    stateDir = mkdtempSync(join(tmp, "state-"));
    vi.stubEnv("RWTSA_STATE_DIR", stateDir);
    const res = await post([["action", "exclude"], ["month", month], ["reason", "r"], ["sku", flaggedSkus[0]]]);
    expect(res.headers.get("location")).toBe("/scenario-a?done=invalid");
    expect(readdirSync(stateDir)).toHaveLength(0);
  });

  it("saved exclusions live only in the local state directory, never in the repository or the temp root", async () => {
    synthetic();
    await post([["action", "exclude"], ["month", month], ["reason", "Tender"], ["sku", flaggedSkus[0]]]);
    const files = readdirSync(stateDir);
    expect(files).toHaveLength(1);
    const body = JSON.parse(readFileSync(join(stateDir, files[0]), "utf8"));
    expect(body.exclusions).toHaveLength(1);
    expect(existsSync(join(process.cwd(), "rwtsa-demo", ".rwtsa-demo"))).toBe(false);
  });

  it("a corrupt exclusions file is reported on the page and nothing is applied silently", async () => {
    synthetic();
    await post([["action", "exclude"], ["month", month], ["reason", "Tender"], ["sku", flaggedSkus[0]]]);
    const f = join(stateDir, readdirSync(stateDir)[0]);
    writeFileSync(f, "{broken");
    const m = await page();
    expect(text(m)).toContain("unreadable or corrupt");
    expect(text(m)).toContain("ENGINE UNAVAILABLE");
    expect(indicator(m, "ind-anomalies")).toBeNull(); // no figures are shown while the exclusions cannot be read
  });
});

describe("a workbook whose inputs are not ready", () => {
  it("still runs the engine but says plainly that the data is NOT READY and why", async () => {
    const file = join(tmp, "no-min.xlsx");
    writeFileSync(
      file,
      await synthBuffer({}, (wb) => {
        const ws = sheet(wb, "Items");
        for (let row = 2; row <= ws.rowCount; row++) ws.getRow(row).getCell(colOf(ws, "Min level")).value = null;
      })
    );
    vi.stubEnv("RWTSA_SOURCE", "");
    vi.stubEnv("RWTSA_WORKBOOK_PATH", file);
    vi.stubEnv("RWTSA_STATE_DIR", join(tmp, "state-nr"));
    const m = await page();
    const t = text(m);
    expect(t).toContain("LOCAL WORKBOOK");
    expect(t).toContain("NOT READY");
    expect(t).toContain("ENGINE AVAILABLE");
    expect(t).toContain("does not make the data ready");
    expect(t).toContain("Items.minLevel");
    expect(t).toContain("no minimum level");
    expect(indicator(m, "ind-shortage")).toBe("0"); // nothing can be evaluated without minimum levels, and that is said
    expect(t).not.toContain("SYNTHETIC TEST DATA");
    expect(t).not.toContain("Supplied (synthetic)"); // a local workbook has no supplied size curve
  });

  it("an unusable workbook has no engine and no rows, and synthetic data is not substituted", async () => {
    vi.stubEnv("RWTSA_SOURCE", "");
    vi.stubEnv("RWTSA_WORKBOOK_PATH", join(tmp, "missing.xlsx"));
    vi.stubEnv("RWTSA_STATE_DIR", join(tmp, "state-x"));
    const m = await page();
    expect(text(m)).toContain("ENGINE UNAVAILABLE");
    expect(text(m)).toContain("NOT READY");
    expect(rowKeys(m)).toEqual([]);
    expect(text(m)).not.toContain("SYNTHETIC");
    expect(m).not.toContain('data-testid="chart"');
  });
});
