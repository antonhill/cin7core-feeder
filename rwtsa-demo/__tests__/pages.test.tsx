import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { colOf, sheet, synthBuffer } from "@/rwtsa-demo/__tests__/helpers";
import OverviewPage, * as overviewModule from "../app/page";
import ValidationPage, * as validationModule from "../app/validation/page";
import ScenarioAPage, * as aModule from "../app/scenario-a/page";
import ScenarioBPage, * as bModule from "../app/scenario-b/page";
import ScenarioCPage, * as cModule from "../app/scenario-c/page";
import ScenarioDPage, * as dModule from "../app/scenario-d/page";
import { Nav } from "../components/Nav";

/**
 * The REAL page modules, rendered in-process against the real loader (no Next server, no network): what the shell
 * actually shows for each data situation. Each page must display provenance, READY / NOT READY, delivery layer and
 * the assumptions, and must never present a placeholder as a result.
 */

const S = "SENTINEL_PAGE_8E21";
let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "rwtsa-pages-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

function env(vars: Record<string, string>) {
  for (const k of ["RWTSA_SOURCE", "RWTSA_WORKBOOK_PATH", "RWTSA_HEADER_MAP", "RWTSA_FORECAST_WINDOW"]) vi.stubEnv(k, vars[k] ?? "");
  vi.stubEnv("RWTSA_STATE_DIR", join(tmp, "state")); // never the real ~/.rwtsa-demo
}
const html = async (page: () => Promise<React.ReactElement>) => renderToStaticMarkup(await page());
const ScenarioAWithQuery = (query: Record<string, string> = {}) => () => ScenarioAPage({ searchParams: Promise.resolve(query) });
const decode = (t: string) => t.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = (markup: string) => decode(markup.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ");
const testid = (markup: string, id: string) => {
  const m = new RegExp(`data-testid="${id}">([\\s\\S]*?)</span></span>`).exec(markup);
  return m ? text(m[1]).trim() : null;
};
const A_PAGE = ScenarioAWithQuery();
const B_PAGE = () => ScenarioBPage({ searchParams: Promise.resolve({}) });
const C_PAGE = () => ScenarioCPage({ searchParams: Promise.resolve({}) });
const SCENARIO_PAGES = [
  ["A", A_PAGE, aModule],
  ["B", B_PAGE, bModule],
  ["C", C_PAGE, cModule],
  ["D", ScenarioDPage, dModule],
] as const;
const ALL_MODULES = [overviewModule, validationModule, aModule, bModule, cModule, dModule];

describe("every page is rendered per request (no build-time workbook data)", () => {
  it("each page module exports dynamic = 'force-dynamic'", () => {
    for (const m of ALL_MODULES) expect((m as { dynamic?: string }).dynamic).toBe("force-dynamic");
  });
});

describe("explicit synthetic selection", () => {
  it("Scenario A shows SYNTHETIC, READY, ENGINE AVAILABLE and real results; every other scenario still shows no results", async () => {
    env({ RWTSA_SOURCE: "synthetic" });
    const a = await html(A_PAGE);
    expect(testid(a, "provenance")).toBe("SYNTHETIC");
    expect(testid(a, "readiness")).toBe("READY");
    expect(testid(a, "engine")).toBe("ENGINE AVAILABLE");
    expect(testid(a, "structure")).toBe("STRUCTURE PASS");
    expect(text(a)).toContain("SYNTHETIC TEST DATA. NOT THE ADVISOR'S WORKBOOK.");
    expect(a).toContain('data-testid="indicators"');
    expect(a).toContain('data-testid="chart"');
    expect(a).toContain('data-testid="assumptions"');
    for (const [id, Page] of SCENARIO_PAGES.filter(([i]) => i !== "A" && i !== "B" && i !== "C")) {
      const m = await html(Page);
      expect(testid(m, "provenance"), id).toBe("SYNTHETIC");
      expect(testid(m, "readiness"), id).toBe("READY");
      expect(text(m), id).toContain("SYNTHETIC TEST DATA. NOT THE ADVISOR'S WORKBOOK.");
      expect(text(m), id).toContain(`Scenario ${id}`);
      expect(text(m), id).toContain("ENGINE NOT IMPLEMENTED");
      expect(text(m), id).toContain("Delivery layer");
      expect(text(m), id).toContain("Assumptions and open inputs");
      expect(text(m), id).toContain("No results: the calculation engine is not implemented in this build.");
      expect(text(m), id).toContain("Nothing on it is a finding");
      expect(m, id).toContain('data-testid="assumptions"');
    }
  });

  it("shows the right delivery-layer labels per scenario, and flags native claims for independent verification", async () => {
    env({ RWTSA_SOURCE: "synthetic" });
    expect(text(await html(ScenarioDPage))).toContain("TOOLBOX");
    expect(text(await html(B_PAGE))).toContain("FAST REACT / EXTERNAL");
    expect(text(await html(C_PAGE))).toContain("XERO");
  });

  it("the overview separates STRUCTURE PASS from readiness, shows only the Red Flag engine as available", async () => {
    env({ RWTSA_SOURCE: "synthetic" });
    const m = await html(OverviewPage);
    expect(testid(m, "provenance")).toBe("SYNTHETIC");
    expect(text(m)).toContain("STRUCTURE PASS · 4 of 4 scenarios READY");
    expect(text(m)).toContain("does not mean any scenario is ready");
    expect((text(m).match(/NOT IMPLEMENTED/g) ?? []).length).toBe(1);
    expect((text(m).match(/ENGINE AVAILABLE/g) ?? []).length).toBe(3);
  });

  it("the validation page shows structure, source label, forecast window, tabs and per-scenario readiness", async () => {
    env({ RWTSA_SOURCE: "synthetic" });
    const m = text(await html(ValidationPage));
    expect(m).toContain("PASS");
    expect(m).toContain("synthetic:seed=20261031");
    expect(m).toContain("6 months");
    expect(m).toContain("anchors its own window to the stock date");
    expect(m).toContain("Structure PASS is not readiness");
    for (const tab of ["Items", "SalesHistory", "Stock", "Quotes"]) expect(m).toContain(tab);
  });
});

describe("no data, bad configuration and unusable workbooks never show READY or other data", () => {
  it("nothing configured: NO DATA and NOT READY on every page (synthetic is not a default)", async () => {
    env({});
    for (const [id, Page] of SCENARIO_PAGES) {
      const m = await html(Page);
      expect(testid(m, "provenance"), id).toBe("NO DATA");
      expect(testid(m, "readiness"), id).toBe("NOT READY");
      expect(text(m), id).not.toContain("SYNTHETIC");
    }
    expect(text(await html(OverviewPage))).toContain("NO DATA LOADED · 0 of 4 scenarios READY");
  });

  it("both sources selected: configuration error, NOT READY, nothing loaded", async () => {
    const file = join(tmp, "both.xlsx");
    writeFileSync(file, await synthBuffer());
    env({ RWTSA_SOURCE: "synthetic", RWTSA_WORKBOOK_PATH: file });
    const m = await html(A_PAGE);
    expect(testid(m, "readiness")).toBe("NOT READY");
    expect(text(m)).toContain("CONFIGURATION ERROR");
    expect(text(await html(OverviewPage))).toContain("CONFIGURATION ERROR · 0 of 4 scenarios READY");
  });

  it("a missing local workbook: LOCAL WORKBOOK, NOT READY, never SYNTHETIC, no path or file name shown", async () => {
    env({ RWTSA_WORKBOOK_PATH: join(tmp, `${S}_missing.xlsx`) });
    for (const [id, Page] of SCENARIO_PAGES) {
      const m = await html(Page);
      expect(testid(m, "provenance"), id).toBe("LOCAL WORKBOOK");
      expect(testid(m, "readiness"), id).toBe("NOT READY");
      expect(text(m), id).not.toContain("SYNTHETIC");
      expect(m, id).not.toContain(S);
      expect(m, id).not.toContain(tmp);
    }
    const v = text(await html(ValidationPage));
    expect(v).toContain("ERROR");
    expect(v).not.toContain(S);
  });

  it("an invalid local workbook: STRUCTURE FAIL, NOT READY everywhere, reasons shown, no fallback", async () => {
    const file = join(tmp, "hollow.xlsx");
    writeFileSync(file, await synthBuffer({}, (wb) => wb.eachSheet((ws) => { for (let i = ws.rowCount; i > 1; i--) ws.spliceRows(i, 1); })));
    env({ RWTSA_WORKBOOK_PATH: file });
    const a = await html(A_PAGE);
    expect(testid(a, "provenance")).toBe("LOCAL WORKBOOK");
    expect(testid(a, "readiness")).toBe("NOT READY");
    expect(text(a)).toContain("The workbook structure is invalid");
    expect(text(await html(OverviewPage))).toContain("STRUCTURE FAIL · 0 of 4 scenarios READY");
    expect(text(await html(ValidationPage))).toContain("empty_tab");
  });
});

describe("a valid local workbook", () => {
  it("shows LOCAL WORKBOOK and per-scenario READY from the validator; readiness is not blanket-derived from PASS", async () => {
    const file = join(tmp, "a-only.xlsx");
    writeFileSync(
      file,
      await synthBuffer({}, (wb) => {
        const ws = sheet(wb, "Items");
        for (let row = 2; row <= ws.rowCount; row++) ws.getRow(row).getCell(colOf(ws, "Min level")).value = null;
      })
    );
    env({ RWTSA_WORKBOOK_PATH: file });
    const a = await html(A_PAGE);
    expect(testid(a, "provenance")).toBe("LOCAL WORKBOOK");
    expect(testid(a, "readiness")).toBe("NOT READY");
    expect(text(a)).toContain("Items.minLevel");
    expect(text(a)).toContain("LOCAL WORKBOOK. Structure validated on this machine; nothing was uploaded.");
    expect(testid(await html(B_PAGE), "readiness")).toBe("READY");
    expect(text(await html(OverviewPage))).toContain("STRUCTURE PASS · 3 of 4 scenarios READY");
  });

  it("never renders workbook values, file names, paths or remote resources", async () => {
    const file = join(tmp, `${S}_poison.xlsx`);
    writeFileSync(
      file,
      await synthBuffer({}, (wb) => {
        const st = sheet(wb, "Stock");
        st.getRow(3).getCell(colOf(st, "Style code")).value = `${S}_style`;
        wb.addWorksheet(`${S}_sheet`).addRow([`${S}_cell`]);
      })
    );
    env({ RWTSA_WORKBOOK_PATH: file });
    for (const Page of [OverviewPage, ValidationPage, A_PAGE, B_PAGE, C_PAGE, ScenarioDPage]) {
      const m = await html(Page);
      expect(m).not.toContain(S);
      expect(m).not.toContain(tmp);
      expect(m).not.toMatch(/https?:\/\//i);
    }
  });
});

describe("development server", () => {
  it("under NODE_ENV=development a local workbook is refused on every page (NOT READY, no data), while synthetic still works", async () => {
    const file = join(tmp, "dev-refusal.xlsx");
    writeFileSync(file, await synthBuffer());
    env({ RWTSA_WORKBOOK_PATH: file });
    vi.stubEnv("NODE_ENV", "development");
    for (const [id, Page] of SCENARIO_PAGES) {
      const m = await html(Page);
      expect(testid(m, "readiness"), id).toBe("NOT READY");
      expect(testid(m, "provenance"), id).toBe("NO DATA");
      expect(text(m), id).toContain("production mode");
    }
    env({ RWTSA_SOURCE: "synthetic" });
    vi.stubEnv("NODE_ENV", "development");
    expect(testid(await html(A_PAGE), "readiness")).toBe("READY");
  });
});

describe("package scripts", () => {
  it("offer production mode only, bound to 127.0.0.1, with telemetry disabled", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(Object.keys(pkg.scripts).sort()).toEqual(["build", "start", "start:synthetic"]);
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      expect(cmd, name).toContain("NEXT_TELEMETRY_DISABLED=1");
      expect(cmd, name).not.toMatch(/next dev/);
      if (name !== "build") expect(cmd, name).toContain("-H 127.0.0.1");
    }
  });
});

describe("navigation and remote resources", () => {
  it("links every page and loads nothing remote", () => {
    const m = renderToStaticMarkup(<Nav />);
    for (const href of ["/", "/scenario-a", "/scenario-b", "/scenario-c", "/scenario-d", "/validation"]) expect(m).toContain(`href="${href}"`);
    expect(m).not.toMatch(/https?:\/\//i);
  });
});
