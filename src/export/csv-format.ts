/** Quotes every field, matching Cin7's own export template style (every field quoted, even numbers). */
export function csvField(value: string | number | null | undefined): string {
  const str = value === null || value === undefined ? "" : String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((cols) => cols.map(csvField).join(",")).join("\r\n") + "\r\n";
}
