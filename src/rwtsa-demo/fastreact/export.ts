import { createHash } from "node:crypto";
import {
  DEFAULT_DATE_FORMAT,
  FILE_IDS,
  LIMITS,
  ORDER_STATUSES,
  contractFor,
  fileName,
  type DateFormat,
  type Delimiter,
  type FileId,
  type HeaderStyle,
} from "@/rwtsa-demo/fastreact/contract";
import { checkTextValue, formatDate, parseIsoDate, renderTable } from "@/rwtsa-demo/fastreact/format";
import { matrixFor, type MatrixRow } from "@/rwtsa-demo/fastreact/matrix";

/**
 * Builds the five Fast React import files from the validated dataset plus planner-supplied values, entirely in memory.
 *
 * Rules (MFG-08 brief, vendor "Importing Data" pages):
 *  - Full current position of the selected orders every run: no add/amend/delete flags, no synchronisation field, ever.
 *  - Nothing mandatory is substituted: a missing customer, date, product type or product code FAILS the file with a value-free
 *    issue list and no text. Identifiers (operation external IDs, product types, customers) are never invented.
 *  - Text is never trimmed, stripped, escaped or truncated: a value that would break the file or be truncated by Fast React is refused.
 *  - References are checked ignoring case (Fast React upper-cases text), so two codes that differ only by case are duplicates.
 *  - Deterministic: everything is sorted by code; identical inputs give byte-identical files and hashes.
 *  - Nothing here touches the network, the workbook file, or Cin7, Xero or Fast React.
 */

export interface ExchangeSource {
  readonly provenance: "local-workbook" | "synthetic";
  readonly sourceLabel: string;
  /** Customer codes from the Customers tab; repeated customers (one row per contact) are fine. */
  readonly customers: readonly string[];
  readonly items: readonly { readonly sku: string; readonly styleCode: string; readonly productionCode: string | null; readonly description: string | null }[];
  readonly orders: readonly { readonly orderNo: string; readonly styleCode: string; readonly qty: number }[];
}

export interface OrderSupplement {
  readonly customer: string | null;
  /** ISO `YYYY-MM-DD`. */
  readonly deliveryDate: string | null;
  readonly status: string | null;
}

/** Values the workbook lacks, stated by the planner. */
export interface Supplement {
  /** Keyed by order number (exact). */
  readonly orders: Readonly<Record<string, OrderSupplement>>;
  /** Keyed by style code. `workContent` maps operation external ID to work content; it is entered only when the vendor supplies the IDs. */
  readonly productTypes: Readonly<Record<string, { readonly code: string; readonly workContent?: Readonly<Record<string, number>> }>>;
}

export interface UpdateInput {
  readonly order: string;
  /** ISO `YYYY-MM-DD`. */
  readonly date: string;
  readonly qty: number;
  readonly section?: string;
  readonly line?: string;
  readonly complete?: number;
}

export interface ExportOptions {
  readonly delimiter: Delimiter;
  readonly dateFormat: DateFormat;
  readonly headerStyle: HeaderStyle;
  /** Order numbers to export; null means every production order. */
  readonly selectedOrders: readonly string[] | null;
  readonly updates: readonly UpdateInput[];
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  delimiter: "tab",
  dateFormat: DEFAULT_DATE_FORMAT,
  headerStyle: "standard",
  selectedOrders: null,
  updates: [],
};

export type FileStatus = "READY" | "FAILED" | "NOT_EXPORTABLE";
export type IssueKind =
  | "missing-required"
  | "reference"
  | "duplicate"
  | "invalid"
  | "too-long"
  | "ambiguous"
  | "limit"
  | "invalid-operation-id"
  | "inconsistent"
  | "unsafe-text"
  | "not-found";

export interface Issue {
  readonly kind: IssueKind;
  /** Vendor field code, or "-" for a file-level issue. */
  readonly field: string;
  /** Value-free explanation. */
  readonly message: string;
  /** The record the issue is about (an order or style code), for the page only. Never logged. */
  readonly ref: string | null;
}

