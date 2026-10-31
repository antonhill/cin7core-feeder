import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { colOf, sheet, synthBuffer } from "@/rwtsa-demo/__tests__/helpers";

/**
 * CLI regression tests (real subprocess): exit codes, the headline summary line, and artefact hygiene. A
 * certificate and a reconciliation report must always belong to the SAME run, and no earlier successful run's output
 * may survive beside a later failed or crashed one.
 */

const ROOT = join(__dirname, "..", "..", "..");
const S = "SENTINEL_CLI_77B2";
let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "rwtsa-cli-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string | undefined> = {}): { status: number; out: string } {
  const e: Record<string, string | undefined> = { ...process.env, NO_COLOR: "1", RWTSA_WORKBOOK_PATH: undefined, RWTSA_HEADER_MAP: undefined, RWTSA_LOCAL_DIR: undefined, ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  try {
    const out = execFileSync("npx", ["tsx", "scripts/rwtsa-demo/validate.ts", ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 90_000, env: e as NodeJS.ProcessEnv });
    return { status: 0, out };
  } catch (err) {
    const x = err as { status?: number; stdout?: string; stderr?: string };
    return { status: x.status ?? -1, out: `${x.stdout ?? ""}${x.stderr ?? ""}` };
  }
}

const first = (out: string) => out.split("\n")[0];
const cert = (dir: string) => JSON.parse(readFileSync(join(dir, "validation-certificate.json"), "utf8"));
const rec = (dir: string) => JSON.parse(readFileSync(join(dir, "reconciliation.json"), "utf8"));
const emptyExcept = (keep: string[]) => (wb: ExcelJS.Workbook) =>
  wb.eachSheet((ws) => {
    if (keep.includes(ws.name)) return;
    for (let i = ws.rowCount; i > 1; i--) ws.spliceRows(i, 1);
  });

async function workbook(name: string, mutate?: (wb: ExcelJS.Workbook) => void): Promise<string> {
  const f = join(tmp, name);
  writeFileSync(f, await synthBuffer({}, mutate));
  return f;
}

describe("summary line and exit codes", () => {
  it("full pass: `STRUCTURE PASS · 4 of 4 scenarios READY`, exit 0", async () => {
    const out = join(tmp, "o-pass");
    const r = run(["--file", await workbook("pass.xlsx"), "--out-dir", out, "--reconcile"]);
    expect(r.status).toBe(0);
    expect(first(r.out)).toBe("STRUCTURE PASS · 4 of 4 scenarios READY");
    const c = cert(out);
    expect(c.status).toBe("pass");
    expect(c.scenariosReady).toBe(4);
    expect(c.readinessConfig).toEqual({ forecastWindowMonths: 6 });
  });

  it("PASS with zero scenarios READY is a legitimate outcome: exit 0, every scenario NOT READY, no 'ready to demo' wording", async () => {
    const out = join(tmp, "o-zero");
    const r = run(["--file", await workbook("zero.xlsx", emptyExcept(["Items", "SalesHistory", "Stock"])), "--out-dir", out]);
    expect(r.status).toBe(0);
    expect(first(r.out)).toBe("STRUCTURE PASS · 0 of 4 scenarios READY");
    for (const sc of ["A", "B", "C", "D"]) expect(r.out).toContain(`${sc}: NOT READY`);
    expect(r.out).toContain("does not mean ready to demonstrate");
    expect(cert(out)).toMatchObject({ status: "pass", scenariosReady: 0 });
  });

  it("a partly ready workbook reports the exact count and the structure-only reasons", async () => {
    const out = join(tmp, "o-partial");
    const r = run([
      "--file",
      await workbook("partial.xlsx", (wb) => {
        const ws = sheet(wb, "Items");
        for (let row = 2; row <= ws.rowCount; row++) ws.getRow(row).getCell(colOf(ws, "Min level")).value = null;
        const sales = sheet(wb, "SalesHistory");
        sales.getRow(2).getCell(34).value = null;
      }),
      "--out-dir",
      out,
    ]);
    expect(r.status).toBe(0);
    expect(first(r.out)).toBe("STRUCTURE PASS · 3 of 4 scenarios READY");
    expect(r.out).toMatch(/A: NOT READY.*unpopulated Items\.minLevel \(23 rows lack a value\).*sales window needs 6 valid months per SKU: 1 SKUs incomplete/);
  });

  it("failure: `STRUCTURE FAIL · 0 of 4 scenarios READY`, exit 1", async () => {
    const out = join(tmp, "o-fail");
    const r = run(["--file", await workbook("fail.xlsx", emptyExcept([])), "--out-dir", out, "--reconcile"]);
    expect(r.status).toBe(1);
    expect(first(r.out)).toBe("STRUCTURE FAIL · 0 of 4 scenarios READY");
    expect(cert(out).status).toBe("fail");
    expect(existsSync(join(out, "reconciliation.json"))).toBe(false);
  });

  it("--forecast-window is honoured and reported", async () => {
    const f = await workbook("window.xlsx", (wb) => {
      sheet(wb, "SalesHistory").getRow(2).getCell(30).value = null; // 8th most recent month
    });
    const six = run(["--file", f, "--out-dir", join(tmp, "o-w6")]);
    expect(first(six.out)).toBe("STRUCTURE PASS · 4 of 4 scenarios READY");
    const twelve = run(["--file", f, "--out-dir", join(tmp, "o-w12"), "--forecast-window", "12"]);
    expect(first(twelve.out)).toBe("STRUCTURE PASS · 3 of 4 scenarios READY");
    expect(twelve.out).toContain("forecast window: 12 months");
    expect(cert(join(tmp, "o-w12")).readinessConfig).toEqual({ forecastWindowMonths: 12 });
  });
});

