import type { Grain } from "@/rwtsa-demo/engine/quote-conversion";
import type { RawQuery } from "@/rwtsa-demo/state/red-flag-settings";

/** Scenario D controls, carried in the URL (plain GET form). Invalid values are reported and replaced by the default; never echoed. */
export type StatusFilter = "ALL" | "WON" | "LOST" | "OPEN" | "UNCLASSIFIED";
export type Compare = "count" | "value";

export interface CrmSettings {
  readonly from: string | null;
  readonly to: string | null;
  readonly rep: string | null;
  readonly customer: string | null;
  readonly product: string | null;
  /** Narrows the quote LIST only. Conversion needs both won and lost, so the analytics never take it. */
  readonly status: StatusFilter;
  readonly grain: Grain;
  readonly compare: Compare;
  /** Validated values only, for the form. */
  readonly values: Readonly<Record<"from" | "to" | "rep" | "customer" | "product" | "status" | "grain" | "compare", string>>;
  readonly errors: readonly string[];
}

const one = (q: RawQuery, k: string): string | undefined => {
  const v = q[k];
  return Array.isArray(v) ? (v as readonly string[])[0] : (v as string | undefined);
};

/** A real calendar date in YYYY-MM-DD form (2026-02-30 and 2026-13-01 are rejected). */
export function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

const MAX_TEXT = 120;
const STATUSES: readonly StatusFilter[] = ["ALL", "WON", "LOST", "OPEN", "UNCLASSIFIED"];

export function parseCrmSettings(q: RawQuery): CrmSettings {
  const errors: string[] = [];
  const date = (key: "from" | "to", label: string): string | null => {
    const v = one(q, key);
    if (v === undefined || v === "") return null;
    if (isIsoDate(v)) return v;
    errors.push(`${label}: use a real date as YYYY-MM-DD; default used.`);
    return null;
  };
  let from = date("from", "Period start");
  let to = date("to", "Period end");
  if (from !== null && to !== null && from > to) {
    errors.push("Period: the start is after the end, so both were ignored.");
    from = null;
    to = null;
  }
  const text = (key: string, label: string): string | null => {
    const v = one(q, key);
    if (v === undefined || v === "") return null;
    if (v.length <= MAX_TEXT) return v;
    errors.push(`${label}: too long; default used.`);
    return null;
  };
  const rep = text("rep", "Sales representative");
  const customer = text("customer", "Customer");
  const product = text("product", "Product");
  let status: StatusFilter = "ALL";
  const st = one(q, "status");
  if (st !== undefined && st !== "") {
    const u = st.toUpperCase() as StatusFilter;
    if (STATUSES.includes(u)) status = u;
    else errors.push("Status: all, won, lost, open or unclassified; default used.");
  }
  let grain: Grain = "month";
  const g = one(q, "grain");
  if (g !== undefined && g !== "") {
    if (g === "month" || g === "quarter" || g === "year") grain = g;
    else errors.push("Reporting period: month, quarter or year; default used.");
  }
  let compare: Compare = "count";
  const c = one(q, "compare");
  if (c !== undefined && c !== "") {
    if (c === "count" || c === "value") compare = c;
    else errors.push("Comparison: count or value; default used.");
  }
  return { from, to, rep, customer, product, status, grain, compare, values: { from: from ?? "", to: to ?? "", rep: rep ?? "", customer: customer ?? "", product: product ?? "", status, grain, compare }, errors };
}
