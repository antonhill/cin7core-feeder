import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { buildFrom, colOf, sheet, synthBuffer } from "@/rwtsa-demo/__tests__/helpers";
import { RwtsaSafeError, toSafeMessage } from "@/rwtsa-demo/findings";
import { assertOutputDirAllowed, assertWorkbookPathAllowed } from "@/rwtsa-demo/workbook/path-guard";
import { loadHeaderOverrides, validateWorkbookFile } from "@/rwtsa-demo/workbook/validate-file";
import { readWorkbookBuffer } from "@/rwtsa-demo/workbook/read";

/**
 * AT-3 confidentiality canary + AT-11 path rules.
 *
 * A workbook is seeded with unmistakable sentinel strings in every place a value could leak from: bad numbers,
 * bad dates, bad enums, duplicate and orphan keys, unknown headers, an unknown tab name, a lost-quote reason,
 * and the FILE NAME itself. The sentinel must never appear in any finding, certificate, thrown message,
 * stdout or stderr. (The loaded dataset of a VALID workbook obviously contains its data; the guarantee is
 * about everything that reports on it.)
 */

const ROOT = join(__dirname, "..", "..", "..");
const S = "SENTINEL_9F3A1C";

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "rwtsa-test-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function poison(wb: ExcelJS.Workbook): void {
  const stock = sheet(wb, "Stock");
  stock.getRow(2).getCell(colOf(stock, "JHB")).value = `${S}_num`;
  stock.getRow(3).getCell(colOf(stock, "SKU")).value = `${S}_orphan`;
  const pos = sheet(wb, "ImportPOs");
  pos.getRow(2).getCell(colOf(pos, "ETA stores")).value = `${S}_date`;
  pos.getRow(3).getCell(colOf(pos, "Supplier")).value = `${S}_supplier`;
  const q = sheet(wb, "Quotes");
  q.getRow(2).getCell(colOf(q, "Status")).value = `${S}_enum`;
  q.getRow(3).getCell(colOf(q, "Customer")).value = `${S}_customer`;
  const items = sheet(wb, "Items");
  items.getRow(2).getCell(colOf(items, "SKU")).value = `${S}_dupsku`;
  items.getRow(3).getCell(colOf(items, "SKU")).value = `${S}_dupsku`;
  items.getRow(4).getCell(colOf(items, "Description")).value = `${S}_description`;
  const cust = sheet(wb, "Customers");
  cust.getRow(1).getCell(10).value = `${S}_header`;
  wb.addWorksheet(`${S}_sheet`).addRow([`${S}_cell`]);
  const sales = sheet(wb, "SalesHistory");
  sales.getRow(1).getCell(colOf(sales, "2026-08")).value = `${S}_month`;
}

/** Sentinels in every place the NEW remediation findings look at: style/SKU consistency, coverage, duplicate sheets, negatives. */
function poisonIntegrity(wb: ExcelJS.Workbook): void {
  const stock = sheet(wb, "Stock");
  stock.getRow(4).getCell(colOf(stock, "Style code")).value = `${S}_style`; // SKU still in Items => style_mismatch (and orphan_style)
  stock.getRow(3).getCell(colOf(stock, "JHB")).value = -42;
  const items = sheet(wb, "Items");
  items.getRow(2).getCell(colOf(items, "SKU")).value = `${S}_itemsku`; // no longer covered by Stock / SalesHistory
  const pos = sheet(wb, "ImportPOs");
  pos.getRow(2).getCell(colOf(pos, "SKU")).value = `${S}_posku`;
  pos.getRow(2).getCell(colOf(pos, "Style code")).value = `${S}_postyle`;
  const dup = wb.addWorksheet("items ");
  dup.addRow([`${S}_dupheader`]);
  dup.addRow([`${S}_dupcell`]);
  const sales = sheet(wb, "SalesHistory");
  for (let c = 2; c <= 37; c++) sales.getRow(5).getCell(c).value = null;
  sales.getRow(6).getCell(4).value = null;
  sales.getRow(7).getCell(4).value = `${S}_salescell`;
}

