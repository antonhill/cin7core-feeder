import ExcelJS from "exceljs";
import type { SheetExport } from "@/reports/export-xlsx";

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
