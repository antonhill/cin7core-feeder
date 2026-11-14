import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { originalShapedBuffer } from "@/rwtsa-demo/fixtures/original-shaped";
import ScenarioAPage from "../app/scenario-a/page";
import { POST } from "../app/api/planner/route";

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


const SELF = "http://127.0.0.1:3100";
const stateDirOf = () => join(tmp, "state");
const plannerFiles = () => (existsSync(stateDirOf()) ? readdirSync(stateDirOf()).filter((f) => f.startsWith("planner-")) : []);
function post(fields: [string, string][], headers: Record<string, string> = { host: "127.0.0.1:3100", origin: SELF }) {
  const body = new URLSearchParams();
  for (const [k, v] of fields) body.append(k, v);
  return POST(new Request(`${SELF}/api/planner`, { method: "POST", headers, body }));
}
const act = async (sku: string, action: string, extra: [string, string][] = []) => {
  const res = await post([["action", action], ["sku", sku], ["returnTo", "/scenario-a?view=sku"], ...extra]);
  expect(res.status).toBe(303);
  return /done=([a-z-]+)/.exec(res.headers.get("location") ?? "")?.[1] ?? null;
};
const skus = (m: string) => [...m.matchAll(/data-testid="row-key" data-key="([^"]*)"/g)].map((x) => x[1]);
const sel = (sku: string, q: Record<string, string> = {}) => A({ view: "sku", sel: sku, ...q });
const attr = (m: string, id: string) => /data-value="([^"]*)"/.exec(new RegExp(`data-testid="${id}"[^>]*`).exec(m)?.[0] ?? "")?.[1] ?? null;
const cellStates = (m: string) => [...m.matchAll(/data-testid="proposed-cell" data-state="([^"]*)"/g)].map((x) => x[1]);

beforeEach(() => rmSync(stateDirOf(), { recursive: true, force: true }));

describe("labelling: projected shortfall is a risk, not a purchase recommendation", () => {
  it("renames the column, explains it, and keeps proposed orders separately labelled", async () => {
    local();
    const m = await A({ view: "sku" });
    expect(text(m)).toContain("Projected inventory shortfall");
    expect(text(m)).toContain("This is a forecast inventory risk, not a purchase order recommendation.");
    expect(text(m)).toContain("Proposed order (calculated)");
    expect(text(m)).not.toMatch(/<th[^>]*>Shortfall</);
  });
});

describe("DP-16: planner-controlled tender classification", () => {
  it("starts unclassified with no source, and withholds only those proposals", async () => {
    local();
    const m = await sel("SYN-VEST-A-M");
    expect(text(m)).toContain("UNCLASSIFIED");
    expect(text(m)).toContain("no source: neither the workbook nor the planner has classified it");
    expect(new Set(cellStates(m))).toEqual(new Set(["withheld"]));
  });
  it("classifying one SKU releases only that SKU's proposal and records who established it", async () => {
    local();
    expect(await act("SYN-VEST-A-M", "classify", [["value", "ordinary"], ["note", "Standing line"]])).toBe("classified");
    const m = await sel("SYN-VEST-A-M");
    expect(text(m)).toContain("ORDINARY REPLENISHMENT");
    expect(text(m)).toContain("Source: set by the planner on this page. Note: Standing line.");
    const states = Object.fromEntries(skus(m).map((k, i) => [k, cellStates(m)[i]]));
    expect(states["SYN-VEST-A-M"]).toBe("value");
    expect(Object.entries(states).filter(([k]) => k !== "SYN-VEST-A-M").every(([, v]) => v === "withheld")).toBe(true);
    expect(text(m)).toMatch(/withheld for 9 unclassified SKU\(s\)/);
  });
  it("a tender SKU keeps its demand and projected shortfall, shows no proposal, and says why", async () => {
    local();
    await act("SYN-VEST-A-M", "classify", [["value", "tender"]]);
    const m = await sel("SYN-VEST-A-M");
    expect(text(m)).toContain("TENDER / CUSTOMER-ORDER-ONLY");
    expect(text(m)).toContain("No standing replenishment proposal and no standing minimum");
    expect(text(m)).toContain("0 (tender)");
    expect(m).toContain('data-testid="override-ineligible"');
  });
  it("is reversible: clearing returns the SKU to unclassified", async () => {
    local();
    await act("SYN-VEST-A-M", "classify", [["value", "ordinary"]]);
    expect(await act("SYN-VEST-A-M", "classify", [["value", "clear"]])).toBe("classification-cleared");
    expect(text(await sel("SYN-VEST-A-M"))).toContain("UNCLASSIFIED");
  });
  it("classifying every SKU closes the rule; the overdue and history decisions remain", async () => {
    local();
    for (const k of skus(await A({ view: "sku" }))) await act(k, "classify", [["value", "ordinary"]]);
    const m = await A({ view: "sku" });
    expect(ruleIds(m)).not.toContain("tender-classification");
    expect(new Set(cellStates(m))).toEqual(new Set(["value"]));
  });
});

