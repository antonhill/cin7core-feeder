import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { colOf, sheet, synthBuffer } from "@/rwtsa-demo/__tests__/helpers";
import { TAB_NAMES } from "@/rwtsa-demo/contracts/tabs";
import { DELIVERY_LAYERS, SCENARIOS } from "@/rwtsa-demo/state/layers";
import {
  isScenarioReady,
  loadDemoState,
  overviewView,
  scenarioView,
  validationView,
  type DemoState,
} from "@/rwtsa-demo/state/demo-state";

/**
 * The shell's state rules. READY comes ONLY from the validator's per-scenario flags; STRUCTURE PASS is never readiness;
 * synthetic data is only ever an explicit choice and never a fallback; every view is value-free.
 */

const S = "SENTINEL_STATE_41C9";
const IDS = ["A", "B", "C", "D"] as const;
let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "rwtsa-state-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function workbookFile(name: string, mutate?: (wb: ExcelJS.Workbook) => void): Promise<string> {
  const f = join(tmp, name);
  writeFileSync(f, await synthBuffer({}, mutate));
  return f;
}
const allNotReady = (s: DemoState) => IDS.every((id) => !isScenarioReady(s, id) && scenarioView(s, id).readiness === "NOT READY");
const coreOnly = (wb: ExcelJS.Workbook) =>
  wb.eachSheet((ws) => {
    if (["Items", "SalesHistory", "Stock"].includes(ws.name)) return;
    for (let i = ws.rowCount; i > 1; i--) ws.spliceRows(i, 1);
  });

describe("no data, and synthetic data only by explicit choice", () => {
  it("nothing configured: NO DATA, every scenario NOT READY, synthetic is NOT silently used", async () => {
    for (const cfg of [{}, { source: "" }, { source: "  " }, { workbookPath: "" }]) {
      const s = await loadDemoState(cfg);
      expect(s.kind).toBe("not-loaded");
      expect(allNotReady(s)).toBe(true);
      expect(overviewView(s).provenance).toBe("NO DATA");
      expect(overviewView(s).headline).toBe("NO DATA LOADED · 0 of 4 scenarios READY");
    }
  });

  it("RWTSA_SOURCE=synthetic loads the deterministic synthetic dataset, labelled SYNTHETIC", async () => {
    const s = await loadDemoState({ source: "synthetic" });
    expect(s).toMatchObject({ kind: "validated", provenance: "SYNTHETIC" });
    expect(overviewView(s).headline).toBe("STRUCTURE PASS · 4 of 4 scenarios READY");
    expect(overviewView(s).banner.text).toContain("SYNTHETIC TEST DATA");
    expect(overviewView(s).banner.text).toContain("NOT THE ADVISOR'S WORKBOOK");
    expect(validationView(s).sourceLabel).toBe("synthetic:seed=20261031");
    const again = await loadDemoState({ source: "synthetic" });
    expect(JSON.stringify(again)).toBe(JSON.stringify(s)); // deterministic
  });

  it("an unknown source value is a configuration error, not a guess", async () => {
    const s = await loadDemoState({ source: "demo" });
    expect(s.kind).toBe("config-error");
    expect(allNotReady(s)).toBe(true);
    expect(overviewView(s).banner.tone).toBe("danger");
  });

  it("selecting synthetic AND a local workbook loads nothing: ambiguous, never resolved silently", async () => {
    const s = await loadDemoState({ source: "synthetic", workbookPath: await workbookFile("both.xlsx") });
    expect(s.kind).toBe("config-error");
    expect(allNotReady(s)).toBe(true);
    expect(provenanceFor(s)).toBe("NO DATA");
  });
});
const provenanceFor = (s: DemoState) => overviewView(s).provenance;

