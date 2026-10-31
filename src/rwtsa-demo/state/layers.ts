import type { ScenarioId } from "@/rwtsa-demo/contracts/fields";

/**
 * Static, brief-derived metadata for the four demonstration scenarios: delivery layer of each capability, the
 * assumptions that apply, and the (not yet built) calculation engine. Nothing here is a result.
 *
 * The brief's scoring rule: every item shown must say which layer delivers it. Items marked `verify` are claimed as
 * native to Cin7 Core or Xero in the brief but have NOT been verified in this repository (owner decision D6: native
 * functionality is demonstrated and verified independently).
 */

export type DeliveryLayer = "CIN7 CORE" | "TOOLBOX" | "XERO" | "FAST REACT / EXTERNAL";
export const DELIVERY_LAYERS: readonly DeliveryLayer[] = ["CIN7 CORE", "TOOLBOX", "XERO", "FAST REACT / EXTERNAL"];

export interface Capability {
  readonly name: string;
  readonly layer: DeliveryLayer;
  /** Native claim not yet verified independently (D6). */
  readonly verify?: boolean;
}

/** Approved = owner-approved decision; Brief = default stated in the requirements brief; Open = unresolved in the brief. */
export type AssumptionStatus = "Approved" | "Brief" | "Open";
export interface Assumption {
  readonly status: AssumptionStatus;
  readonly text: string;
}

export interface ScenarioMeta {
  readonly id: ScenarioId;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly capabilities: readonly Capability[];
  readonly assumptions: readonly Assumption[];
  /** The calculation engine this scenario will use. `implemented: false` is a literal type: PR-2 cannot claim otherwise. */
  readonly engine: { readonly name: string; readonly implemented: false };
}

export const SCENARIOS: readonly ScenarioMeta[] = [
  {
    id: "A",
    slug: "scenario-a",
    title: "Demand planning and Red Flag",
    summary: "Import demand planning to reorder; predictive shortage view with SKU/size to style roll-up.",
    capabilities: [
      { name: "Stock, committed quantities and open purchase orders (source records)", layer: "CIN7 CORE", verify: true },
      { name: "Weekly stock projection, first breach week, shortfall, months of cover", layer: "TOOLBOX" },
      { name: "Demand anomaly flag with planner exclusion and recalculation", layer: "TOOLBOX" },
      { name: "Proposed replenishment quantity", layer: "TOOLBOX" },
    ],
    assumptions: [
      { status: "Approved", text: "Projection starts from Available, which is already net of Committed; committed stock is never deducted twice (configurable, shown on screen)." },
      { status: "Approved", text: "Proposed replenishment quantity = the maximum projected shortfall against the minimum stock level over the selected horizon (never negative)." },
      { status: "Approved", text: "An excluded anomaly month needs a reason and is removed from both the demand total and the observation count (not replaced by the median)." },
      { status: "Brief", text: "Weekly forecast = average monthly demand over the window / 4.345 (default window 6 months, configurable)." },
      { status: "Brief", text: "Anomaly rule: a month above 5 x the SKU median and above 40 units is flagged (both configurable)." },
      { status: "Brief", text: "A tender or customer-order-only SKU carries no standing reorder level and does not drive replenishment." },
      { status: "Open", text: "Shipments past their ETA but still on the water are treated as overdue and arriving in week 1 (shown as an assumption)." },
      { status: "Open", text: "The forecast window is not yet anchored to the stock-as-at date; the Red Flag engine must do this before forecasting readiness is claimed." },
    ],
    engine: { name: "Red Flag projection engine", implemented: false },
  },
  {
    id: "B",
    slug: "scenario-b",
    title: "Manufacturing and production variance",
    summary: "Style to bill of material to production to cost; production variance; Fast React file exchange.",
    capabilities: [
      { name: "Style bill of material and production orders (source records)", layer: "CIN7 CORE", verify: true },
      { name: "Per-size product cost roll-up and unbundled cut-make-trim lines", layer: "TOOLBOX" },
      { name: "Production variance by order-size bracket, line and style", layer: "TOOLBOX" },
      { name: "Outbound files CUSTOMER, PRODTYPE, PRODUCTS, ORDERS, UPDATE and a Spark-proposed return file", layer: "FAST REACT / EXTERNAL" },
    ],
    assumptions: [
      { status: "Brief", text: "Cost = materials + trims + thread + labour (SMV x cost per minute) + print + packaging; selling price = cost x 1.6." },
      { status: "Brief", text: "Labour recovery % = planned minutes / actual minutes, aggregated as total planned over total actual." },
      { status: "Open", text: "The meaning of the overhead, efficiency and margin columns in Routing_SMV is unconfirmed until the workbook is inspected locally." },
      { status: "Open", text: "Fast React's return-file layout, external IDs, date format, delete synchronisation and update direction are unknown; any return file is a Spark proposal, not a vendor specification." },
      { status: "Open", text: "Whether Cin7 Core's family BOM variation mapping supports a size-dependent component must be verified independently (D6)." },
    ],
    engine: { name: "Variance, BOM costing and Fast React exchange engines", implemented: false },
  },
  {
    id: "C",
    slug: "scenario-c",
    title: "Imports and foreign currency",
    summary: "Landed cost, forward cover (FEC), supplier payments and USD exposure.",
    capabilities: [
      { name: "Foreign-currency purchase orders and receipts (source records)", layer: "CIN7 CORE", verify: true },
      { name: "Shipment-specific landed cost with freight allocated by CBM share", layer: "TOOLBOX" },
      { name: "USD exposure by due date and per-shipment FX variance", layer: "TOOLBOX" },
      { name: "USD bills at the contracted FEC rate, deposit as prepayment, USD aged payables", layer: "XERO", verify: true },
    ],
    assumptions: [
      { status: "Approved", text: "The forward exchange contract (FEC) is a documented configuration: neither Cin7 Core nor Xero has a forward-contract register." },
      { status: "Brief", text: "Landed cost = FOB (ZAR at customs FX) + duty on customs value + shipment freight allocated by CBM share within that shipment only." },
      { status: "Open", text: "The definition of customs value and the duty column semantics are unconfirmed until the workbook is inspected locally." },
      { status: "Open", text: "Cin7 Core's own landed-cost / additional-cost allocation and the Xero features must be verified independently before being claimed (D6)." },
    ],
    engine: { name: "Landed-cost and FX exposure engines", implemented: false },
  },
  {
    id: "D",
    slug: "scenario-d",
    title: "CRM and quote conversion",
    summary: "Quote conversion by representative, customer, product and period; win/loss by reason.",
    capabilities: [
      { name: "Customers, contacts, representatives and quotes (source records)", layer: "CIN7 CORE", verify: true },
      { name: "Conversion by count and by value; win/loss by reason", layer: "TOOLBOX" },
    ],
    assumptions: [
      { status: "Brief", text: "Conversion = won / closed by count and by value; every lost quote needs a reason; the original sales-order number is kept as a reference." },
      { status: "Open", text: "Whether the Quotes tab carries a product dimension is unconfirmed until the workbook is inspected locally." },
    ],
    engine: { name: "Quote conversion analytics engine", implemented: false },
  },
];

export function scenarioById(id: ScenarioId): ScenarioMeta {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error("unknown scenario");
  return s;
}