describe("DP-19: temporary minimum override through the page", () => {
  const SKU = "SYN-VEST-A-M";
  const setMin = (extra: [string, string][]) => act(SKU, "min-set", extra);
  it("requires a reason, a real effective date, and exactly one of an expiry or 'until removed'", async () => {
    local();
    expect(await setMin([["replacement", "500"], ["effectiveFrom", "2026-10-31"], ["untilRemoved", "1"]])).toBe("planner-reason");
    expect(await setMin([["replacement", "500"], ["effectiveFrom", "31/10/2026"], ["untilRemoved", "1"], ["reason", "x"]])).toBe("planner-invalid");
    expect(await setMin([["replacement", "500"], ["effectiveFrom", "2026-10-31"], ["reason", "x"]])).toBe("planner-invalid"); // neither expiry nor until-removed
    expect(await setMin([["replacement", "500"], ["effectiveFrom", "2026-10-31"], ["expires", "2026-12-01"], ["untilRemoved", "1"], ["reason", "x"]])).toBe("planner-invalid"); // both
    expect(await setMin([["replacement", "500"], ["effectiveFrom", "2026-10-31"], ["expires", "2026-10-01"], ["reason", "x"]])).toBe("planner-invalid"); // expires before start
    expect(await setMin([["replacement", "-5"], ["effectiveFrom", "2026-10-31"], ["untilRemoved", "1"], ["reason", "x"]])).toBe("planner-invalid");
    expect(plannerFiles()).toEqual([]);
  });
  it("shows original and effective side by side, recalculates the shortfall, and never touches the original", async () => {
    local();
    const before = await sel(SKU);
    const origBefore = attr(before, "min-original");
    const shortBefore = Number(indicator(before, "ind-shortfall")?.replace(/[^0-9.]/g, ""));
    expect(await setMin([["replacement", "100000"], ["effectiveFrom", "2026-10-31"], ["expires", "2027-03-01"], ["reason", "Large project"]])).toBe("min-set");
    const after = await sel(SKU);
    expect(attr(after, "min-original")).toBe(origBefore);
    expect(attr(after, "min-effective")).toBe("100000");
    expect(text(after)).toMatch(/Temporary minimum 100,000 from 2026-10-31 to 2027-03-01; in force in 13 of 13 projection weeks. Reason: Large project/);
    expect(Number(indicator(after, "ind-shortfall")?.replace(/[^0-9.]/g, ""))).toBeGreaterThan(shortBefore);
  });
  it("is reversible: removing it restores the original result", async () => {
    local();
    const before = await sel(SKU);
    await setMin([["replacement", "100000"], ["effectiveFrom", "2026-10-31"], ["untilRemoved", "1"], ["reason", "x"]]);
    expect(await act(SKU, "min-remove")).toBe("min-removed");
    const after = await sel(SKU);
    expect(indicator(after, "ind-shortfall")).toBe(indicator(before, "ind-shortfall"));
    expect(attr(after, "min-effective")).toBe(attr(before, "min-effective"));
  });
  it("expires: an override that has already ended has no effect", async () => {
    local();
    const before = await sel(SKU);
    await setMin([["replacement", "100000"], ["effectiveFrom", "2026-01-01"], ["expires", "2026-02-01"], ["reason", "old"]]);
    const after = await sel(SKU);
    expect(indicator(after, "ind-shortfall")).toBe(indicator(before, "ind-shortfall"));
    expect(text(after)).toMatch(/in force in 0 of 13 projection weeks/);
  });
});