describe("a local workbook that cannot be validated never produces READY and never falls back to synthetic", () => {
  it("a valid local workbook: LOCAL WORKBOOK provenance, READY derived from the validator, no path or file name in any view", async () => {
    const file = await workbookFile(`${S}_valid.xlsx`);
    const s = await loadDemoState({ workbookPath: file });
    expect(s).toMatchObject({ kind: "validated", provenance: "LOCAL WORKBOOK" });
    expect(overviewView(s).headline).toBe("STRUCTURE PASS · 4 of 4 scenarios READY");
    expect(validationView(s).sourceLabel).toMatch(/^local-workbook:[0-9a-f]{12}$/);
    const json = JSON.stringify([overviewView(s), IDS.map((id) => scenarioView(s, id)), validationView(s)]);
    expect(json).not.toContain(S);
    expect(json).not.toContain(tmp);
    expect(json).not.toContain("SYNTHETIC TEST DATA");
  });

  it("a missing workbook: error state, LOCAL WORKBOOK provenance, all NOT READY, no synthetic substitution, value-free message", async () => {
    const s = await loadDemoState({ workbookPath: join(tmp, `${S}_missing.xlsx`) });
    expect(s.kind).toBe("error");
    expect(provenanceFor(s)).toBe("LOCAL WORKBOOK");
    expect(allNotReady(s)).toBe(true);
    expect(overviewView(s).headline).toBe("LOAD ERROR · 0 of 4 scenarios READY");
    expect(overviewView(s).banner.text).not.toMatch(/SYNTHETIC/);
    const json = JSON.stringify([overviewView(s), IDS.map((id) => scenarioView(s, id)), validationView(s)]);
    expect(json).not.toContain(S);
    expect(json).not.toContain(tmp);
  });

  it("a file that is not an .xlsx, and a workbook inside the repository, are errors (NOT READY)", async () => {
    const bad = join(tmp, "not-a-workbook.xlsx");
    writeFileSync(bad, `${S} not a workbook`);
    for (const path of [bad, join(__dirname, "..", "..", "..", "package.json")]) {
      const s = await loadDemoState({ workbookPath: path });
      expect(s.kind).toBe("error");
      expect(allNotReady(s)).toBe(true);
      expect(JSON.stringify(validationView(s))).not.toContain(S);
    }
  });

  it("a structurally invalid workbook (headers only): STRUCTURE FAIL, nothing READY, no fallback", async () => {
    const s = await loadDemoState({ workbookPath: await workbookFile("hollow.xlsx", (wb) => wb.eachSheet((ws) => { for (let i = ws.rowCount; i > 1; i--) ws.spliceRows(i, 1); })) });
    expect(s).toMatchObject({ kind: "validated", provenance: "LOCAL WORKBOOK" });
    expect(overviewView(s).headline).toBe("STRUCTURE FAIL · 0 of 4 scenarios READY");
    expect(allNotReady(s)).toBe(true);
    expect(scenarioView(s, "A").reasons.join(" ")).toContain("structure is invalid");
    expect(overviewView(s).banner.tone).toBe("danger");
  });

  it("defence in depth: even a state whose flags say ready is NOT READY if its structure failed", () => {
    const real: DemoState = { kind: "validated", provenance: "LOCAL WORKBOOK", summary: { structure: "FAIL", tabs: Object.fromEntries(TAB_NAMES.map((t) => [t, { present: true, rows: 1, missingFields: [] }])) as never, findings: [], readiness: IDS.map((scenario) => ({ scenario, ready: true, missingTabs: [], missingFields: [], unpopulatedFields: [], salesWindow: null })), scenariosReady: 4, readinessConfig: { forecastWindowMonths: 6 }, sourceLabel: "x" }, dataset: null };
    expect(allNotReady(real)).toBe(true);
    expect(overviewView(real).scenariosReady).toBe(0);
  });
});

describe("a local workbook is refused under the development server (it contacts the npm registry)", () => {
  it("devServer + workbook: configuration error, nothing loaded, all NOT READY, no fallback", async () => {
    const s = await loadDemoState({ workbookPath: await workbookFile("dev.xlsx"), devServer: true });
    expect(s.kind).toBe("config-error");
    expect(allNotReady(s)).toBe(true);
    expect(overviewView(s).provenance).toBe("NO DATA");
    expect(JSON.stringify(overviewView(s))).toContain("production mode");
  });

  it("the same workbook in production mode loads; synthetic data may still be shown under the dev server", async () => {
    const file = await workbookFile("prod.xlsx");
    expect((await loadDemoState({ workbookPath: file, devServer: false })).kind).toBe("validated");
    expect((await loadDemoState({ workbookPath: file })).kind).toBe("validated");
    expect((await loadDemoState({ source: "synthetic", devServer: true })).kind).toBe("validated");
  });
});

