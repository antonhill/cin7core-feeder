/**
 * Structured, VALUE-FREE findings.
 *
 * Confidentiality rule (owner direction, 2026-10-31): nothing derived from a protected workbook's cell values
 * may reach an error message, a log line or a report. A finding therefore carries only:
 *   - a stable code,
 *   - the tab name (one of our own TAB_NAMES, never file-supplied text),
 *   - OUR canonical field/header names,
 *   - counts and 1-based sheet row numbers (capped).
 * It never carries a cell value, a file-supplied header, a file-supplied tab name or a file name.
 */

export type Severity = "error" | "warning" | "info";

export type FindingCode =
  | "file_too_large"
  | "path_inside_repository"
  | "not_a_workbook"
  | "too_many_rows"
  | "too_many_columns"
  | "cell_too_long"
  | "missing_tab"
  | "unknown_tab"
  | "missing_header"
  | "duplicate_header"
  | "unknown_column"
  | "invalid_month_header"
  | "duplicate_month"
  | "month_gap"
  | "no_month_columns"
  | "required_blank"
  | "invalid_cell"
  | "duplicate_key"
  | "orphan_sku"
  | "orphan_style"
  | "tender_with_min_level"
  | "available_mismatch"
  | "lost_without_reason"
  | "po_missing_sku_and_style"
  | "formula_without_cached_result"
  | "error_cell";

export interface Finding {
  readonly severity: Severity;
  readonly code: FindingCode;
  /** One of our own tab names, or null for workbook-level findings. */
  readonly tab: string | null;
  /** Our canonical field key, when the finding is about one field. */
  readonly field?: string;
  /** For invalid_cell: the reason class (e.g. "number_format"), never the value. */
  readonly reason?: string;
  readonly count: number;
  /** 1-based sheet row numbers, capped at MAX_ROWS_LISTED. */
  readonly rows?: readonly number[];
}

export const MAX_ROWS_LISTED = 20;

export function finding(f: Omit<Finding, "rows"> & { rows?: readonly number[] }): Finding {
  return f.rows ? { ...f, rows: f.rows.slice(0, MAX_ROWS_LISTED) } : f;
}

export function hasErrors(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.severity === "error");
}

/**
 * An error whose message is guaranteed value-free by construction: callers may only pass static text and our
 * own identifiers. Anything else that is thrown (ExcelJS, zip, fs) is converted by `toSafeMessage`.
 */
export class RwtsaSafeError extends Error {
  readonly code: FindingCode;
  constructor(code: FindingCode, message: string) {
    super(message);
    this.name = "RwtsaSafeError";
    this.code = code;
  }
}

/** Reduces any thrown value to a message that cannot echo workbook content: only our own errors keep their text. */
export function toSafeMessage(e: unknown): string {
  if (e instanceof RwtsaSafeError) return e.message;
  const name = e instanceof Error ? e.name : typeof e;
  return `Unexpected ${name} while reading the workbook (details withheld to protect workbook contents).`;
}
