import { CONTRACT, type Confidence, type ContractField, type FileId } from "@/rwtsa-demo/fastreact/contract";

/**
 * The visible field-contract matrix: for every vendor field we use or knowingly leave out, where its value comes from, how it is
 * formatted and checked, and how sure we are.
 *
 * Confidence means:
 *  - verified:   the field and the rule are in the vendor page AND the value comes straight from a workbook field.
 *  - proposed:   the field is in the vendor page, but WHICH Toolbox/Cin7 value fills it is Spark's mapping, or a planner supplies it.
 *  - unresolved: the vendor page does not give us what we need (operation external IDs, update data, import configuration).
 *
 * "state": `exported` is always written; `conditional` is written only when its condition holds; `not-mapped` is never written, and the
 * reason says why (no source, or deliberately left to Fast React).
 */

export type SourceLayer = "Cin7 Core" | "Toolbox" | "Local workbook" | "Planner input" | "None";
export type MapState = "exported" | "conditional" | "not-mapped";

export interface MatrixRow {
  readonly file: FileId;
  readonly code: string;
  readonly sourceLayer: SourceLayer;
  readonly sourceField: string;
  readonly destination: "Fast React";
  /** "Mandatory" (vendor bold), "Optional", or a stated condition. */
  readonly required: string;
  readonly transformation: string;
  readonly validation: string;
  readonly evidence: string;
  readonly confidence: Confidence;
  readonly state: MapState;
  /** For not-mapped and conditional rows: why. */
  readonly note: string;
}

function contractOf(file: FileId, code: string): ContractField {
  const c = CONTRACT.find((x) => x.file === file && x.code === code);
  if (!c) throw new Error(`contract field missing: ${file} ${code}`);
  return c;
}

function row(file: FileId, code: string, r: Omit<MatrixRow, "file" | "code" | "destination" | "evidence" | "required"> & { required?: string }): MatrixRow {
  const c = contractOf(file, code);
  return {
    file,
    code,
    destination: "Fast React",
    evidence: c.evidence,
    required: r.required ?? (c.essential ? "Mandatory" : "Optional"),
    sourceLayer: r.sourceLayer,
    sourceField: r.sourceField,
    transformation: r.transformation,
    validation: r.validation,
    confidence: r.confidence,
    state: r.state,
    note: r.note,
  };
}

const TEXT_RULE = "No tab, line break, control character, leading/trailing space or leading = + - @; never altered, only refused";

