import Papa from "papaparse";
import type { ZodType } from "zod";

export interface ParsedRow<T> {
  rowNumber: number; // 1-based, matches the CSV data row (header excluded)
  raw: Record<string, unknown>;
  data: T;
}

export interface InvalidRow {
  rowNumber: number;
  raw: Record<string, unknown>;
  errors: string[];
}

export interface CsvParseResult<T> {
  valid: ParsedRow<T>[];
  invalid: InvalidRow[];
}

/** Parses CSV text against a zod row schema. Never throws on row-level issues. */
export function parseCsv<T>(csvText: string, schema: ZodType<T>): CsvParseResult<T> {
  const { data, errors: papaErrors } = Papa.parse<Record<string, unknown>>(csvText, {
    header: true,
    // "true" only skips lines with zero characters — a line of bare commas
    // (every field empty, e.g. a trailing blank row left by opening the CSV
    // in a spreadsheet app) still comes through as a row of empty strings,
    // which then fails required-field validation. "greedy" treats an
    // all-whitespace-or-delimiters line as blank too, matching what a human
    // editing the file would consider an empty row.
    skipEmptyLines: "greedy",
    dynamicTyping: false,
  });

  // Cin7 Core's own exports routinely have a trailing comma (one extra empty
  // column vs. the header row) — that's a per-row field-count mismatch, not a
  // structurally broken file, so it isn't fatal. Anything else (bad quoting,
  // wrong delimiter) is.
  const fatalErrors = papaErrors.filter((e) => e.type !== "FieldMismatch");
  if (fatalErrors.length) {
    throw new Error(`CSV parse error: ${fatalErrors.map((e) => e.message).join("; ")}`);
  }

  const valid: ParsedRow<T>[] = [];
  const invalid: InvalidRow[] = [];

  data.forEach((raw, i) => {
    const rowNumber = i + 1;
    const result = schema.safeParse(raw);
    if (result.success) {
      valid.push({ rowNumber, raw, data: result.data });
    } else {
      invalid.push({
        rowNumber,
        raw,
        errors: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      });
    }
  });

  return { valid, invalid };
}