describe("DP-15: proposed-order override", () => {
  const SKU = "SYN-VEST-A-M";
  it("cannot be applied to an unclassified or tender SKU (no bypass of eligibility)", async () => {
    local();
    expect(await act(SKU, "override-set", [["quantity", "10"], ["reason", "x"]])).toBe("planner-not-eligible");
    await act(SKU, "classify", [["value", "tender"]]);
    expect(await act(SKU, "override-set", [["quantity", "10"], ["reason", "x"]])).toBe("planner-not-eligible");
    const saved = JSON.parse(readFileSync(join(stateDirOf(), plannerFiles()[0]), "utf8"));
    expect(saved.orderOverrides).toEqual([]);
  });
  it("needs a reason and a whole number; then shows calculated versus planner-adjusted; and is reversible", async () => {
    local();
    await act(SKU, "classify", [["value", "ordinary"]]);
    const calc = attr(await sel(SKU), "order-calculated");
    expect(calc).not.toBeNull();
    expect(await act(SKU, "override-set", [["quantity", "10"]])).toBe("planner-reason");
    expect(await act(SKU, "override-set", [["quantity", "1.5"], ["reason", "x"]])).toBe("planner-invalid");
    expect(await act(SKU, "override-set", [["quantity", "-3"], ["reason", "x"]])).toBe("planner-invalid");
    expect(await act(SKU, "override-set", [["quantity", "77"], ["reason", "Supplier MOQ"], ["calculated", calc as string]])).toBe("override-set");
    const m = await sel(SKU);
    expect(attr(m, "order-calculated")).toBe(calc);
    expect(attr(m, "order-adjusted")).toBe("77");
    expect(text(m)).toContain("Override reason: Supplier MOQ");
    expect(text(m)).toContain("Nothing here creates or authorises a purchase order");
    expect(await act(SKU, "override-reverse")).toBe("override-reversed");
    expect(text(await sel(SKU))).toContain("none: the calculated proposal stands");
  });
  it("an override stops applying if the SKU is later reclassified as tender", async () => {
    local();
    await act(SKU, "classify", [["value", "ordinary"]]);
    await act(SKU, "override-set", [["quantity", "77"], ["reason", "x"]]);
    await act(SKU, "classify", [["value", "tender"]]);
    const m = await sel(SKU);
    expect(attr(m, "order-adjusted")).toBe("0");
    expect(text(m)).not.toContain("Override reason");
  });
  it("the selected formula is labelled and drives the calculated quantity", async () => {
    local();
    await act(SKU, "classify", [["value", "ordinary"]]);
    const a = await sel(SKU);
    const n = await sel(SKU, { formula: "net-requirement" });
    expect(text(a)).toContain("Formula: minimum-shortfall demonstration formula");
    expect(text(n)).toContain("Formula: RFP DP-13 net requirement");
  });
});

