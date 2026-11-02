import { parseIsoDate, checkTextValue } from "@/rwtsa-demo/fastreact/format";
import {
  RETURN_FIELDS,
  RETURN_STATUSES,
  type ParsedReturn,
  type ReturnOrderRef,
  type ReturnStatus,
} from "@/rwtsa-demo/fastreact/return-format";

/**
 * Validates a parsed return file against the local orders and the already-applied state, and decides, row by row, what would happen.
 * Pure: nothing is written here. `applyPlan` returns a NEW state and is the only thing that turns a plan into stored changes.
 *
 * Outcomes:
 *  - NEW        no stored return for this order; accepted.
 *  - UPDATED    newer than the stored one and consistent with it; accepted.
 *  - DUPLICATE  identical to what is already stored (or a repeat of an identical row in the same file, or this exact file was
 *               already applied); no effect.
 *  - STALE      older than the stored update; rejected.
 *  - CONFLICT   same timestamp but different content, or a newer update that lowers the completed quantity or reopens a completed
 *               order; rejected for human review.
 *  - SUPERSEDED an older row for an order that has a newer row in the same file; no effect.
 *  - REJECTED   invalid (reasons given).
 * Nothing here writes to Cin7, Fast React, Xero or the workbook, and nothing creates a finished-goods receipt.
 */

export type Outcome = "NEW" | "UPDATED" | "DUPLICATE" | "STALE" | "CONFLICT" | "SUPERSEDED" | "REJECTED";
export type SourceKind = "synthetic-sample" | "upload";

export interface ReturnRecord {
  readonly line: string;
  readonly section: string;
  readonly start: string;
  readonly end: string;
  readonly delivery: string;
  readonly status: ReturnStatus;
  readonly qtyDone: number;
  readonly updatedAt: string;
}

export interface StoredOrderReturn extends ReturnRecord {
  readonly fileHash: string;
  readonly appliedAt: string;
  readonly sourceKind: SourceKind;
}

export interface HistoryEntry {
  readonly fileHash: string;
  readonly appliedAt: string;
  readonly sourceKind: SourceKind;
  readonly rows: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly duplicates: number;
  readonly stale: number;
  readonly conflicts: number;
  readonly superseded: number;
}

export interface StoredReturns {
  readonly orders: Readonly<Record<string, StoredOrderReturn>>;
  readonly history: readonly HistoryEntry[];
}

export const EMPTY_RETURNS: StoredReturns = { orders: {}, history: [] };
export const MAX_HISTORY = 50;

export interface Change {
  readonly field: string;
  readonly from: string;
  readonly to: string;
}

export interface PlanRow {
  readonly line: number;
  /** The order reference as given in the file. */
  readonly order: string;
  /** The local order code it matched, or null. */
  readonly orderNo: string | null;
  readonly outcome: Outcome;
  readonly accepted: boolean;
  readonly reasons: readonly string[];
  readonly warnings: readonly string[];
  readonly changes: readonly Change[];
  readonly record: ReturnRecord | null;
}

export interface PlanSummary {
  readonly rows: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly duplicates: number;
  readonly stale: number;
  readonly conflicts: number;
  readonly superseded: number;
}

export interface ReturnPlan {
  readonly fileHash: string;
  readonly fileErrors: readonly string[];
  readonly alreadyApplied: boolean;
  readonly rows: readonly PlanRow[];
  readonly summary: PlanSummary;
}

const TS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const FUTURE_TOLERANCE_MS = 5 * 60_000;

function parseTimestamp(s: string): number | null {
  const m = TS.exec(s);
  if (!m || parseIsoDate(`${m[1]}-${m[2]}-${m[3]}`) === null) return null;
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const se = Number(m[6]);
  if (h > 23 || mi > 59 || se > 59) return null;
  return Date.parse(s);
}

const FIELD_KEYS: readonly (readonly [keyof ReturnRecord, string])[] = [
  ["line", "SPK.LINE"],
  ["section", "SPK.SECT"],
  ["start", "SPK.START"],
  ["end", "SPK.END"],
  ["delivery", "SPK.DELIVERY"],
  ["status", "SPK.STATUS"],
  ["qtyDone", "SPK.QTYDONE"],
  ["updatedAt", "SPK.UPDATED"],
];

function same(a: ReturnRecord, b: ReturnRecord): boolean {
  return FIELD_KEYS.every(([k]) => a[k] === b[k]);
}

function diff(from: ReturnRecord, to: ReturnRecord): Change[] {
  return FIELD_KEYS.filter(([k]) => from[k] !== to[k]).map(([k, code]) => ({ field: code, from: String(from[k]), to: String(to[k]) }));
}

interface Validated {
  readonly record: ReturnRecord | null;
  readonly orderNo: string | null;
  readonly reasons: string[];
  readonly warnings: string[];
}

