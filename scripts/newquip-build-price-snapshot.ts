// Builds the NewQuip Master POC price snapshot from the workbook:
//   npx tsx scripts/newquip-build-price-snapshot.ts "<path to NewQuip Master.xlsx>" "<sheet name>" <YYYY-MM-DD workbook date>
// Reads the workbook only (no network, no Cin7), keeps ONLY the POC's SKUs, and writes
// src/newquip/grower/snapshot/newquip-master-poc.snapshot.json. SKUs missing from the workbook are listed, never invented.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { parseMasterRows } from "../src/newquip/grower/master-parse";
import { referencedSkus } from "../src/newquip/grower/commercial";

async function main() {
  const [file, sheetName, date] = process.argv.slice(2);
  if (!file || !sheetName || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) throw new Error('usage: tsx scripts/newquip-build-price-snapshot.ts "<xlsx>" "<sheet>" <YYYY-MM-DD>');
  const buf = readFileSync(file);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) throw new Error(`Sheet "${sheetName}" not found. Sheets: ${wb.worksheets.map((w) => w.name).join(", ")}`);
  const rows: unknown[][] = [];
  // Cell values: formula cells give their CACHED result (a formula with no cached result is blank, never recomputed or guessed).
  const flat = (c: unknown): unknown => {
    if (c && typeof c === "object" && !(c instanceof Date)) {
      const o = c as { result?: unknown; richText?: { text: string }[]; formula?: string; sharedFormula?: string };
      if (o.richText) return o.richText.map((t) => t.text).join("");
      if ("result" in o) return o.result;
      if (o.formula || o.sharedFormula) return null;
    }
    return c;
  };
  ws.eachRow({ includeEmpty: false }, (row) => {
    rows.push((row.values as unknown[]).slice(1).map(flat));
  });
  const { entries, missing, unpriced, duplicates, rowsRead } = parseMasterRows(rows, referencedSkus());
  const out = {
    id: "newquip-master-poc",
    label: "NewQuip Master workbook – POC controlled snapshot",
    sourceFile: path.basename(file),
    sourceSheet: sheetName,
    sourceDate: date,
    sha256: createHash("sha256").update(buf).digest("hex"),
    entries,
  };
  writeFileSync(path.join(__dirname, "../src/newquip/grower/snapshot/newquip-master-poc.snapshot.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`rows read: ${rowsRead}; SKUs written: ${Object.keys(entries).length}; missing from workbook: ${missing.length ? missing.join(", ") : "none"}; unpriced (blank => supplier quote required): ${unpriced.join(", ") || "none"}; duplicate rows ignored: ${duplicates.join(", ") || "none"}; sha256 ${out.sha256}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
