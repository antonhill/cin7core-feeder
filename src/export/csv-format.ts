/** Quotes every field, matching Cin7's own export template style (every field quoted, even numbers). */
export function csvField(value: string | number | null | undefined): string {
  const str = value === null || value === undefined ? "" : String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((cols) => cols.map(csvField).join(",")).join("\r\n") + "\r\n";
}

// Security re-audit P1-7: formula-injection protection, for HUMAN-FACING CSV
// exports only. Deliberately a SEPARATE function from csvField/toCsv above,
// which are shared by every Cin7-round-trip export file — altering one of
// those literal values (e.g. a SKU or account code that happens to start
// with "-") would corrupt data on reimport into Cin7. This is for the one
// export where that risk doesn't apply: a human opens the file directly in
// a spreadsheet app.
const FORMULA_PREFIX_CHARS = new Set(["=", "+", "-", "@"]);

/**
 * A spreadsheet app (Excel, Google Sheets, LibreOffice) treats a cell value
 * starting with =, +, -, @, or a leading tab/control character as a formula
 * to EVALUATE, not literal text — a malicious value like
 * `=cmd|'/c calc'!A1` opened by an unsuspecting staff member can execute
 * arbitrary commands via that app's own DDE/formula engine. Prefixing a
 * bare single-quote is the standard mitigation: every major spreadsheet app
 * then displays the value as literal text starting with that character,
 * with no functional/visual difference for a legitimate value that just
 * happens to start with one of these characters.
 */
export function sanitizeCsvField(value: string | number | null | undefined): string {
  const str = value === null || value === undefined ? "" : String(value);
  const firstCode = str.charCodeAt(0);
  const startsWithControlChar = firstCode > 0 && firstCode < 32;
  const needsPrefix = str.length > 0 && (FORMULA_PREFIX_CHARS.has(str[0]) || startsWithControlChar);
  return csvField(needsPrefix ? `'${str}` : str);
}

/** Like toCsv, but formula-injection-safe — for human-facing exports only (see sanitizeCsvField). */
export function toSanitizedCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((cols) => cols.map(sanitizeCsvField).join(",")).join("\r\n") + "\r\n";
}
