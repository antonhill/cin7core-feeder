// NEWQUIP-CONFIRMED BUDGET DEFAULT PRODUCTS (written decisions relayed in the 2026-11-25 pricing handoff, sections 2, 3, 5 and 7).
// They fill the EXISTING "Budget default product" slot (the same `budget_default` mapping source the approved register uses): a Budget evaluation with no Estimator-confirmed product uses NewQuip's confirmed
// product PROVISIONALLY, and the normal price source then prices it. They add no price and no cost:
//   - a product whose Cin7 record has no supplier cost stays VISIBLY UNPRICED (it never takes a placeholder or an average cost);
//   - an Estimator's own confirmed mapping or manual price always wins; the Estimator, Manager, baseline and final-quote paths are unchanged;
//   - current template only (a quotation created under the original template is unchanged).
// Cost, markup, freight and age rules are the engine's own and are NOT touched here: in particular the fan's "15% / 20% by GRV age" markup instruction is not applied until NewQuip confirms it replaces (not adds to) the project markup.
import type { GrowerItemKey } from "./types";

export interface ConfirmedBudgetDefault { sku: string; note: string }

export const CONFIRMED_BUDGET_DEFAULTS: Readonly<Partial<Record<GrowerItemKey, ConfirmedBudgetDefault>>> = {
  controller: { sku: "HO05084000", note: "THOMAS-CL1 controller WITHOUT control panel (CAN-IO-7-7 box version). The panel is priced separately, so the with-panel version HO05084007 is never used, which prevents a duplicate panel charge." },
  silo_weighing: { sku: "HO05084507", note: "THOMAS-BF weighing, one per room. Its Cin7 name says 'PANEL VERSION': NewQuip to confirm it does not already include the control panel that is priced separately." },
  emergency_windows: { sku: "ERT003", note: "Emergency window 1500 x 700 mm with motor, one per room by default (Rep may change). Its other components (shared HO08990730 and HO08020800, one per two windows) are priced once NewQuip's component list is received." },
  cone_fans: { sku: "MUG4D14A1M10238", note: "57-inch cone fan, the 3-blade M140 fan (the 6-blade MUG4D14A0M10238 is a different product). Quantity is entered by the Rep." },
};

export const confirmedBudgetDefaultSku = (k: GrowerItemKey): string | null => CONFIRMED_BUDGET_DEFAULTS[k]?.sku ?? null;