describe("AT-3: confidentiality canary", () => {
  it("no finding contains any workbook-supplied text", async () => {
    const r = await buildFrom(await synthBuffer({}, poison));
    expect(r.ok).toBe(false);
    expect(r.findings.length).toBeGreaterThan(3);
    expect(JSON.stringify(r.findings)).not.toContain(S);
    expect(JSON.stringify(r.parsedRowCounts)).not.toContain(S);
  });

  it("the remediation findings (coverage, style/SKU consistency, duplicate sheet, negative, missing observation) are value-free too", async () => {
    const r = await buildFrom(await synthBuffer({}, poisonIntegrity));
    expect(r.ok).toBe(false);
    const seen = new Set(r.findings.map((f) => f.code));
    for (const code of ["sku_coverage_missing", "style_mismatch", "duplicate_sheet", "negative_value", "sales_series_all_missing", "missing_observation", "invalid_cell", "orphan_sku", "orphan_style"]) {
      expect(seen.has(code as never), code).toBe(true);
    }
    expect(JSON.stringify(r.findings)).not.toContain(S);
    expect(JSON.stringify(r.readiness)).not.toContain(S);
  });

  it("thrown errors are value-free, including unexpected ones", async () => {
    const err = await readWorkbookBuffer(Buffer.from(`${S} not a workbook`)).catch((e) => e);
    expect(err).toBeInstanceOf(RwtsaSafeError);
    expect(String(err.message)).not.toContain(S);
    expect(toSafeMessage(new Error(`${S} leaked from a library`))).not.toContain(S);
    expect(toSafeMessage(`${S} a thrown string`)).not.toContain(S);
  });

  it("the validation certificate contains no cell value, file name or path", async () => {
    const file = join(tmp, `${S}_file.xlsx`);
    writeFileSync(file, await synthBuffer({}, poison));
    const { certificate, dataset } = await validateWorkbookFile(file);
    expect(certificate.status).toBe("fail");
    expect(dataset).toBeNull();
    const json = JSON.stringify(certificate);
    expect(json).not.toContain(S);
    expect(json).not.toContain(tmp);
    expect(certificate.provenance).toBe("local-workbook");
  });

  it("a clean workbook passes and certifies provenance local-workbook with a content hash but no name or path", async () => {
    const file = join(tmp, `${S}_clean.xlsx`);
    writeFileSync(file, await synthBuffer());
    const { certificate, dataset } = await validateWorkbookFile(file);
    expect(certificate.status).toBe("pass");
    expect(dataset?.provenance).toBe("local-workbook");
    expect(dataset?.source.label).toMatch(/^local-workbook:[0-9a-f]{12}$/);
    expect(certificate.controlHash).toBe(dataset?.reconciliation.controlHash);
    expect(certificate.readiness.map((x) => x.scenario)).toEqual(["A", "B", "C", "D"]);
    expect(certificate.readiness.every((x) => x.ready)).toBe(true);
    expect(JSON.stringify(certificate)).not.toContain(S);
  });
});

