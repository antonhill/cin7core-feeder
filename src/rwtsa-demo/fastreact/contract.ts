/**
 * The Fast React import field contract, transcribed from the vendor reference pages supplied under NDA
 * ("Reference - Importing Data": General, Customers, Product Types, Products, Orders, Production Updates; Evolve and Align
 * v4.52.79 help pages dated 18 Nov 2020). Field codes are the vendor's; nothing here is Spark's invention except where a row is
 * marked `proposed`.
 *
 * Applicability to the client's installed version is NOT confirmed: the client runs a Light version that cannot integrate, and the
 * version and method are still being confirmed (DTCS clarification of 30 Sep 2026, marked DRAFT; Rev2 clarification, MFG-08).
 * Date format, delimiter and compliant-field-name settings are import configuration the client controls and we do not know.
 */

export const FILE_IDS = ["CUSTOMER", "PRODTYPE", "PRODUCTS", "ORDERS", "UPDATE"] as const;
export type FileId = (typeof FILE_IDS)[number];

export type FieldType = "text" | "integer" | "float" | "date";
export type Confidence = "verified" | "proposed" | "unresolved";

export interface ContractField {
  readonly file: FileId;
  /** The vendor field code exactly as documented, for example `O^DD:n`. `n` is a sequence or operation external ID. */
  readonly code: string;
  readonly type: FieldType;
  /** T15 means text up to 15; null for non-text or when no length is documented. */
  readonly maxLength: number | null;
  /** True only when the vendor page prints the field in bold ("essential"). */
  readonly essential: boolean;
  /** Vendor document and section (page heading). */
  readonly evidence: string;
}

const DOC = {
  CUSTOMER: "Customers.pdf, Reference - Importing Data - Customers",
  PRODTYPE: "Product_Types.pdf, Reference - Importing Data - Product Types",
  PRODUCTS: "Products.pdf, Reference - Importing Data - Products",
  ORDERS: "Orders.pdf, Reference - Importing Data - Orders",
  UPDATE: "Production_Updates.pdf, Reference - Importing Data - Production Updates",
} as const;

function f(file: FileId, code: string, type: FieldType, maxLength: number | null, essential: boolean): ContractField {
  return { file, code, type, maxLength, essential, evidence: DOC[file] };
}

/** Fields we use or knowingly leave out. Fields the vendor documents but we never touch are not listed. */
export const CONTRACT: readonly ContractField[] = [
  f("CUSTOMER", "C.CODE", "text", 15, true),
  f("CUSTOMER", "C.DESCRIP", "text", 50, false),
  f("PRODTYPE", "T.CODE", "text", 15, true),
  f("PRODTYPE", "T.DESCRIP", "text", 50, false),
  f("PRODTYPE", "T^WC:n", "float", null, false),
  f("PRODUCTS", "P.CODE", "text", 30, true),
  f("PRODUCTS", "P.TYPE", "text", 15, true),
  f("PRODUCTS", "P^WC:n", "float", null, true),
  f("PRODUCTS", "P.DESCRIP", "text", 50, false),
  f("PRODUCTS", "P.CUST", "text", 15, false),
  f("ORDERS", "O.CODE", "text", 30, true),
  f("ORDERS", "O.PROD", "text", 30, true),
  f("ORDERS", "O.CUST", "text", 15, true),
  f("ORDERS", "O^DD:n", "date", null, true),
  f("ORDERS", "O^DQ:n", "integer", null, true),
  f("ORDERS", "O.STATUS", "text", 1, false),
  f("ORDERS", "O.DESCRIP", "text", 50, false),
  f("UPDATE", "U.ORDER", "text", 30, true),
  f("UPDATE", "U.DATE", "date", null, true),
  f("UPDATE", "U.QTY", "integer", null, true),
  f("UPDATE", "U.SECT", "text", 15, false),
  f("UPDATE", "U.LINE", "text", 15, false),
  f("UPDATE", "U.COMPLETE", "integer", null, false),
  f("UPDATE", "U.NOTE", "text", 30, false),
];

/** Order status letters the vendor documents for O.STATUS. */
export const ORDER_STATUSES: readonly { readonly code: string; readonly meaning: string }[] = [
  { code: "F", meaning: "Confirmed order" },
  { code: "P", meaning: "Provisional order" },
  { code: "S", meaning: "Speculative order" },
  { code: "T", meaning: "Transit order" },
];

export type Delimiter = "tab" | "csv";
export type DateFormat = "YYYY-MM-DD" | "DD/MM/YYYY" | "YYYYMMDD";
export type HeaderStyle = "standard" | "compliant";

/** The date format is client import configuration ("one of several date formats as specified in the import configuration"); unconfirmed. */
export const DEFAULT_DATE_FORMAT: DateFormat = "YYYY-MM-DD";
export const DATE_FORMATS: readonly DateFormat[] = ["YYYY-MM-DD", "DD/MM/YYYY", "YYYYMMDD"];

/** Field-name conversion for imports built with the "use compliant import file field names" option (General, "Compliant Field names"). */
export const COMPLIANT_REPLACEMENTS: readonly (readonly [string, string])[] = [
  [".", "1"],
  ["^", "2"],
  ["~", "3"],
  [":", "4"],
];

export function compliantHeader(code: string): string {
  let out = code;
  for (const [from, to] of COMPLIANT_REPLACEMENTS) out = out.split(from).join(to);
  return out;
}

/** The documented file name per file and delimiter (`CUSTOMER.txt` or `CUSTOMER.csv`). */
export function fileName(id: FileId, delimiter: Delimiter): string {
  return `${id}.${delimiter === "tab" ? "txt" : "csv"}`;
}

export function contractFor(file: FileId): readonly ContractField[] {
  return CONTRACT.filter((c) => c.file === file);
}

/** Hard limits applied to every file we read or write, so a runaway input cannot exhaust memory. */
export const LIMITS = {
  /** Rows per exported file. */
  maxExportRows: 5000,
  /** Uploaded return file: bytes and data rows. */
  maxReturnBytes: 256 * 1024,
  maxReturnRows: 2000,
} as const;
