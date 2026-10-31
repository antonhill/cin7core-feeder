import ExcelJS from "exceljs";
import { buildSyntheticWorkbook, type SyntheticOptions } from "@/rwtsa-demo/fixtures/synthetic";
import { buildDataset, type BuildResult, type HeaderOverrides } from "@/rwtsa-demo/workbook/build-dataset";
import { readWorkbookBuffer } from "@/rwtsa-demo/workbook/read";

/** Test helpers: build a SYNTHETIC workbook, optionally mutate it, and round-trip it through a real .xlsx buffer. */

export type Mutator = (wb: ExcelJS.Workbook) => void;

export async function synthBuffer(opts: SyntheticOptions = {}, mutate?: Mutator): Promise<Buffer> {
  const s = buildSyntheticWorkbook(opts);
  mutate?.(s.workbook);
  return Buffer.from(await s.workbook.xlsx.writeBuffer());
}

export async function buildFrom(buffer: Buffer, headerOverrides?: HeaderOverrides): Promise<BuildResult> {
  const read = await readWorkbookBuffer(buffer);
  return buildDataset(read, { provenance: "synthetic", source: { label: "synthetic:test" }, headerOverrides });
}

export async function buildSynth(opts: SyntheticOptions = {}, mutate?: Mutator, headerOverrides?: HeaderOverrides): Promise<BuildResult> {
  return buildFrom(await synthBuffer(opts, mutate), headerOverrides);
}

/** 1-based column index of the header whose text equals `header` (exact), or throws. */
export function colOf(ws: ExcelJS.Worksheet, header: string): number {
  const row = ws.getRow(1);
  for (let c = 1; c <= ws.columnCount; c++) if (row.getCell(c).value === header) return c;
  throw new Error(`test helper: header not found: ${header}`);
}

export function sheet(wb: ExcelJS.Workbook, name: string): ExcelJS.Worksheet {
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error(`test helper: sheet not found: ${name}`);
  return ws;
}

export function codes(result: BuildResult, code: string): BuildResult["findings"] {
  return result.findings.filter((f) => f.code === code);
}