function validateRow(values: Readonly<Record<string, string>>, orders: ReadonlyMap<string, ReturnOrderRef>, now: Date): Validated {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const v = (code: string): string => values[code] ?? "";
  for (const f of RETURN_FIELDS) {
    const x = v(f.code);
    if (f.required && x === "") reasons.push(`${f.code} is required.`);
    if (x !== "" && f.type === "text") {
      const bad = checkTextValue(x);
      if (bad !== null) reasons.push(`${f.code} ${bad}.`);
      else if (f.maxLength !== null && x.length > f.maxLength) reasons.push(`${f.code} is longer than ${f.maxLength} characters.`);
    }
  }
  const section = v("SPK.SECT");
  if (section !== "") {
    const bad = checkTextValue(section);
    if (bad !== null) reasons.push(`SPK.SECT ${bad}.`);
    else if (section.length > 15) reasons.push("SPK.SECT is longer than 15 characters.");
  }
  const ref = orders.get(v("SPK.ORDER").toUpperCase());
  if (v("SPK.ORDER") !== "" && !ref) reasons.push("Unknown order: it is not a production order in this data source.");
  const dateOk = (code: string): boolean => {
    const x = v(code);
    if (x === "") return false;
    if (parseIsoDate(x) === null) {
      reasons.push(`${code} is not a real YYYY-MM-DD date.`);
      return false;
    }
    return true;
  };
  const sOk = dateOk("SPK.START");
  const eOk = dateOk("SPK.END");
  if (v("SPK.DELIVERY") !== "") dateOk("SPK.DELIVERY");
  if (sOk && eOk && v("SPK.START") > v("SPK.END")) reasons.push("Planned start is after expected completion.");
  const status = v("SPK.STATUS");
  if (status !== "" && !(RETURN_STATUSES as readonly string[]).includes(status)) reasons.push("SPK.STATUS is not one of PLANNED, IN_PROGRESS, COMPLETE, HELD.");
  const qRaw = v("SPK.QTYDONE");
  let qty = Number.NaN;
  if (qRaw !== "") {
    if (!/^\d{1,9}$/.test(qRaw) || Number(qRaw) > 2_147_483_647) reasons.push("SPK.QTYDONE must be a whole number, zero or more.");
    else qty = Number(qRaw);
  }
  if (ref && Number.isFinite(qty)) {
    if (qty > ref.qty) reasons.push("The completed quantity exceeds the ordered quantity.");
    if (status === "PLANNED" && qty > 0) reasons.push("A PLANNED row cannot report output.");
    if (status === "COMPLETE" && qty < ref.qty) warnings.push("Marked COMPLETE short of the ordered quantity.");
  }
  const ts = v("SPK.UPDATED");
  if (ts !== "") {
    const ms = parseTimestamp(ts);
    if (ms === null) reasons.push("SPK.UPDATED is not a UTC timestamp (YYYY-MM-DDTHH:MM:SSZ).");
    else if (ms > now.getTime() + FUTURE_TOLERANCE_MS) reasons.push("SPK.UPDATED is in the future.");
  }
  if (reasons.length > 0 || !ref) return { record: null, orderNo: ref?.orderNo ?? null, reasons, warnings };
  return {
    orderNo: ref.orderNo,
    reasons,
    warnings,
    record: {
      line: v("SPK.LINE"),
      section,
      start: v("SPK.START"),
      end: v("SPK.END"),
      delivery: v("SPK.DELIVERY"),
      status: status as ReturnStatus,
      qtyDone: qty,
      updatedAt: ts,
    },
  };
}

function summarise(rows: readonly PlanRow[]): PlanSummary {
  const n = (o: Outcome) => rows.filter((r) => r.outcome === o).length;
  return {
    rows: rows.length,
    accepted: rows.filter((r) => r.accepted).length,
    rejected: n("REJECTED"),
    duplicates: n("DUPLICATE"),
    stale: n("STALE"),
    conflicts: n("CONFLICT"),
    superseded: n("SUPERSEDED"),
  };
}

