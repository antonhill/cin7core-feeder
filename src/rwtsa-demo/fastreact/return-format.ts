import { createHash } from "node:crypto";
import { LIMITS } from "@/rwtsa-demo/fastreact/contract";
import { renderTable } from "@/rwtsa-demo/fastreact/format";

/**
 * The SPARK-PROPOSED DEMONSTRATION return format.
 *
 * Fast React has not supplied a return (export) layout: the vendor pages we hold describe only what goes INTO Fast React, and the
 * DTCS clarification says only that Fast React "sends order updates back to the ERP (for example the suggested or achievable
 * delivery date)". Rev2 (MFG-08) accepts "a working bidirectional file exchange built from the factory-schedule layout, not a live
 * link". This is Spark's proposal for that return file. It is NOT a Fast React specification and no Fast React product produced it.
 *
 * Field codes carry an `SPK.` prefix so they cannot be mistaken for vendor codes. Only fields whose mapping is established by the
 * client documents are included: the order, the planning line and section (factory schedule), planned start and expected completion
 * (Gantt board), the achievable delivery date (named by the vendor and DTCS), the production status, the completed quantity (actual
 * output), and the last-update timestamp (needed to reject stale updates). Material-readiness and planning/prints/stock-order
 * dates appear on the schedule but their meaning and mapping are not established, so they are NOT included.
 */

export const RETURN_FORMAT_LABEL = "SPARK-PROPOSED DEMONSTRATION FORMAT: not a Fast React export, not produced or accepted by Fast React";
export const RETURN_FILE_STEM = "SPARK_PROPOSED_RETURN";

export const RETURN_STATUSES = ["PLANNED", "IN_PROGRESS", "COMPLETE", "HELD"] as const;
export type ReturnStatus = (typeof RETURN_STATUSES)[number];

export interface ReturnField {
  readonly code: string;
  readonly type: "text" | "date" | "integer" | "enum" | "timestamp";
  readonly required: boolean;
  readonly maxLength: number | null;
  readonly meaning: string;
  /** Where the meaning comes from in the client documents. */
  readonly basis: string;
}

export const RETURN_FIELDS: readonly ReturnField[] = [
  { code: "SPK.ORDER", type: "text", required: true, maxLength: 30, meaning: "Production order reference (matches the order code sent out)", basis: "Order reference, factory schedule (Order No)" },
  { code: "SPK.LINE", type: "text", required: true, maxLength: 15, meaning: "Production line allocated by Fast React", basis: "Line allocation: Fast React overview and factory schedule" },
  { code: "SPK.SECT", type: "text", required: false, maxLength: 15, meaning: "Planning section, where the factory uses more than one", basis: "Vendor U.SECT notion (planning board section)" },
  { code: "SPK.START", type: "date", required: true, maxLength: null, meaning: "Planned production start (YYYY-MM-DD)", basis: "Gantt bar start: Fast React overview" },
  { code: "SPK.END", type: "date", required: true, maxLength: null, meaning: "Expected production completion (YYYY-MM-DD)", basis: "Gantt bar end: Fast React overview" },
  { code: "SPK.DELIVERY", type: "date", required: false, maxLength: null, meaning: "Suggested or achievable delivery date (YYYY-MM-DD)", basis: "Named by the vendor clarification (30 Sep 2026) as a return item" },
  { code: "SPK.STATUS", type: "enum", required: true, maxLength: null, meaning: "PLANNED, IN_PROGRESS, COMPLETE or HELD", basis: "Production status: Fast React overview, integration map" },
  { code: "SPK.QTYDONE", type: "integer", required: true, maxLength: null, meaning: "Completed (actual) quantity to date", basis: "Actual output: integration map, Rev2 MFG-08" },
  { code: "SPK.UPDATED", type: "timestamp", required: true, maxLength: null, meaning: "When Fast React last updated this order (UTC, YYYY-MM-DDTHH:MM:SSZ)", basis: "Spark: needed to reject stale and conflicting updates" },
];

export const RETURN_CODES: readonly string[] = RETURN_FIELDS.map((f) => f.code);

export interface ReturnOrderRef {
  readonly orderNo: string;
  readonly qty: number;
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface ParsedRow {
  /** 1-based line number in the file (the header is line 1). */
  readonly line: number;
  readonly values: Readonly<Record<string, string>>;
  readonly parseError: string | null;
}

export interface ParsedReturn {
  readonly delimiter: "tab" | "csv" | null;
  readonly fileErrors: readonly string[];
  readonly rows: readonly ParsedRow[];
}

// Control characters other than tab, CR and LF.
const BAD_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Splits one CSV line. Fields may be quoted (quotes doubled inside) or bare. Returns null for malformed quoting. */
function splitCsv(line: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let v = "";
      i++;
      for (;;) {
        if (i >= line.length) return null;
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            v += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        v += line[i++];
      }
      out.push(v);
      if (i === line.length) return out;
      if (line[i] !== ",") return null;
      i++;
      if (i === line.length) {
        out.push("");
        return out;
      }
    } else {
      const j = line.indexOf(",", i);
      const end = j === -1 ? line.length : j;
      const v = line.slice(i, end);
      if (v.includes('"')) return null;
      out.push(v);
      if (j === -1) return out;
      i = j + 1;
      if (i === line.length) {
        out.push("");
        return out;
      }
    }
  }
  return out;
}