export const MATRIX: readonly MatrixRow[] = [
  row("CUSTOMER", "C.CODE", {
    sourceLayer: "Local workbook",
    sourceField: "Customers.customer (Cin7 Core customer)",
    transformation: "Distinct customer codes, sorted; contact rows collapse to one customer",
    validation: `Unique ignoring case (Fast React upper-cases text); max 15; ${TEXT_RULE}`,
    confidence: "verified",
    state: "exported",
    note: "",
  }),
  row("CUSTOMER", "C.DESCRIP", { sourceLayer: "None", sourceField: "-", transformation: "-", validation: "-", confidence: "unresolved", state: "not-mapped", note: "The workbook holds one customer name field, already used as the code." }),

  row("PRODTYPE", "T.CODE", {
    sourceLayer: "Planner input",
    sourceField: "Product type chosen per style on the Fast React Exchange page",
    transformation: "Distinct product type codes used by the exported products, sorted",
    validation: `Unique ignoring case; max 15; ${TEXT_RULE}`,
    confidence: "proposed",
    state: "exported",
    note: "The workbook has no product type. The planner states it; none is invented.",
  }),
  row("PRODTYPE", "T.DESCRIP", { sourceLayer: "None", sourceField: "-", transformation: "-", validation: "-", confidence: "unresolved", state: "not-mapped", note: "No source." }),
  row("PRODTYPE", "T^WC:n", {
    sourceLayer: "Planner input",
    sourceField: "Work content per operation external ID (not yet supplied)",
    transformation: "One column per supplied operation external ID, sorted numerically",
    validation: "n is a whole number 1 or more; value is a finite number above zero; every product type has the same operations",
    confidence: "unresolved",
    state: "conditional",
    note: "Written only if operation external IDs are supplied. They have not been provided by the vendor, so none are invented; Fast React must hold work content for each product type.",
  }),

  row("PRODUCTS", "P.CODE", {
    sourceLayer: "Local workbook",
    sourceField: "Items.productionCode (one per style)",
    transformation: "Products referenced by the selected orders, one per style, sorted",
    validation: `Unique ignoring case; max 30; one production code per style; ${TEXT_RULE}`,
    confidence: "proposed",
    state: "exported",
    note: "Taking the production code as Fast React's product code follows the worked example's 'Unique Prod Ref'; the client must confirm.",
  }),
  row("PRODUCTS", "P.TYPE", {
    sourceLayer: "Planner input",
    sourceField: "Product type chosen per style",
    transformation: "As entered",
    validation: `Must be one of the exported product types; max 15; ${TEXT_RULE}`,
    confidence: "proposed",
    state: "exported",
    note: "Fast React sets an unrecognised type to the first type in its list, so a type that does not exist in the client's Fast React would be misfiled silently there: confirm the type list.",
  }),
  row("PRODUCTS", "P^WC:n", {
    sourceLayer: "None",
    sourceField: "-",
    transformation: "Not written",
    validation: "-",
    required: "Mandatory, or inferred from P.TYPE",
    confidence: "unresolved",
    state: "not-mapped",
    note: "The vendor page says work content can be inferred from the product type, so it is omitted. This depends on the product type holding work content in Fast React (operation external IDs not supplied).",
  }),
  row("PRODUCTS", "P.DESCRIP", { sourceLayer: "None", sourceField: "-", transformation: "-", validation: "-", confidence: "unresolved", state: "not-mapped", note: "Items descriptions are per SKU, not per style." }),
  row("PRODUCTS", "P.CUST", { sourceLayer: "None", sourceField: "-", transformation: "-", validation: "-", confidence: "unresolved", state: "not-mapped", note: "The vendor says the customer can be set at order level, and we do." }),

  row("ORDERS", "O.CODE", {
    sourceLayer: "Local workbook",
    sourceField: "ProductionOrders.orderNo",
    transformation: "Selected production orders, sorted by code",
    validation: `Unique ignoring case; max 30; ${TEXT_RULE}`,
    confidence: "verified",
    state: "exported",
    note: "",
  }),
  row("ORDERS", "O.PROD", {
    sourceLayer: "Local workbook",
    sourceField: "ProductionOrders.styleCode -> Items.productionCode",
    transformation: "The order's style resolved to its product code",
    validation: "Must be a product in the PRODUCTS file (Fast React rejects an order whose product is unknown)",
    confidence: "proposed",
    state: "exported",
    note: "",
  }),
  row("ORDERS", "O.CUST", {
    sourceLayer: "Planner input",
    sourceField: "Customer chosen per order from the Customers tab",
    transformation: "As chosen; must match an exported customer ignoring case",
    validation: "Must be a customer in the CUSTOMER file (Fast React rejects an order whose customer is unknown); max 15",
    confidence: "proposed",
    state: "exported",
    note: "The production orders in the workbook carry no customer, so the planner states it; none is inferred.",
  }),
  row("ORDERS", "O^DD:n", {
    sourceLayer: "Planner input",
    sourceField: "Delivery date per order",
    transformation: "Written as O^DD:1 (one delivery per order) in the configured date format",
    validation: "A real calendar date; the list must be sequential from 1 and match O^DQ:n",
    confidence: "proposed",
    state: "exported",
    note: "The production orders carry no delivery date, so the planner states it. The date format is client import configuration and is not confirmed.",
  }),
  row("ORDERS", "O^DQ:n", {
    sourceLayer: "Local workbook",
    sourceField: "ProductionOrders.qty",
    transformation: "Written as O^DQ:1, matching O^DD:1",
    validation: "A whole number above zero",
    confidence: "verified",
    state: "exported",
    note: "",
  }),
  row("ORDERS", "O.STATUS", {
    sourceLayer: "Planner input",
    sourceField: "Order status chosen per order",
    transformation: "F, P, S or T as chosen",
    validation: "One of F, P, S, T; X is never written (it would complete or delete the order in Fast React)",
    confidence: "proposed",
    state: "conditional",
    note: "Written only when every selected order has a status; otherwise omitted for all.",
  }),
  row("ORDERS", "O.DESCRIP", { sourceLayer: "None", sourceField: "-", transformation: "-", validation: "-", confidence: "unresolved", state: "not-mapped", note: "No order description in the workbook." }),

  row("UPDATE", "U.ORDER", {
    sourceLayer: "Toolbox",
    sourceField: "Explicit production update row",
    transformation: "As given; must be an exported order",
    validation: `Max 30; ${TEXT_RULE}`,
    confidence: "unresolved",
    state: "conditional",
    note: "No update data exists in the workbook: actual output originates in Fast React, so the file is not exportable unless explicit update rows are given.",
  }),
  row("UPDATE", "U.DATE", { sourceLayer: "Toolbox", sourceField: "Explicit production update row", transformation: "Configured date format", validation: "A real calendar date", confidence: "unresolved", state: "conditional", note: "As U.ORDER." }),
  row("UPDATE", "U.QTY", { sourceLayer: "Toolbox", sourceField: "Explicit production update row", transformation: "As given", validation: "A whole number, zero or more", confidence: "unresolved", state: "conditional", note: "As U.ORDER." }),
  row("UPDATE", "U.SECT", { sourceLayer: "Toolbox", sourceField: "Explicit production update row", transformation: "As given", validation: "Max 15", confidence: "unresolved", state: "conditional", note: "Compulsory in a multi-section Fast React environment; whether RWTSA is one is not confirmed." }),
  row("UPDATE", "U.LINE", { sourceLayer: "Toolbox", sourceField: "Explicit production update row", transformation: "As given, including any sequence characters", validation: "Max 15", confidence: "unresolved", state: "conditional", note: "As U.SECT." }),
  row("UPDATE", "U.COMPLETE", { sourceLayer: "Toolbox", sourceField: "Explicit production update row", transformation: "0 or 1", validation: "0 or 1", confidence: "unresolved", state: "conditional", note: "As U.SECT." }),
  row("UPDATE", "U.NOTE", { sourceLayer: "None", sourceField: "-", transformation: "-", validation: "-", confidence: "unresolved", state: "not-mapped", note: "Not needed." }),
];

/** Orders-file fields deliberately left to Fast React because it is the scheduling authority. Shown on the page. */
export const SCHEDULING_FIELDS_NOT_WRITTEN: readonly { readonly code: string; readonly why: string }[] = [
  { code: "O^SPB:\"section\"", why: "Planning board allocation. Fast React decides which line runs an order; once allocated it cannot be reallocated by import." },
  { code: "O.APGROUP / O.PRIORITY / O.JIT", why: "Auto-planning and APS controls. Toolbox does not schedule." },
  { code: "O.COMPLETE / O.STATUS X or 9", why: "Would complete or delete orders in Fast React. Never written." },
];

export function matrixFor(file: FileId): readonly MatrixRow[] {
  return MATRIX.filter((m) => m.file === file);
}