describe("STRUCTURE PASS is not readiness; READY is exactly the validator's per-scenario flag", () => {
  it("PASS with zero scenarios READY: every scenario NOT READY and the overview says so", async () => {
    const s = await loadDemoState({ workbookPath: await workbookFile("core.xlsx", coreOnly) });
    expect(overviewView(s).headline).toBe("STRUCTURE PASS · 0 of 4 scenarios READY");
    expect(allNotReady(s)).toBe(true);
    expect(overviewView(s).notices.join(" ")).toContain("does not mean any scenario is ready");
    expect(scenarioView(s, "D").reasons.join(" ")).toContain("Tab Customers is empty or missing");
  });

  it("only scenario A not ready (Min level unpopulated): A NOT READY with its reason, B/C/D READY; views mirror the flags exactly", async () => {
    const s = await loadDemoState({
      workbookPath: await workbookFile("a-only.xlsx", (wb) => {
        const ws = sheet(wb, "Items");
        for (let row = 2; row <= ws.rowCount; row++) ws.getRow(row).getCell(colOf(ws, "Min level")).value = null;
      }),
    });
    if (s.kind !== "validated") throw new Error("expected a validated state");
    for (const r of s.summary.readiness) expect(scenarioView(s, r.scenario).readiness).toBe(r.ready ? "READY" : "NOT READY");
    expect(scenarioView(s, "A").readiness).toBe("NOT READY");
    expect(scenarioView(s, "A").reasons.join(" ")).toContain("Items.minLevel");
    expect(IDS.filter((id) => isScenarioReady(s, id))).toEqual(["B", "C", "D"]);
    expect(overviewView(s).headline).toBe("STRUCTURE PASS · 3 of 4 scenarios READY");
  });

  it("a short sales window makes A NOT READY and says why, value-free", async () => {
    const s = await loadDemoState({ workbookPath: await workbookFile("window.xlsx", (wb) => { sheet(wb, "SalesHistory").getRow(2).getCell(34).value = null; }) });
    expect(isScenarioReady(s, "A")).toBe(false);
    expect(scenarioView(s, "A").reasons.join(" ")).toMatch(/Sales history needs 6 valid months per SKU: 1 SKU\(s\) incomplete/);
  });

  it("the forecast window is configurable and malformed text is a configuration error", async () => {
    const file = await workbookFile("fw.xlsx", (wb) => { sheet(wb, "SalesHistory").getRow(2).getCell(30).value = null; });
    expect(isScenarioReady(await loadDemoState({ workbookPath: file }), "A")).toBe(true);
    expect(isScenarioReady(await loadDemoState({ workbookPath: file, forecastWindow: "12" }), "A")).toBe(false);
    for (const bad of ["0x6", "6.0", " 6", "abc", "0", "99"]) {
      const s = await loadDemoState({ source: "synthetic", forecastWindow: bad });
      expect(s.kind, bad).toBe("config-error");
      expect(allNotReady(s)).toBe(true);
    }
  });

  it("no workbook value reaches any view, even from a poisoned workbook", async () => {
    const s = await loadDemoState({
      workbookPath: await workbookFile("poison.xlsx", (wb) => {
        const st = sheet(wb, "Stock");
        st.getRow(2).getCell(colOf(st, "JHB")).value = `${S}_num`;
        st.getRow(3).getCell(colOf(st, "Style code")).value = `${S}_style`;
        wb.addWorksheet(`${S}_sheet`).addRow([`${S}_cell`]);
      }),
    });
    expect(s.kind).toBe("validated");
    expect(allNotReady(s)).toBe(true);
    expect(JSON.stringify([s, overviewView(s), IDS.map((id) => scenarioView(s, id)), validationView(s)])).not.toContain(S);
  });
});

describe("delivery layers, assumptions and engine status (static, brief-derived)", () => {
  it("every capability names a valid delivery layer; each scenario shows the layers the brief assigns", () => {
    for (const sc of SCENARIOS) {
      expect(sc.capabilities.length).toBeGreaterThan(0);
      for (const c of sc.capabilities) expect(DELIVERY_LAYERS).toContain(c.layer);
      expect(sc.assumptions.length).toBeGreaterThan(0);
    }
    const layers = (id: string) => new Set(SCENARIOS.find((s) => s.id === id)!.capabilities.map((c) => c.layer));
    expect(layers("A")).toEqual(new Set(["CIN7 CORE", "TOOLBOX"]));
    expect(layers("B")).toContain("FAST REACT / EXTERNAL");
    expect(layers("C")).toContain("XERO");
    expect(layers("D")).toEqual(new Set(["CIN7 CORE", "TOOLBOX"]));
  });

  it("native Cin7 Core / Xero claims are all flagged for independent verification (owner decision D6)", () => {
    for (const sc of SCENARIOS) for (const c of sc.capabilities) if (c.layer === "CIN7 CORE" || c.layer === "XERO") expect(c.verify, `${sc.id}: ${c.name}`).toBe(true);
  });

  it("only the Scenario A (Red Flag) engine exists; no other scenario claims one", async () => {
    for (const sc of SCENARIOS) expect(sc.engine.implemented).toBe(sc.id === "A");
    const s = await loadDemoState({ source: "synthetic" });
    for (const id of IDS) expect(scenarioView(s, id).engineImplemented).toBe(id === "A");
    // An available engine never makes data READY: an unusable source has the engine flag but is NOT READY.
    expect(scenarioView({ kind: "not-loaded" }, "A")).toMatchObject({ engineImplemented: true, readiness: "NOT READY" });
  });

  it("the approved decisions are recorded as such (D2 Available start, D3 exclusion rule, D4 FEC documented configuration)", () => {
    const text = (id: string, status: string) => SCENARIOS.find((s) => s.id === id)!.assumptions.filter((a) => a.status === status).map((a) => a.text).join(" ");
    expect(text("A", "Approved")).toMatch(/Available/);
    expect(text("A", "Approved")).toMatch(/removed from both the demand total and the observation count/);
    expect(text("C", "Approved")).toMatch(/documented configuration/);
  });
});