/** Strict, bounded parse. Never throws; file-level problems are value-free (they never echo file content). */
export function parseReturnFile(input: string): ParsedReturn {
  const fail = (m: string): ParsedReturn => ({ delimiter: null, fileErrors: [m], rows: [] });
  if (Buffer.byteLength(input, "utf8") > LIMITS.maxReturnBytes) return fail(`The file is too large (limit ${LIMITS.maxReturnBytes} bytes).`);
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (BAD_CHARS.test(text)) return fail("The file contains characters that are not allowed.");
  if (text.trim() === "") return fail("The file is empty.");
  const lines = text.split(/\r\n|\n|\r/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const headerLine = lines[0] ?? "";
  const delimiter: "tab" | "csv" = headerLine.includes("\t") || (!headerLine.includes(",") && !headerLine.startsWith('"')) ? "tab" : "csv";
  const split = (l: string): string[] | null => (delimiter === "tab" ? l.split("\t") : splitCsv(l));
  const header = split(headerLine);
  if (header === null) return fail("The header row is malformed.");
  const errors: string[] = [];
  const known = new Set(RETURN_CODES);
  const seen = new Set<string>();
  for (const h of header) {
    if (!known.has(h)) {
      if (!errors.includes("The header has an unknown column.")) errors.push("The header has an unknown column.");
    } else if (seen.has(h)) {
      if (!errors.includes("The header has a duplicate column.")) errors.push("The header has a duplicate column.");
    }
    seen.add(h);
  }
  for (const f of RETURN_FIELDS) if (f.required && !seen.has(f.code)) errors.push(`The header is missing required column ${f.code}.`);
  if (errors.length > 0) return { delimiter, fileErrors: errors, rows: [] };
  const dataLines = lines.slice(1);
  if (dataLines.length === 0) return { delimiter, fileErrors: ["The file has no data rows."], rows: [] };
  if (dataLines.length > LIMITS.maxReturnRows) return { delimiter, fileErrors: [`The file has too many rows (limit ${LIMITS.maxReturnRows}).`], rows: [] };
  const rows: ParsedRow[] = dataLines.map((l, i) => {
    const line = i + 2;
    const cells = split(l);
    if (cells === null) return { line, values: {}, parseError: "The row is malformed (quoting)." };
    if (cells.length !== header.length) return { line, values: {}, parseError: `The row has ${cells.length} columns; the header has ${header.length}.` };
    const values: Record<string, string> = {};
    header.forEach((h, k) => (values[h] = cells[k]));
    return { line, values, parseError: null };
  });
  return { delimiter, fileErrors: [], rows };
}

/**
 * A SYNTHETIC sample return file for the given local orders, for the demonstration only. Statuses and quantities are invented
 * for illustration (they are not derived from any workbook value other than the order code and quantity, which must match for
 * the file to be ingestible). Deterministic for a given UTC day: the same day gives byte-identical text, so loading it twice
 * shows idempotency.
 */
export function buildSampleReturn(orders: readonly ReturnOrderRef[], now: Date): string {
  const day = now.toISOString().slice(0, 10);
  const shift = (days: number): string => {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const sorted = [...orders].sort((a, b) => (a.orderNo < b.orderNo ? -1 : a.orderNo > b.orderNo ? 1 : 0));
  const plan: { status: ReturnStatus; pct: number }[] = [
    { status: "IN_PROGRESS", pct: 0.4 },
    { status: "PLANNED", pct: 0 },
    { status: "COMPLETE", pct: 1 },
    { status: "IN_PROGRESS", pct: 0.75 },
  ];
  const rows = sorted.map((o, i) => {
    const p = plan[i % plan.length];
    const done = Math.min(o.qty, Math.floor(o.qty * p.pct));
    const started = p.status !== "PLANNED";
    return [
      o.orderNo,
      i % 2 === 0 ? "Line 1" : "Line 2",
      "",
      started ? shift(-3) : shift(2),
      p.status === "COMPLETE" ? shift(-1) : shift(started ? 14 : 18),
      shift(p.status === "COMPLETE" ? 0 : 21),
      p.status,
      String(done),
      `${day}T06:00:00Z`,
    ];
  });
  const r = renderTable(RETURN_CODES, rows, "tab", "standard");
  return r.text;
}
