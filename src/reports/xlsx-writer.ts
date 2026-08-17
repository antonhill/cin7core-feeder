import ExcelJS from "exceljs";
import type { SheetExport } from "@/reports/export-xlsx";

// Security re-audit P1-7: resource boundaries for exports — none existed
// before this. This is the ONE shared rendering chokepoint every XLSX export
// action in the app funnels through, so a limit only needs setting here
// once rather than in each of the ~14 export actions individually. Matches
// query.ts's MAX_RPC_ROWS (Order Fulfillment's own confirmed live scale is
// low thousands of rows; 25,000 leaves real headroom) and
// csv-upload-limits.ts's MAX_CSV_FIELD_LENGTH (same reasoning: generous for
// any legitimate field, small enough to reject a pathological cell).
const MAX_XLSX_ROWS = 25_000;
const MAX_XLSX_CELL_LENGTH = 10_000;

function assertSheetWithinLimits(sheet: SheetExport): void {
  if (sheet.data.length > MAX_XLSX_ROWS) {
    throw new Error(`This export has ${sheet.data.length.toLocaleString()} rows — the maximum is ${MAX_XLSX_ROWS.toLocaleString()}. Narrow your filters and try again.`);
  }
  for (let r = 0; r < sheet.data.length; r++) {
    const row = sheet.data[r];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (typeof cell === "string" && cell.length > MAX_XLSX_CELL_LENGTH) {
        throw new Error(`Row ${r + 1}, column ${c + 1} is ${cell.length.toLocaleString()} characters — the maximum is ${MAX_XLSX_CELL_LENGTH.toLocaleString()}.`);
      }
    }
  }
}

/**
 * Server-only — renders a SheetExport (plain data + merge ranges, see
 * export-xlsx.ts) into a real .xlsx file using exceljs, returned as base64
 * so a Server Action can hand it back to the client for a Blob download.
 * Deliberately never imported from a "use client" file: exceljs is a large,
 * Node-oriented library, and keeping it server-only means it never reaches
 * the browser bundle.
 *
 * exceljs was picked over the npm-published `xlsx` (SheetJS) package —
 * SheetJS's last npm release (0.18.5) has unpatched prototype-pollution and
 * ReDoS advisories (fixes only ship via their own CDN now, not npm).
 * exceljs pulls in an old `uuid` with its own moderate advisory, but that's
 * an internal ID generator never exposed to user-controlled input in how we
 * call it here — the better tradeoff of the two real options.
 */
export async function renderXlsxBase64(sheet: SheetExport, sheetName: string): Promise<string> {
  assertSheetWithinLimits(sheet);

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(sheetName.slice(0, 31)); // Excel's own sheet-name length limit

  worksheet.addRows(sheet.data);

  for (const merge of sheet.merges) {
    worksheet.mergeCells(merge.s.r + 1, merge.s.c + 1, merge.e.r + 1, merge.e.c + 1); // exceljs is 1-indexed
  }

  for (let i = 1; i <= sheet.headerRowCount; i++) {
    worksheet.getRow(i).font = { bold: true };
  }
  worksheet.columns.forEach((col) => {
    col.width = 14;
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer).toString("base64");
}