export interface ExportFile {
  readonly id: FileId;
  readonly name: string;
  readonly status: FileStatus;
  readonly rowCount: number;
  readonly columns: readonly string[];
  /** The exact file text; null unless READY. */
  readonly text: string | null;
  readonly sha256: string | null;
  readonly issues: readonly Issue[];
  readonly notes: readonly string[];
  readonly notExportableReason: string | null;
  readonly coverage: readonly MatrixRow[];
}

export interface ExportReport {
  readonly files: readonly ExportFile[];
  /** CUSTOMER, PRODTYPE, PRODUCTS and ORDERS are all READY: the vendor's minimum (base) file set is internally consistent. */
  readonly baseSetReady: boolean;
  readonly provenance: ExchangeSource["provenance"] | null;
  readonly sourceLabel: string | null;
  readonly encoding: string;
  readonly lineEnding: "CRLF";
  readonly options: ExportOptions;
}

const ENCODING = "UTF-8, no byte-order mark";
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const up = (s: string): string => s.toUpperCase();
const STATUS_CODES = new Set(ORDER_STATUSES.map((s) => s.code));

function maxOf(file: FileId, code: string): number | null {
  return contractFor(file).find((c) => c.code === code)?.maxLength ?? null;
}

class Collector {
  readonly issues: Issue[] = [];
  add(kind: IssueKind, field: string, message: string, ref: string | null = null): void {
    this.issues.push({ kind, field, message, ref });
  }
  /** Text-value checks shared by every text field: blank, unsafe characters, over-length. Returns true when the value is usable. */
  text(file: FileId, field: string, value: string | null | undefined, ref: string | null, required: boolean): value is string {
    if (value === null || value === undefined || value === "") {
      if (required) this.add("missing-required", field, `${field} is required and has no value.`, ref);
      return false;
    }
    const bad = checkTextValue(value);
    if (bad !== null) {
      this.add("unsafe-text", field, `${field} ${bad}.`, ref);
      return false;
    }
    const max = maxOf(file, field);
    if (max !== null && value.length > max) {
      this.add("too-long", field, `${field} is longer than the ${max} characters Fast React accepts; it would be truncated.`, ref);
      return false;
    }
    return true;
  }
}

function finish(
  id: FileId,
  opt: ExportOptions,
  c: Collector,
  columns: readonly string[],
  rows: readonly (readonly string[])[],
  notes: readonly string[],
  coverage: readonly MatrixRow[],
): ExportFile {
  const issues = [...c.issues];
  if (rows.length > LIMITS.maxExportRows) issues.push({ kind: "limit", field: "-", message: `More than ${LIMITS.maxExportRows} rows.`, ref: null });
  let text: string | null = null;
  if (issues.length === 0) {
    const r = renderTable(columns, rows, opt.delimiter, opt.headerStyle);
    if (r.errors.length > 0) for (const e of r.errors) issues.push({ kind: "unsafe-text", field: "-", message: e, ref: null });
    else text = r.text;
  }
  return {
    id,
    name: fileName(id, opt.delimiter),
    status: issues.length === 0 ? "READY" : "FAILED",
    rowCount: rows.length,
    columns,
    text,
    sha256: text === null ? null : createHash("sha256").update(text, "utf8").digest("hex"),
    issues,
    notes,
    notExportableReason: null,
    coverage,
  };
}

function notExportable(id: FileId, opt: ExportOptions, reason: string): ExportFile {
  return {
    id,
    name: fileName(id, opt.delimiter),
    status: "NOT_EXPORTABLE",
    rowCount: 0,
    columns: [],
    text: null,
    sha256: null,
    issues: [],
    notes: [],
    notExportableReason: reason,
    coverage: matrixFor(id),
  };
}