describe("DP-14: local make through the page", () => {
  const SKU = "SYN-VEST-A-M";
  it("is NOT EVALUATED until data is entered, and nothing is invented", async () => {
    local();
    await act(SKU, "classify", [["value", "ordinary"]]);
    const m = await sel(SKU);
    expect(/data-testid="localmake" data-status="NOT EVALUATED"/.test(m)).toBe(true);
    expect(text(m)).toContain("none is invented");
  });
  it("entered values are EVALUATED as a labelled demonstration assumption with gross, local make and residual", async () => {
    local();
    await act(SKU, "classify", [["value", "ordinary"]]);
    expect(await act(SKU, "make-set", [["quantity", "40"], ["capacity", "40"], ["leadTime", "2"], ["completionWeek", "3"]])).toBe("make-set");
    const m = await sel(SKU);
    expect(/data-testid="localmake" data-status="EVALUATED"/.test(m)).toBe(true);
    expect(text(m)).toContain("DEMONSTRATION ASSUMPTION: entered by the planner, not a client-confirmed value");
    const n = (id: string) => Number(new RegExp(`data-testid="${id}">([0-9,]+)<`).exec(m)?.[1]?.replace(/,/g, ""));
    expect(n("make-gross") - n("make-counted")).toBe(n("make-residual"));
    expect(n("make-counted")).toBeLessThanOrEqual(40);
  });
  it("does not change Available, inbound, the projection or the shortfall (local make is not received stock)", async () => {
    local();
    await act(SKU, "classify", [["value", "ordinary"]]);
    const before = await sel(SKU);
    await act(SKU, "make-set", [["quantity", "40"], ["capacity", "40"], ["leadTime", "2"], ["completionWeek", "3"]]);
    const after = await sel(SKU);
    expect(indicator(after, "ind-shortfall")).toBe(indicator(before, "ind-shortfall"));
    expect(/data-testid="chart-line" data-points="([^"]*)"/.exec(after)?.[1]).toBe(/data-testid="chart-line" data-points="([^"]*)"/.exec(before)?.[1]);
  });
  it("rejects invalid entries; lead time later than completion is BLOCKED; removal returns to NOT EVALUATED", async () => {
    local();
    await act(SKU, "classify", [["value", "ordinary"]]);
    expect(await act(SKU, "make-set", [["quantity", "1.5"], ["capacity", "1"], ["leadTime", "1"], ["completionWeek", "2"]])).toBe("planner-invalid");
    expect(await act(SKU, "make-set", [["quantity", "10"], ["capacity", "10"], ["leadTime", "5"], ["completionWeek", "3"]])).toBe("make-set");
    expect(/data-status="BLOCKED"/.test(await sel(SKU))).toBe(true);
    expect(await act(SKU, "make-remove")).toBe("make-removed");
    expect(/data-status="NOT EVALUATED"/.test(await sel(SKU))).toBe(true);
  });
  it("is not offered for a tender or unclassified SKU", async () => {
    local();
    expect(await sel(SKU)).not.toContain("Save assumption");
  });
});