describe("stale artefacts never survive a later run", () => {
  it("success then FAILED validation in the same directory: the earlier reconciliation is gone and the certificate is the new run's", async () => {
    const out = join(tmp, "o-stale-fail");
    expect(run(["--file", await workbook("s1.xlsx"), "--out-dir", out, "--reconcile"]).status).toBe(0);
    const before = cert(out);
    expect(rec(out).runId).toBe(before.runId);
    expect(rec(out).fileSha256).toBe(before.fileSha256);

    const r = run(["--file", await workbook("s2.xlsx", emptyExcept([])), "--out-dir", out, "--reconcile"]);
    expect(r.status).toBe(1);
    expect(existsSync(join(out, "reconciliation.json"))).toBe(false);
    const after = cert(out);
    expect(after.status).toBe("fail");
    expect(after.runId).not.toBe(before.runId);
  });

  it("success then an EARLY exception (workbook path does not exist): exit 2, an error certificate for the new run, no reconciliation", async () => {
    const out = join(tmp, "o-stale-early");
    expect(run(["--file", await workbook("s3.xlsx"), "--out-dir", out, "--reconcile"]).status).toBe(0);
    const before = cert(out);
    const r = run(["--file", join(tmp, `${S}_missing.xlsx`), "--out-dir", out, "--reconcile"]);
    expect(r.status).toBe(2);
    expect(existsSync(join(out, "reconciliation.json"))).toBe(false);
    const after = cert(out);
    expect(after).toMatchObject({ status: "error", schemaVersion: 1 });
    expect(after.runId).not.toBe(before.runId);
    expect(JSON.stringify(after)).not.toContain(S);
    expect(JSON.stringify(after)).not.toContain(tmp);
    expect(r.out).not.toContain(S);
  });

  it("a bad header-map file is an early exception: exit 2, error certificate, nothing stale", async () => {
    const out = join(tmp, "o-stale-map");
    expect(run(["--file", await workbook("s4.xlsx"), "--out-dir", out, "--reconcile"]).status).toBe(0);
    const bad = join(tmp, "bad-map.json");
    writeFileSync(bad, `{ not json ${S}`);
    const r = run(["--file", await workbook("s5.xlsx"), "--header-map", bad, "--out-dir", out, "--reconcile"]);
    expect(r.status).toBe(2);
    expect(existsSync(join(out, "reconciliation.json"))).toBe(false);
    expect(cert(out).status).toBe("error");
    expect(r.out).not.toContain(S);
  });

  it("an invalid --forecast-window is an early exception (exit 2), also for a missing --file", async () => {
    const out = join(tmp, "o-stale-opt");
    const f = await workbook("s6.xlsx");
    expect(run(["--file", f, "--out-dir", out, "--reconcile"]).status).toBe(0);
    for (const bad of ["abc", "0", "1.5", "99"]) {
      const r = run(["--file", f, "--out-dir", out, "--forecast-window", bad]);
      expect(r.status, bad).toBe(2);
      expect(existsSync(join(out, "reconciliation.json")), bad).toBe(false);
      expect(cert(out).status, bad).toBe("error");
    }
    const noFile = run(["--out-dir", out]);
    expect(noFile.status).toBe(2);
    expect(noFile.out).toContain("usage:");
    expect(cert(out).status).toBe("error");
  });

  it("certificate and reconciliation of one run share its runId; two successful runs get different ids; no temp files remain", async () => {
    const out = join(tmp, "o-runid");
    const f = await workbook("s7.xlsx");
    run(["--file", f, "--out-dir", out, "--reconcile"]);
    const a = cert(out).runId;
    expect(rec(out).runId).toBe(a);
    run(["--file", f, "--out-dir", out, "--reconcile"]);
    const b = cert(out).runId;
    expect(rec(out).runId).toBe(b);
    expect(b).not.toBe(a);
    expect(readdirSync(out).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("without --reconcile a pass leaves no reconciliation from any earlier run", async () => {
    const out = join(tmp, "o-noreconcile");
    const f = await workbook("s8.xlsx");
    run(["--file", f, "--out-dir", out, "--reconcile"]);
    expect(existsSync(join(out, "reconciliation.json"))).toBe(true);
    run(["--file", f, "--out-dir", out]);
    expect(existsSync(join(out, "reconciliation.json"))).toBe(false);
  });
});

describe("safety refusals keep their exit code and leave other directories alone", () => {
  it("a workbook inside the repository: exit 2 with an error certificate (output dir is outside the repo)", async () => {
    const out = join(tmp, "o-refuse-wb");
    const r = run(["--file", join(ROOT, "package.json"), "--out-dir", out]);
    expect(r.status).toBe(2);
    expect(cert(out).status).toBe("error");
    expect(r.out).not.toContain("package.json");
  });

  it("an output directory inside the repository: exit 2, nothing created or deleted, and another run's directory is untouched", async () => {
    const other = join(tmp, "o-other");
    run(["--file", await workbook("s9.xlsx"), "--out-dir", other, "--reconcile"]);
    const before = readdirSync(other).sort();
    const target = join(ROOT, "rwtsa-out-must-not-exist-cli");
    const r = run(["--file", await workbook("s10.xlsx"), "--out-dir", target]);
    expect(r.status).toBe(2);
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(other).sort()).toEqual(before);
  });
});
