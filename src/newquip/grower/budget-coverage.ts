// BUDGET PRICING COVERAGE (pure; no I/O). One row for each of the 16 Rep-selectable equipment categories: how its quantity is set, how it is priced for a Budget Quotation, whether that pricing is defensible
// today, and, if not, the exact blocker, who owns it and the next action. It READS the existing rules (rules.ts), commercial mappings and the budget basis register; it adds no pricing of its own, so it cannot
// disagree with the engine. The evidence facts below were validated on FACTS_VALIDATED against the live Cin7 supplier read, the ERP cost / price report and Sean's validation workbooks; they are INTERNAL.
// The Rep-facing part of a row (`repSafe`) is a selling-price status and a customer-appropriate sentence only: never a product code, cost, rate or margin.
import { GROWER_ITEM_KEYS, type GrowerItemKey } from "./types";
import { GROWER_RULES } from "./rules";
import { budgetBasisProblems, usableBudgetBasis, type BudgetBasisEntry } from "./budget-basis";

export const FACTS_VALIDATED = "2026-11-18";

export type CoverageState = "READY" | "PROVISIONAL" | "RATE_APPROVAL_REQUIRED" | "SPECIFICATION_REQUIRED" | "NO_PRICE_SOURCE";
export type PriceSourceKind = "cin7_sku" | "provisional_package" | "approved_rate_table" | "approved_budget_basis" | "rep_entered_price" | "none";

/** Where a price could come from today. "current_cin7" = a live Cin7 supplier cost; "approved_rate" = an approved NewQuip rate table; "approved_record" = a supplier quote or product-owner confirmation recorded with an approval; "historical_only" = only dated ERP data (supporting evidence, NOT a current supplier cost); "none". */
export type PriceEvidence = "current_cin7" | "approved_rate" | "approved_record" | "historical_only" | "none";

export interface CoverageRow {
  itemKey: GrowerItemKey;
  label: string;
  quantityRule: string;
  mapping: string;
  priceSource: PriceSourceKind;
  /** THREE separate questions, never collapsed into one "ready": (1) does price evidence exist; (2) can the engine price from it; (3) is a NewQuip-approved price in place right now. */
  priceEvidence: PriceEvidence;
  mechanismSupported: boolean;
  approvedPriceReady: boolean;
  /** INTERNAL: what the evidence is and how old / uncertain (an approved entry's own evidence, or the finding behind the blocker). */
  evidenceNote: string | null;
  state: CoverageState;
  lastValidated: string | null;
  /** INTERNAL (Estimator / Manager): the exact blocker, who owns it and what happens next. null when READY. */
  blocker: string | null;
  owner: string | null;
  nextAction: string | null;
  /** REP-SAFE: selling-price status and a customer-appropriate sentence. */
  repSafe: { status: "priced" | "provisional" | "missing"; explanation: string };
}

interface Facts { mapping: string; priceSource: PriceSourceKind; priceEvidence: PriceEvidence; mechanismSupported: boolean; evidenceNote: string | null; state: CoverageState; blocker: string | null; owner: string | null; nextAction: string | null }

