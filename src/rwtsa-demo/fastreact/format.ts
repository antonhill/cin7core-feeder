import { compliantHeader, type DateFormat, type Delimiter, type HeaderStyle } from "@/rwtsa-demo/fastreact/contract";

/**
 * Deterministic text rendering for the Fast React import files.
 *
 * Encoding: UTF-8 without a byte-order mark. Line ending: CRLF. Both are our documented defaults, not vendor-confirmed.
 * Tab-separated files are the vendor's recommended form ("tabs are rarely used in text fields"); CSV files quote every field,
 * which the vendor describes as "not bad practice". A value that would break either form is REFUSED, never altered: nothing
 * is trimmed, stripped or escaped on the user's behalf, because a silently changed code could attach an order to the wrong product.
 */

const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Why a text value cannot be written, or null when it can. Never echoes the value. */
export function checkTextValue(v: string): string | null {
  if (v.includes("\t")) return "contains a tab";
  if (/[\r\n]/.test(v)) return "contains a line break";
  if (CTRL.test(v)) return "contains a control character";
  if (v !== v.trim()) return "has leading or trailing space";
  if (/^[=+\-@]/.test(v)) return "starts with a spreadsheet formula character";
  return null;
}

export function parseIsoDate(s: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

export function formatDate(iso: string, format: DateFormat): string {
  const p = parseIsoDate(iso);
  if (!p) throw new Error("not an ISO calendar date");
  const y = String(p.y).padStart(4, "0");
  const m = String(p.m).padStart(2, "0");
  const d = String(p.d).padStart(2, "0");
  if (format === "DD/MM/YYYY") return `${d}/${m}/${y}`;
  if (format === "YYYYMMDD") return `${y}${m}${d}`;
  return `${y}-${m}-${d}`;
}

export interface RenderResult {
  /** The file text; empty when `errors` is not. */
  readonly text: string;
  /** Value-free reasons, one per refused row/cell. */
  readonly errors: readonly string[];
}

const EOL = "\r\n";

/** Renders one file. `headers` are vendor field codes in the standard form; `headerStyle` converts them if requested. */
export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[], delimiter: Delimiter, headerStyle: HeaderStyle): RenderResult {
  const errors: string[] = [];
  rows.forEach((row, i) => {
    if (row.length !== headers.length) {
      errors.push(`Row ${i + 1}: has ${row.length} values for ${headers.length} columns.`);
      return;
    }
    row.forEach((cell, c) => {
      const why = checkTextValue(cell);
      if (why !== null) errors.push(`Row ${i + 1}, column ${headers[c]}: value ${why}.`);
    });
  });
  if (errors.length > 0) return { text: "", errors };
  const head = headers.map((h) => (headerStyle === "compliant" ? compliantHeader(h) : h));
  const line = (cells: readonly string[]): string => (delimiter === "tab" ? cells.join("\t") : cells.map((c) => `"${c.replace(/"/g, '""')}"`).join(","));
  return { text: [head, ...rows].map(line).join(EOL) + EOL, errors: [] };
}