export function planReturn(parsed: ParsedReturn, orders: readonly ReturnOrderRef[], stored: StoredReturns, ctx: { now: Date; fileHash: string }): ReturnPlan {
  if (parsed.fileErrors.length > 0) {
    return { fileHash: ctx.fileHash, fileErrors: parsed.fileErrors, alreadyApplied: false, rows: [], summary: summarise([]) };
  }
  const alreadyApplied = stored.history.some((h) => h.fileHash === ctx.fileHash);
  const byCode = new Map(orders.map((o) => [o.orderNo.toUpperCase(), o] as const));

  const checked = parsed.rows.map((r) => {
    if (r.parseError !== null) return { r, val: { record: null, orderNo: null, reasons: [r.parseError], warnings: [] } as Validated };
    return { r, val: validateRow(r.values, byCode, ctx.now) };
  });

  // Within-file resolution per order.
  const groups = new Map<string, number[]>();
  checked.forEach((c, i) => {
    if (c.val.record && c.val.orderNo) groups.set(c.val.orderNo, [...(groups.get(c.val.orderNo) ?? []), i]);
  });
  const fileOutcome = new Map<number, { outcome: Outcome; reason?: string }>();
  for (const idxs of groups.values()) {
    const latest = idxs.reduce((m, i) => (checked[i].val.record!.updatedAt > m ? checked[i].val.record!.updatedAt : m), "");
    const top = idxs.filter((i) => checked[i].val.record!.updatedAt === latest);
    for (const i of idxs) if (!top.includes(i)) fileOutcome.set(i, { outcome: "SUPERSEDED", reason: "A newer row for this order is in the same file." });
    const first = checked[top[0]].val.record!;
    if (top.some((i) => !same(first, checked[i].val.record!))) for (const i of top) fileOutcome.set(i, { outcome: "CONFLICT", reason: "Rows for this order share a timestamp but differ." });
    else top.slice(1).forEach((i) => fileOutcome.set(i, { outcome: "DUPLICATE", reason: "Repeats an identical row earlier in the file." }));
  }

  const rows: PlanRow[] = checked.map(({ r, val }, i) => {
    const base = { line: r.line, order: r.values["SPK.ORDER"] ?? "", orderNo: val.orderNo, warnings: val.warnings };
    if (val.record === null) return { ...base, outcome: "REJECTED", accepted: false, reasons: val.reasons, changes: [], record: null };
    if (alreadyApplied) return { ...base, outcome: "DUPLICATE", accepted: false, reasons: ["This exact file was already applied; nothing is applied twice."], changes: [], record: val.record };
    const f = fileOutcome.get(i);
    if (f && f.outcome !== "NEW") return { ...base, outcome: f.outcome, accepted: false, reasons: [f.reason ?? ""], changes: [], record: val.record };
    const prior = stored.orders[val.orderNo as string];
    const rec = val.record;
    if (!prior) return { ...base, outcome: "NEW", accepted: true, reasons: [], changes: [], record: rec };
    if (rec.updatedAt < prior.updatedAt) return { ...base, outcome: "STALE", accepted: false, reasons: ["Older than the update already applied for this order."], changes: [], record: rec };
    if (rec.updatedAt === prior.updatedAt) {
      return same(rec, prior)
        ? { ...base, outcome: "DUPLICATE", accepted: false, reasons: ["Identical to the update already applied."], changes: [], record: rec }
        : { ...base, outcome: "CONFLICT", accepted: false, reasons: ["Same timestamp as the applied update but different content."], changes: diff(prior, rec), record: rec };
    }
    if (rec.qtyDone < prior.qtyDone) return { ...base, outcome: "CONFLICT", accepted: false, reasons: ["Newer, but the completed quantity is lower than already applied."], changes: diff(prior, rec), record: rec };
    if (prior.status === "COMPLETE" && rec.status !== "COMPLETE") return { ...base, outcome: "CONFLICT", accepted: false, reasons: ["Newer, but it reopens an order already applied as COMPLETE."], changes: diff(prior, rec), record: rec };
    return { ...base, outcome: "UPDATED", accepted: true, reasons: [], changes: diff(prior, rec), record: rec };
  });
  return { fileHash: ctx.fileHash, fileErrors: [], alreadyApplied, rows, summary: summarise(rows) };
}

/** Returns a new state with the plan's accepted rows applied. Changes nothing if the plan has file errors, was already applied, or accepts no rows. */
export function applyPlan(stored: StoredReturns, plan: ReturnPlan, meta: { appliedAt: string; fileHash: string; sourceKind: SourceKind }): StoredReturns {
  if (plan.fileErrors.length > 0 || plan.alreadyApplied || plan.summary.accepted === 0) return stored;
  const orders: Record<string, StoredOrderReturn> = { ...stored.orders };
  for (const r of plan.rows) {
    if (!r.accepted || r.record === null || r.orderNo === null) continue;
    orders[r.orderNo] = { ...r.record, fileHash: meta.fileHash, appliedAt: meta.appliedAt, sourceKind: meta.sourceKind };
  }
  const s = plan.summary;
  const entry: HistoryEntry = {
    fileHash: meta.fileHash,
    appliedAt: meta.appliedAt,
    sourceKind: meta.sourceKind,
    rows: s.rows,
    accepted: s.accepted,
    rejected: s.rejected,
    duplicates: s.duplicates,
    stale: s.stale,
    conflicts: s.conflicts,
    superseded: s.superseded,
  };
  return { orders, history: [...stored.history, entry].slice(-MAX_HISTORY) };
}