// What the evidence showed for each item on FACTS_VALIDATED. An approved register entry (below) overrides the state; nothing here approves anything.
const FACTS: Record<GrowerItemKey, Facts> = {
  bulk_tank: { mapping: "Source-backed SKU (13.39t silo)", priceSource: "cin7_sku", priceEvidence: "current_cin7", mechanismSupported: true, evidenceNote: null, state: "READY", blocker: null, owner: null, nextAction: null },
  feeder: { mapping: "Source-backed SKU (CCM feeder)", priceSource: "cin7_sku", priceEvidence: "current_cin7", mechanismSupported: true, evidenceNote: null, state: "READY", blocker: null, owner: null, nextAction: null },
  feed_saver_mat: { mapping: "Source-backed SKU", priceSource: "cin7_sku", priceEvidence: "current_cin7", mechanismSupported: true, evidenceNote: null, state: "READY", blocker: null, owner: null, nextAction: null },
  concrete_slat: { mapping: "Source-backed SKU", priceSource: "cin7_sku", priceEvidence: "current_cin7", mechanismSupported: true, evidenceNote: null, state: "READY", blocker: null, owner: null, nextAction: null },
  penning_package: { mapping: "No SKU: running metres x the NewQuip pig-size rate", priceSource: "approved_rate_table", priceEvidence: "approved_rate", mechanismSupported: true, evidenceNote: null, state: "READY", blocker: null, owner: null, nextAction: null },
  cup_drinker: { mapping: "7-part package (source-backed components); NB3542-03 alternative open", priceSource: "provisional_package", priceEvidence: "current_cin7", mechanismSupported: true, evidenceNote: "Component costs are live Cin7 supplier costs; the package itself is not NewQuip-approved.", state: "PROVISIONAL", blocker: "Package definition not confirmed (7 parts vs NB3542-03).", owner: "Sean (NewQuip)", nextAction: "Confirm the cup-drinker package definition." },
  led_light: { mapping: "FERAX luminaire + 3 clips + cable package; FORTIS name open", priceSource: "provisional_package", priceEvidence: "current_cin7", mechanismSupported: true, evidenceNote: "Component costs are live Cin7 supplier costs; the package itself is not NewQuip-approved.", state: "PROVISIONAL", blocker: "Light model, parts per light and product name not confirmed.", owner: "Sean (NewQuip)", nextAction: "Confirm the LED package definition and name." },
  flex_auger: { mapping: "No SKU (M75 system)", priceSource: "rep_entered_price", priceEvidence: "none", mechanismSupported: true, evidenceNote: "No cost source; the price is typed per quotation.", state: "RATE_APPROVAL_REQUIRED", blocker: "No approved M75 budget rate; the price is typed per quotation.", owner: "NewQuip Manager", nextAction: "Agree a standard M75 system price for the Rep to use. The Budget register cannot price the M75 (it is typed per quotation); changing that needs a separate decision." },
  pvc_door: { mapping: "Unmapped. Cin7 candidates NQ2112, NQ2113, NQ2114, NQ2161, NQ2281 (size is in the product name; Sean: selection is always manual)", priceSource: "none", priceEvidence: "current_cin7", mechanismSupported: true, evidenceNote: "Live Cin7 supplier cost exists for NQ2114, NQ2161 and NQ2281, but Cin7 LastSupplied cannot be told apart from a data-load date: the ERP report dates NQ2161 2021-11-04 and NQ2113 2022-03-15. Treat the dates as unverified.", state: "SPECIFICATION_REQUIRED", blocker: "No default Budget door. Live Cin7 supplier cost exists for NQ2114, NQ2161 and NQ2281 only; the ERP report shows NQ2161's cost dated 2021 although Cin7 says last supplied 2026-11-13.", owner: "Sean (NewQuip)", nextAction: "Choose the default Budget door SKU and size, and confirm its cost and date." },
  controller: { mapping: "NewQuip-confirmed Budget default: HO05084000 (CL1 controller without panel); the panel is priced separately", priceSource: "provisional_package", priceEvidence: "none", mechanismSupported: true, evidenceNote: "Mapped. Live Cin7 holds the product with no supplier record and a placeholder average cost, so the line stays unpriced until a supplier cost is approved and loaded.", state: "RATE_APPROVAL_REQUIRED", blocker: "No supplier cost in Cin7 (placeholder average cost only).", owner: "NewQuip", nextAction: "Return the approved cost sheet (Sage latest cost proposed)." },
  silo_weighing: { mapping: "NewQuip-confirmed Budget default: HO05084507 (THOMAS-BF), one per room", priceSource: "provisional_package", priceEvidence: "none", mechanismSupported: true, evidenceNote: "Mapped. Live Cin7 holds the product with no supplier record and a placeholder average cost, so the line stays unpriced. Its Cin7 name says PANEL VERSION: confirm it does not duplicate the separately priced panel.", state: "RATE_APPROVAL_REQUIRED", blocker: "No supplier cost in Cin7; possible panel duplication to confirm.", owner: "NewQuip", nextAction: "Return the approved cost sheet and confirm HO05084507 excludes the control panel." },
  control_panel: { mapping: "Interim NewQuip Budget amount per panel (R85,000 with both CL1 and BF, R65,000 with one), pending the workshop BOM", priceSource: "approved_rate_table", priceEvidence: "approved_rate", mechanismSupported: true, evidenceNote: "NewQuip written interim decision (2026-11-25 handoff). Whether it is a cost or a selling price, VAT and any consumables allowance were not stated, so it is applied as a selling amount ex VAT with no extra markup.", state: "PROVISIONAL", blocker: "Interim amount only: the approver and basis (selling price vs cost, consumables) are not recorded, and the workshop BOM will replace it.", owner: "NewQuip Manager", nextAction: "Record the approver and basis of the interim panel amount; replace it with the workshop standard BOM." },
  emergency_windows: { mapping: "NewQuip-confirmed 11-line package: ERT003 + shared HO08990730/HO08020800 (1 per 2 windows, rounded up) + 8 further parts", priceSource: "provisional_package", priceEvidence: "none", mechanismSupported: true, evidenceNote: "Mapped (full component list from Sean 2026-11-24). The Master Price List holds supplier costs for 10 of the 11 parts; none is in Cin7 yet, so the line stays unpriced until they are loaded.", state: "RATE_APPROVAL_REQUIRED", blocker: "Supplier records for the component parts are not yet in Cin7.", owner: "Spark (load) / NewQuip (approve)", nextAction: "Load the supplier prices in the correction package." },
  pad_cooling: { mapping: "Package built from the system length the Rep enters (NewQuip-confirmed quantity formulas, 2026-11-25)", priceSource: "provisional_package", priceEvidence: "current_cin7", mechanismSupported: true, evidenceNote: "Component costs are live Cin7 supplier costs; the quantities follow NewQuip's confirmed formulas. Labour, travel, food and accommodation are not included.", state: "PROVISIONAL", blocker: "Three readings of the formulas are open (plumbing doubling over 20 m, the cleaning fitting, minimum length) and the Estimator signs the package off.", owner: "Sean (NewQuip)", nextAction: "Confirm the three formula readings." },
  cone_fans: { mapping: "NewQuip-confirmed Budget default: MUG4D14A1M10238 (3-blade M140 cone fan); the Rep enters the quantity", priceSource: "provisional_package", priceEvidence: "none", mechanismSupported: true, evidenceNote: "Mapped. Live Cin7 holds the product with no supplier record. NewQuip's 15% / 20% by-GRV-age markup instruction is not applied until it is confirmed to replace (not add to) the project markup.", state: "RATE_APPROVAL_REQUIRED", blocker: "No supplier cost in Cin7; fan markup reading to confirm.", owner: "NewQuip", nextAction: "Return the approved cost sheet and confirm the fan markup reading." },
  manure_plug: { mapping: "Package MNQ048 = MNQ039 + MNQ040 + MNQ041 (NewQuip-confirmed BOM, 2026-11-25); the Rep enters the quantity", priceSource: "provisional_package", priceEvidence: "current_cin7", mechanismSupported: true, evidenceNote: "Component costs are live Cin7 supplier costs; the BOM is NewQuip-confirmed.", state: "PROVISIONAL", blocker: "The Estimator signs the package off; a component with no Cin7 supplier cost leaves it unpriced.", owner: "Estimator", nextAction: "Confirm the package and quantity at sign-off." },
};