describe("safeguards", () => {
  it("refuses a cross-origin or originless POST and a forged action, and changes nothing", async () => {
    local();
    expect((await post([["action", "classify"], ["sku", "SYN-VEST-A-M"], ["value", "tender"]], { host: "127.0.0.1:3100", origin: "http://127.0.0.1:9999" })).status).toBe(403);
    expect((await post([["action", "classify"], ["sku", "SYN-VEST-A-M"], ["value", "tender"]], { host: "127.0.0.1:3100" })).status).toBe(403);
    expect(await act("SYN-VEST-A-M", "frobnicate")).toBe("planner-invalid");
    expect(await act("NO-SUCH-SKU", "classify", [["value", "tender"]])).toBe("planner-unknown");
    expect(await act("SYN-VEST-A-M", "classify", [["value", "maybe"]])).toBe("planner-invalid");
    expect(plannerFiles()).toEqual([]);
  });
  it("the redirect never leaves the Scenario A page", async () => {
    local();
    const res = await post([["action", "classify"], ["sku", "SYN-VEST-A-M"], ["value", "ordinary"], ["returnTo", "/scenario-a/../x"]]);
    expect(res.headers.get("location")).toMatch(/^\/scenario-a\?done=classified#planner$/);
  });
  it("saves decisions only in the local state directory, never the workbook, and the workbook file is untouched", async () => {
    local();
    const file = join(tmp, "orig.xlsx");
    const hash = () => createHash("sha256").update(readFileSync(file)).digest("hex");
    const before = hash();
    await act("SYN-VEST-A-M", "classify", [["value", "ordinary"]]);
    await act("SYN-VEST-A-M", "min-set", [["replacement", "5"], ["effectiveFrom", "2026-10-31"], ["untilRemoved", "1"], ["reason", "x"]]);
    await act("SYN-VEST-A-M", "override-set", [["quantity", "3"], ["reason", "x"]]);
    await act("SYN-VEST-A-M", "make-set", [["quantity", "3"], ["capacity", "3"], ["leadTime", "1"], ["completionWeek", "2"]]);
    expect(hash()).toBe(before);
    const files = readdirSync(stateDirOf());
    expect(files.filter((f) => f.startsWith("planner-"))).toHaveLength(1);
    const saved = readFileSync(join(stateDirOf(), files.find((f) => f.startsWith("planner-")) as string), "utf8");
    expect(saved).not.toContain("orig.xlsx");
    expect(saved).not.toContain(tmp);
  });
  it("a corrupt planner file shows no figures and says why (never 'no decisions')", async () => {
    local();
    await act("SYN-VEST-A-M", "classify", [["value", "ordinary"]]);
    const f = join(stateDirOf(), readdirSync(stateDirOf()).find((x) => x.startsWith("planner-")) as string);
    writeFileSync(f, "{ not json");
    const m = await A({ view: "sku" });
    expect(text(m)).toContain("saved planner decisions could not be read");
    expect(m).not.toContain('data-testid="indicators"');
  });
  it("decisions made against one data source never apply to another", async () => {
    local();
    await act("SYN-VEST-A-M", "classify", [["value", "tender"]]);
    synthetic();
    expect(text(await A({ view: "sku" }))).not.toContain("set by the planner on this page");
  });
});

describe("review hardening", () => {
  const SKU = "SYN-VEST-A-M";
  it("a forged 'calculated' value in the request is ignored", async () => {
    local();
    await act(SKU, "classify", [["value", "ordinary"]]);
    expect(await act(SKU, "override-set", [["quantity", "5"], ["reason", "x"], ["calculated", "999999"]])).toBe("override-set");
    const saved = JSON.parse(readFileSync(join(stateDirOf(), plannerFiles()[0]), "utf8"));
    expect(saved.orderOverrides[0].calculatedAtOverride).toBeNull();
    expect(text(await sel(SKU))).toMatch(/Saved \d{4}-\d{2}-\d{2}; the calculation is not re-checked/);
  });
  it("overrides show beside the calculated proposal in the table and in the planner-adjusted total", async () => {
    local();
    await act(SKU, "classify", [["value", "ordinary"]]);
    const base = Number(indicator(await sel(SKU), "ind-adjusted")?.replace(/[^0-9]/g, ""));
    await act(SKU, "override-set", [["quantity", "12345"], ["reason", "x"]]);
    const m = await sel(SKU);
    expect(/data-testid="adjusted-cell" data-value="12345"/.test(m)).toBe(true);
    expect(Number(indicator(m, "ind-adjusted")?.replace(/[^0-9]/g, ""))).not.toBe(base);
    expect(text(m)).toContain("planner-adjusted 12,345");
  });
  it("a saved override held while the SKU is not ordinary stays visible and reversible", async () => {
    local();
    await act(SKU, "classify", [["value", "ordinary"]]);
    await act(SKU, "override-set", [["quantity", "77"], ["reason", "MOQ"]]);
    await act(SKU, "classify", [["value", "tender"]]);
    const held = await sel(SKU);
    expect(held).toContain('data-testid="held-override"');
    expect(text(held)).toContain("A saved override of 77 is on hold");
    expect(await act(SKU, "override-reverse")).toBe("override-reversed");
    expect(await sel(SKU)).not.toContain('data-testid="held-override"');
  });
  it("tender stock-out risk is counted, kept under the shortage filter, and noted on the style row", async () => {
    local();
    for (const k of skus(await A({ view: "sku" }))) await act(k, "classify", [["value", "tender"]]);
    const m = await A({ view: "sku", only: "shortage" });
    expect(text(m)).toMatch(/[1-9]\d* at projected stock-out risk/);
    expect(skus(m).length).toBeGreaterThan(0); // tender SKUs at risk stay in the filtered table
    const st = await A({ view: "style", only: "shortage" });
    expect(text(st)).toMatch(/[1-9]\d* tender SKU\(s\) at projected stock-out risk/);
  });
  it("the local-make note says it is not matched to the week of the first shortage", async () => {
    local();
    await act(SKU, "classify", [["value", "ordinary"]]);
    expect(text(await sel(SKU))).toContain("local make is not matched to the week of the first shortage");
  });
});