/** These tests spawn real `npx tsx` subprocesses (slow on a CI runner): a 60 s timeout for THIS group only. */
describe("AT-3 end to end: the real validate script's stdout, stderr and artefacts", { timeout: 60_000 }, () => {
  function run(args: string[]): { status: number; out: string } {
    try {
      const out = execFileSync("npx", ["tsx", "scripts/rwtsa-demo/validate.ts", ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 90_000, env: { ...process.env, NO_COLOR: "1" } });
      return { status: 0, out };
    } catch (e) {
      const x = e as { status?: number; stdout?: string; stderr?: string };
      return { status: x.status ?? -1, out: `${x.stdout ?? ""}${x.stderr ?? ""}` };
    }
  }

  it("a poisoned workbook fails with structure-only output: no sentinel, no file name, no path", async () => {
    const file = join(tmp, `${S}_cli.xlsx`);
    const outDir = join(tmp, "out-fail");
    writeFileSync(file, await synthBuffer({}, poison));
    const r = run(["--file", file, "--out-dir", outDir]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("FAIL");
    expect(r.out).not.toContain(S);
    expect(r.out).not.toContain(tmp);
    const cert = readFileSync(join(outDir, "validation-certificate.json"), "utf8");
    expect(cert).not.toContain(S);
    expect(existsSync(join(outDir, "reconciliation.json"))).toBe(false);
  });

  it("a clean workbook passes; reconciliation is written only to the local output directory and never printed", async () => {
    const file = join(tmp, "clean-cli.xlsx");
    const outDir = join(tmp, "out-pass");
    writeFileSync(file, await synthBuffer());
    const r = run(["--file", file, "--out-dir", outDir, "--reconcile"]);
    expect(r.status).toBe(0);
    expect(r.out.split("\n")[0]).toBe("STRUCTURE PASS · 4 of 4 scenarios READY");
    const rec = JSON.parse(readFileSync(join(outDir, "reconciliation.json"), "utf8"));
    expect(rec.reconciliation.controlHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.out).not.toContain(rec.reconciliation.controlHash);
    expect(r.out).not.toContain("availableUnits");
    expect(r.out).toContain("Scenario readiness");
    for (const sc of ["A", "B", "C", "D"]) expect(r.out).toContain(`${sc}: READY`);
  });

  it("a headers-only workbook FAILS (exit 1) and every scenario is NOT READY; the certificate never says pass", async () => {
    const file = join(tmp, "hollow-cli.xlsx");
    const outDir = join(tmp, "out-hollow");
    writeFileSync(
      file,
      await synthBuffer({}, (wb) =>
        wb.eachSheet((ws) => {
          for (let i = ws.rowCount; i > 1; i--) ws.spliceRows(i, 1);
        })
      )
    );
    const r = run(["--file", file, "--out-dir", outDir, "--reconcile"]);
    expect(r.status).toBe(1);
    expect(r.out.split("\n")[0]).toBe("STRUCTURE FAIL · 0 of 4 scenarios READY");
    expect(r.out).not.toContain("STRUCTURE PASS");
    for (const sc of ["A", "B", "C", "D"]) expect(r.out).toContain(`${sc}: NOT READY`);
    const cert = JSON.parse(readFileSync(join(outDir, "validation-certificate.json"), "utf8"));
    expect(cert.status).toBe("fail");
    expect(cert.readiness.every((x: { ready: boolean }) => !x.ready)).toBe(true);
    expect(existsSync(join(outDir, "reconciliation.json"))).toBe(false);
  });

  it("refuses a workbook inside the repository (exit 2) without echoing the path", () => {
    const r = run(["--file", join(ROOT, "package.json"), "--out-dir", join(tmp, "out-refuse")]);
    expect(r.status).toBe(2);
    expect(r.out).toContain("inside a git working tree");
    expect(r.out).not.toContain("package.json");
  });

  it("refuses an output directory inside the repository and creates nothing there", () => {
    const target = join(ROOT, "rwtsa-out-must-not-exist");
    const file = join(tmp, "clean-cli.xlsx");
    const r = run(["--file", file, "--out-dir", target]);
    expect(r.status).toBe(2);
    expect(existsSync(target)).toBe(false);
  });
});

describe("AT-11: path rules and resource limits", () => {
  it("refuses any file inside a git working tree, accepts one outside", () => {
    expect(() => assertWorkbookPathAllowed(join(ROOT, "package.json"))).toThrowError(/inside a git working tree/);
    const ok = join(tmp, "ok.xlsx");
    writeFileSync(ok, "x");
    expect(assertWorkbookPathAllowed(ok)).toContain("ok.xlsx");
  });

  it("refuses a missing path, a directory and an oversized file with value-free messages", () => {
    expect(() => assertWorkbookPathAllowed(join(tmp, "nope.xlsx"))).toThrowError(RwtsaSafeError);
    expect(() => assertWorkbookPathAllowed(tmp)).toThrowError(/not a regular file/);
    const big = join(tmp, "big.xlsx");
    writeFileSync(big, Buffer.alloc(26 * 1024 * 1024));
    expect(() => assertWorkbookPathAllowed(big)).toThrowError(/exceeds/);
  });

  it("output directories are also kept outside every repository, and nothing is created when refused", () => {
    const inside = join(ROOT, "rwtsa-out-must-not-exist-2");
    expect(() => assertOutputDirAllowed(inside)).toThrowError(/inside a git working tree/);
    expect(existsSync(inside)).toBe(false);
    const outside = join(tmp, "a", "b");
    expect(existsSync(assertOutputDirAllowed(outside))).toBe(true);
  });

  it("header-map files must be outside the repo, valid, and only name contract tabs and fields", () => {
    const good = join(tmp, "map.json");
    writeFileSync(good, JSON.stringify({ Stock: { committed: "Allocated qty" } }));
    expect(loadHeaderOverrides(good)).toEqual({ Stock: { committed: "Allocated qty" } });

    const unknown = join(tmp, "map-unknown.json");
    writeFileSync(unknown, JSON.stringify({ Stock: { notAField: `${S}_x` }, [`${S}_tab`]: { a: "b" } }));
    const err = (() => {
      try {
        loadHeaderOverrides(unknown);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(RwtsaSafeError);
    expect(err!.message).not.toContain(S);

    const bad = join(tmp, "map-bad.json");
    writeFileSync(bad, `{ not json ${S}`);
    expect(() => loadHeaderOverrides(bad)).toThrowError(/not valid JSON/);
    try {
      loadHeaderOverrides(bad);
    } catch (e) {
      expect((e as Error).message).not.toContain(S);
    }
    expect(() => loadHeaderOverrides(join(ROOT, "package.json"))).toThrowError(/inside a git working tree/);
  });
});