const REP_EXPLANATION: Record<CoverageState, { status: "priced" | "provisional" | "missing"; text: string }> = {
  READY: { status: "priced", text: "Priced." },
  PROVISIONAL: { status: "provisional", text: "Priced provisionally; this may change once NewQuip confirms the product." },
  RATE_APPROVAL_REQUIRED: { status: "missing", text: "NewQuip is confirming the standard price for this item. It shows as 'price to be confirmed' on the Budget." },
  SPECIFICATION_REQUIRED: { status: "missing", text: "NewQuip is confirming the standard product for this item. It shows as 'price to be confirmed' on the Budget." },
  NO_PRICE_SOURCE: { status: "missing", text: "This item cannot be priced yet. It shows as 'price to be confirmed' on the Budget." },
};

function quantityRuleOf(k: GrowerItemKey): string {
  const r = GROWER_RULES.find((x) => x.itemKey === k);
  if (!r) return "Entered by the Rep";
  if (r.mode === "automatic") return "Calculated from the room measurements (approved rule)";
  if (r.mode === "default") return "Suggested from an approved default; the Rep may change it with a reason";
  return k === "penning_package" ? "Running metres entered by the Rep" : "Entered by the Rep. No approved engineering rule.";
}

/** The coverage of every selectable category. `register` defaults to none: pass the active register (the Rep and Manager screens do). Pure. */
export function buildBudgetCoverage(register: readonly BudgetBasisEntry[] | undefined, today: string): CoverageRow[] {
  return GROWER_ITEM_KEYS.map((k) => {
    const f = FACTS[k];
    const label = GROWER_RULES.find((x) => x.itemKey === k)?.label ?? k;
    const entry = usableBudgetBasis(register, k, today);
    const lapsed = (register ?? []).filter((e) => e.itemKey === k && !entry).map((e) => budgetBasisProblems(e, today)).find((p) => p.length > 0);
    const base = { itemKey: k, label, quantityRule: quantityRuleOf(k) };
    const approvedFlag = f.state === "READY"; // "approved and price-ready" only when priced from approved sources today; a provisional package or an empty register is NOT
    if (entry && f.state !== "READY") {
      return { ...base, mapping: entry.kind === "default_sku" ? `Approved Budget default product ${entry.sku} (${entry.specification})` : `Approved Budget rate (${entry.specification}, per ${entry.unit})`, priceSource: "approved_budget_basis" as const, priceEvidence: (entry.evidence.kind === "erp_historical" ? "historical_only" : entry.evidence.kind === "cin7_supplier_cost" && entry.evidence.verified ? "current_cin7" : "approved_record") as PriceEvidence, mechanismSupported: true, approvedPriceReady: true,
        evidenceNote: `${entry.evidence.kind.replace(/_/g, " ")} dated ${entry.evidence.asOf}${entry.evidence.verified ? ", verified" : ", NOT verified"}${entry.evidence.uncertainty ? `. Uncertainty: ${entry.evidence.uncertainty}` : ""}. Approved by ${entry.approval.approvedBy} (${entry.approval.role}), reference ${entry.approval.reference}.`, state: "PROVISIONAL" as const, lastValidated: entry.approval.approvedAt.slice(0, 10),
        blocker: "Budget price rests on an approved allowance, not an Estimator-confirmed product.", owner: "Estimator", nextAction: "Confirm the product and price at Estimator review.", repSafe: { status: "provisional" as const, explanation: REP_EXPLANATION.PROVISIONAL.text } };
    }
    return { ...base, mapping: f.mapping, priceSource: f.priceSource, priceEvidence: f.priceEvidence, mechanismSupported: f.mechanismSupported, approvedPriceReady: approvedFlag, evidenceNote: f.evidenceNote, state: f.state, lastValidated: FACTS_VALIDATED,
      blocker: f.blocker ? `${f.blocker}${lapsed ? ` (An approved entry exists but cannot be used: ${lapsed.join("; ")}.)` : ""}` : null, owner: f.owner, nextAction: f.nextAction,
      repSafe: { status: REP_EXPLANATION[f.state].status, explanation: REP_EXPLANATION[f.state].text } };
  });
}

export function coverageCounts(rows: readonly CoverageRow[]): Record<CoverageState, number> {
  const c: Record<CoverageState, number> = { READY: 0, PROVISIONAL: 0, RATE_APPROVAL_REQUIRED: 0, SPECIFICATION_REQUIRED: 0, NO_PRICE_SOURCE: 0 };
  for (const r of rows) c[r.state] += 1;
  return c;
}

/** The customer-appropriate "what happens next" sentence for an item the Budget cannot price (Rep-safe: no product, cost or rate). Items whose category is priceable but whose line is unpriced for another reason (a missing quantity, a blocker) get the generic sentence. */
export function repNextStepFor(itemKey: GrowerItemKey): string {
  if (itemKey === "pad_cooling") return "Enter the length of one cooling system (metres). The item is priced once the length is entered and the supply prices for every cooling part are confirmed; until then it shows as 'price to be confirmed'.";
  const f = FACTS[itemKey];
  return f && f.state !== "READY" && f.state !== "PROVISIONAL" ? REP_EXPLANATION[f.state].text : "This item shows as 'price to be confirmed' on the Budget until the open point is resolved.";
}