const OP_ID = /^[1-9]\d{0,8}$/;

export function buildExport(source: ExchangeSource | null, supplement: Supplement, options: ExportOptions): ExportReport {
  const base = { encoding: ENCODING, lineEnding: "CRLF" as const, options };
  if (source === null) {
    const reason = "No data source is loaded, so there is nothing to export.";
    return { ...base, files: FILE_IDS.map((id) => notExportable(id, options, reason)), baseSetReady: false, provenance: null, sourceLabel: null };
  }

  // ---- selection (orders) ----
  const selectIssues = new Collector();
  const allOrders = [...source.orders].sort((a, b) => cmp(a.orderNo, b.orderNo));
  let selected = allOrders;
  if (options.selectedOrders !== null) {
    const want = new Set(options.selectedOrders);
    selected = allOrders.filter((o) => want.has(o.orderNo));
    const have = new Set(allOrders.map((o) => o.orderNo));
    for (const w of [...want].sort(cmp)) if (!have.has(w)) selectIssues.add("not-found", "O.CODE", "A selected order was not found in the data source.", w);
  }

  // ---- CUSTOMER ----
  const cc = new Collector();
  const customerCodes = [...new Set(source.customers)].sort(cmp);
  const customerSeen = new Map<string, string>();
  const validCustomers = new Set<string>();
  const customerBad = new Set<string>();
  for (const code of customerCodes) {
    if (!cc.text("CUSTOMER", "C.CODE", code, code, true)) {
      customerBad.add(up(code));
      continue;
    }
    const prior = customerSeen.get(up(code));
    if (prior !== undefined) {
      cc.add("duplicate", "C.CODE", "Two customer codes differ only by letter case; Fast React treats them as one.", code);
      customerBad.add(up(code));
    } else customerSeen.set(up(code), code);
  }
  for (const k of customerSeen.keys()) if (!customerBad.has(k)) validCustomers.add(k);
  const customerFile =
    customerCodes.length === 0
      ? notExportable("CUSTOMER", options, "The data source has no customers.")
      : finish("CUSTOMER", options, cc, ["C.CODE"], customerCodes.map((x) => [x]), ["C.DESCRIP and the other optional customer fields are not written: the workbook holds no source for them."], matrixFor("CUSTOMER"));

  // ---- PRODUCTS / PRODTYPE ----
  const pc = new Collector();
  const tc = new Collector();
  const styles = [...new Set(selected.map((o) => o.styleCode))].sort(cmp);
  const productByStyle = new Map<string, string>(); // style -> valid product code
  const productRows: { style: string; code: string; type: string }[] = [];
  for (const style of styles) {
    const items = source.items.filter((i) => i.styleCode === style);
    if (items.length === 0) continue; // the order will fail with a reference issue
    const codes = [...new Set(items.map((i) => i.productionCode).filter((x): x is string => x !== null && x !== ""))];
    let code: string | null = null;
    let ok = true;
    if (codes.length === 0) {
      pc.add("missing-required", "P.CODE", "A style has no production code, so it has no Fast React product code.", style);
      ok = false;
    } else if (codes.length > 1) {
      pc.add("ambiguous", "P.CODE", "A style carries more than one production code; the product code is ambiguous.", style);
      ok = false;
    } else if (pc.text("PRODUCTS", "P.CODE", codes[0], style, true)) code = codes[0];
    else ok = false;
    const type = supplement.productTypes[style]?.code ?? null;
    if (type === null || type === "") {
      pc.add("missing-required", "P.TYPE", "No product type has been chosen for this style.", style);
      ok = false;
    } else if (!pc.text("PRODUCTS", "P.TYPE", type, style, true)) ok = false;
    if (ok && code !== null && type !== null) productRows.push({ style, code, type });
  }
  // duplicate product codes across styles (ignoring case)
  const prodSeen = new Map<string, string[]>();
  for (const r of productRows) prodSeen.set(up(r.code), [...(prodSeen.get(up(r.code)) ?? []), r.style]);
  const dupStyles = new Set<string>();
  for (const [, list] of prodSeen)
    if (list.length > 1) {
      for (const s of list) {
        dupStyles.add(s);
        pc.add("duplicate", "P.CODE", "Two styles resolve to the same product code (ignoring case).", s);
      }
    }
  const goodProducts = productRows.filter((r) => !dupStyles.has(r.style)).sort((a, b) => cmp(a.code, b.code));
  for (const r of goodProducts) productByStyle.set(r.style, r.code);

  // product types
  const typeRows = new Map<string, { code: string; wc: Record<string, number> | null; styles: string[] }>();
  for (const style of styles) {
    const t = supplement.productTypes[style];
    if (!t || t.code === "") continue;
    if (checkTextValue(t.code) !== null || t.code.length > (maxOf("PRODTYPE", "T.CODE") ?? 15)) continue; // already reported on PRODUCTS (P.TYPE)
    const key = up(t.code);
    const wc = t.workContent && Object.keys(t.workContent).length > 0 ? { ...t.workContent } : null;
    const prior = typeRows.get(key);
    if (!prior) typeRows.set(key, { code: t.code, wc, styles: [style] });
    else {
      if (prior.code !== t.code) tc.add("duplicate", "T.CODE", "Two product type codes differ only by letter case; Fast React treats them as one.", style);
      if (JSON.stringify(sortWc(prior.wc)) !== JSON.stringify(sortWc(wc))) tc.add("inconsistent", "T^WC:n", "The same product type has different work content on different styles.", style);
      prior.styles.push(style);
    }
  }
  const types = [...typeRows.values()].sort((a, b) => cmp(a.code, b.code));
  let opIds: string[] = [];
  const wcTypes = types.filter((t) => t.wc !== null);
  if (wcTypes.length > 0) {
    for (const t of types) {
      if (t.wc === null) continue;
      for (const [id, v] of Object.entries(t.wc)) {
        if (!OP_ID.test(id)) tc.add("invalid-operation-id", "T^WC:n", "An operation external ID is not a whole number of 1 or more.", t.code);
        if (!Number.isFinite(v) || v <= 0) tc.add("invalid", "T^WC:n", "Work content must be a finite number above zero.", t.code);
      }
    }
    if (wcTypes.length !== types.length) tc.add("inconsistent", "T^WC:n", "Some product types have work content and others do not.", null);
    else {
      const sets = types.map((t) => Object.keys(t.wc as Record<string, number>).sort(cmp).join(","));
      if (new Set(sets).size > 1) tc.add("inconsistent", "T^WC:n", "Product types do not all have the same operations.", null);
    }
    opIds = [...new Set(wcTypes.flatMap((t) => Object.keys(t.wc as Record<string, number>)))].filter((id) => OP_ID.test(id)).sort((a, b) => Number(a) - Number(b));
  }
  for (const t of types) tc.text("PRODTYPE", "T.CODE", t.code, t.code, true);
  const typeCols = ["T.CODE", ...opIds.map((id) => `T^WC:${id}`)];
  const typeNotes =
    opIds.length === 0
      ? ["Work content (T^WC:n) is not written: it needs the operation external IDs, which the vendor has not supplied. None were invented, so each product type must already hold its work content in Fast React."]
      : [];
  const typeFile =
    types.length === 0
      ? notExportable("PRODTYPE", options, "No product types have been chosen for the selected products.")
      : finish("PRODTYPE", options, tc, typeCols, types.map((t) => [t.code, ...opIds.map((id) => String((t.wc ?? {})[id] ?? ""))]), typeNotes, matrixFor("PRODTYPE"));
  const typeSet = new Set(types.map((t) => up(t.code)));
  // P.TYPE must be one of the exported product types (only meaningful when that file can be produced)
  for (const r of goodProducts)
    if (!typeSet.has(up(r.type))) pc.add("reference", "P.TYPE", "The product type is not in the exported product type file.", r.style);

  const productFile =
    styles.length === 0
      ? notExportable("PRODUCTS", options, "No orders are selected, so there are no products to export.")
      : finish("PRODUCTS", options, pc, ["P.CODE", "P.TYPE"], goodProducts.map((r) => [r.code, r.type]), ["P^WC:n is omitted: the vendor allows work content to be inferred from P.TYPE. P.DESCRIP and P.CUST are not written (no style-level source)."], matrixFor("PRODUCTS"));

  // ---- ORDERS ----
  const oc = new Collector();
  oc.issues.push(...selectIssues.issues);
  const orderSeen = new Map<string, string>();
  const orderRows: { code: string; prod: string; cust: string; dd: string; dq: number; status: string | null }[] = [];
  const statuses: (string | null)[] = [];
  for (const o of selected) {
    let ok = true;
    if (!oc.text("ORDERS", "O.CODE", o.orderNo, o.orderNo, true)) ok = false;
    const prior = orderSeen.get(up(o.orderNo));
    if (prior !== undefined) {
      oc.add("duplicate", "O.CODE", "Two order codes are the same ignoring letter case.", o.orderNo);
      ok = false;
    } else orderSeen.set(up(o.orderNo), o.orderNo);
    const prod = productByStyle.get(o.styleCode) ?? null;
    if (prod === null) {
      oc.add("reference", "O.PROD", "The order's product is not a valid product in the PRODUCTS file.", o.orderNo);
      ok = false;
    }
    const s = supplement.orders[o.orderNo];
    const cust = s?.customer ?? null;
    if (cust === null || cust === "") {
      oc.add("missing-required", "O.CUST", "No customer has been chosen for this order.", o.orderNo);
      ok = false;
    } else if (!validCustomers.has(up(cust))) {
      oc.add("reference", "O.CUST", "The order's customer is not a valid customer in the CUSTOMER file.", o.orderNo);
      ok = false;
    }
    const dd = s?.deliveryDate ?? null;
    if (dd === null || dd === "") {
      oc.add("missing-required", "O^DD:1", "No delivery date has been entered for this order.", o.orderNo);
      ok = false;
    } else if (parseIsoDate(dd) === null) {
      oc.add("invalid", "O^DD:1", "The delivery date is not a real calendar date.", o.orderNo);
      ok = false;
    }
    if (!Number.isInteger(o.qty) || o.qty <= 0 || o.qty > 2_147_483_647) {
      oc.add("invalid", "O^DQ:1", "The quantity must be a whole number above zero.", o.orderNo);
      ok = false;
    }
    const st = s?.status ?? null;
    if (st !== null && st !== "" && !STATUS_CODES.has(st)) {
      oc.add("invalid", "O.STATUS", "The status must be F, P, S or T.", o.orderNo);
      ok = false;
    }
    statuses.push(st === "" ? null : st);
    if (ok && prod !== null && cust !== null && dd !== null) orderRows.push({ code: o.orderNo, prod, cust, dd, dq: o.qty, status: st === "" ? null : st });
  }
  const withStatus = statuses.filter((x) => x !== null).length;
  const includeStatus = selected.length > 0 && withStatus === selected.length;
  const orderCols = ["O.CODE", "O.PROD", "O.CUST", "O^DD:1", "O^DQ:1", ...(includeStatus ? ["O.STATUS"] : [])];
  const orderNotes = [
    includeStatus
      ? "O.STATUS is written for every order."
      : withStatus > 0
        ? "O.STATUS is omitted for all orders because not every selected order has a status."
        : "O.STATUS is omitted: no status has been chosen.",
    "Planning board allocation, priority and completion fields are never written: Fast React is the scheduling authority.",
  ];
  const orderFile =
    selected.length === 0 && oc.issues.length === 0
      ? notExportable("ORDERS", options, "No production orders are available to export.")
      : finish(
          "ORDERS",
          options,
          oc,
          orderCols,
          orderRows.map((r) => [r.code, r.prod, r.cust, formatDate(r.dd, options.dateFormat), String(r.dq), ...(includeStatus ? [r.status ?? ""] : [])]),
          orderNotes,
          matrixFor("ORDERS"),
        );
  const orderCodes = new Set(orderRows.map((r) => up(r.code)));

  // ---- UPDATE ----
  let updateFile: ExportFile;
  if (options.updates.length === 0) {
    updateFile = notExportable("UPDATE", options, "No production update data: the workbook holds no actual output quantity or update date, and actual output originates in Fast React. Nothing was fabricated.");
  } else {
    const uc = new Collector();
    const seen = new Set<string>();
    const rows = options.updates.map((u) => ({ ...u }));
    const optional = (k: "section" | "line" | "complete") => {
      const n = rows.filter((r) => r[k] !== undefined).length;
      if (n > 0 && n < rows.length) uc.add("inconsistent", k === "section" ? "U.SECT" : k === "line" ? "U.LINE" : "U.COMPLETE", "Supplied for some update rows but not all; it is not dropped silently.", null);
      return n === rows.length;
    };
    const withSect = optional("section");
    const withLine = optional("line");
    const withComp = optional("complete");
    for (const u of rows) {
      uc.text("UPDATE", "U.ORDER", u.order, u.order, true);
      if (!orderCodes.has(up(u.order))) uc.add("reference", "U.ORDER", "The update is for an order that is not in the exported ORDERS file.", u.order);
      if (parseIsoDate(u.date) === null) uc.add("invalid", "U.DATE", "The update date is not a real calendar date.", u.order);
      if (!Number.isInteger(u.qty) || u.qty < 0 || u.qty > 2_147_483_647) uc.add("invalid", "U.QTY", "The quantity must be a whole number, zero or more.", u.order);
      if (u.section !== undefined) uc.text("UPDATE", "U.SECT", u.section, u.order, false);
      if (u.line !== undefined) uc.text("UPDATE", "U.LINE", u.line, u.order, false);
      if (u.complete !== undefined && u.complete !== 0 && u.complete !== 1) uc.add("invalid", "U.COMPLETE", "Complete must be 0 or 1.", u.order);
      const key = `${up(u.order)}\u0000${u.date}`;
      if (seen.has(key)) uc.add("duplicate", "U.ORDER", "Two update rows are for the same order and date.", u.order);
      seen.add(key);
    }
    const cols = ["U.ORDER", "U.DATE", "U.QTY", ...(withSect ? ["U.SECT"] : []), ...(withLine ? ["U.LINE"] : []), ...(withComp ? ["U.COMPLETE"] : [])];
    const sorted = [...rows].sort((a, b) => cmp(a.order, b.order) || cmp(a.date, b.date));
    updateFile = finish(
      "UPDATE",
      options,
      uc,
      cols,
      sorted.map((u) => {
        const d = parseIsoDate(u.date) === null ? u.date : formatDate(u.date, options.dateFormat);
        return [u.order, d, String(u.qty), ...(withSect ? [u.section as string] : []), ...(withLine ? [u.line as string] : []), ...(withComp ? [String(u.complete)] : [])];
      }),
      [],
      matrixFor("UPDATE"),
    );
  }

  const files = [customerFile, typeFile, productFile, orderFile, updateFile];
  return {
    ...base,
    files,
    baseSetReady: files.slice(0, 4).every((f) => f.status === "READY"),
    provenance: source.provenance,
    sourceLabel: source.sourceLabel,
  };
}

function sortWc(wc: Record<string, number> | null): [string, number][] | null {
  return wc === null ? null : Object.entries(wc).sort((a, b) => cmp(a[0], b[0]));
}
