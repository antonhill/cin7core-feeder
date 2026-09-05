import { formatCount } from "@/lib/format-count";

/**
 * Security re-audit P1-7: resource boundaries for CSV imports — none existed
 * before this. Shared by every import surface (Products/BOM/Suppliers/
 * Customers/Addresses via src/import/csv.ts's parseCsv, and Stocktake
 * Assistant via src/reports/stocktake-assistant/build.ts's parseStocktakeFile)
 * so a limit only needs setting/tuning in one place. Numbers are generous
 * relative to this app's actual scale (Products is the widest template at
 * ~118 columns; a large real customer instance runs low thousands of rows
 * per entity) while still being small enough to reject an accidental
 * wrong-file upload or a pathological payload with a clear message instead
 * of an opaque framework failure or an unbounded parse.
 */

export const MAX_CSV_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB
export const MAX_CSV_ROWS = 50_000;
export const MAX_CSV_COLUMNS = 200;
export const MAX_CSV_FIELD_LENGTH = 10_000;

/** Checked before `file.text()` reads the whole upload into memory. Returns a user-facing message, or null if the file is within bounds. */
export function checkUploadSize(file: File): string | null {
  if (file.size > MAX_CSV_UPLOAD_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    return `File is ${mb}MB — the maximum is ${MAX_CSV_UPLOAD_BYTES / (1024 * 1024)}MB.`;
  }
  return null;
}

const NUL = String.fromCharCode(0);

/**
 * A genuine CSV/text file never contains a NUL byte; that's a strong,
 * cheap signal of a binary file (image, archive, executable) uploaded with
 * a spoofed `.csv` name/extension rather than trusting the browser-supplied
 * MIME type or file extension alone — same principle as org-logo.ts's
 * magic-byte content sniffing (P1-9), applied to text instead of images.
 */
export function looksLikeText(text: string): boolean {
  return !text.includes(NUL);
}

/**
 * Throws a clear, user-facing error if a parsed CSV exceeds this app's
 * resource limits — checked immediately after Papa.parse, before any
 * per-row zod schema validation runs, so a pathological file is rejected
 * before spending time validating thousands of rows that will just be
 * discarded anyway.
 */
export function assertCsvWithinLimits(data: Record<string, unknown>[], fields: string[]): void {
  if (fields.length > MAX_CSV_COLUMNS) {
    throw new Error(`This file has ${fields.length} columns — the maximum is ${MAX_CSV_COLUMNS}. Is this the right file?`);
  }
  if (data.length > MAX_CSV_ROWS) {
    throw new Error(`This file has ${formatCount(data.length)} rows — the maximum is ${formatCount(MAX_CSV_ROWS)}. Split it into smaller files.`);
  }
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    for (const key of Object.keys(row)) {
      const value = row[key];
      if (typeof value === "string" && value.length > MAX_CSV_FIELD_LENGTH) {
        throw new Error(
          `Row ${i + 1}, column "${key}" is ${formatCount(value.length)} characters — the maximum is ${formatCount(MAX_CSV_FIELD_LENGTH)}.`
        );
      }
    }
  }
}
