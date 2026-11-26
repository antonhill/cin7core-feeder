// INTERIM CONTROL-PANEL BUDGET AMOUNT (NewQuip written decision, relayed in the 2026-11-25 pricing handoff section 4 and confirmed by the owner on 2026-11-25).
// NewQuip permits a manual interim Budget amount while the workshop's representative panel bills of materials are still to come: R85,000 when the room has BOTH the Thomas-CL1 controller and the THOMAS-BF
// weighing, R65,000 when it has only ONE of them. It lets a Budget Quotation be fully priced without waiting for the (60+ configuration) manufacturing BOM catalogue.
//
// Scope and safety:
//   - BUDGET evaluation only (the same provisional path as the other Budget packages) and only on the CURRENT template revision. The Estimator, Manager, hand-off baseline and final quotation are unchanged:
//     a panel stays an Estimator-priced line there, and it is shown to the Rep as PROVISIONAL.
//   - The amount is applied as a SELLING amount ex VAT per panel, with NO further markup, no consumables allowance and no cost behind it. Whether it is a cost or a selling price, and whether 10-15% consumables
//     apply, were not stated: the handoff says no automatic extra markup until that is resolved, so none is added. It is therefore never presented as a verified or approved price.
//   - Nothing is invented: with neither CL1 nor BF selected there is no panel to price and the line stays as it is today.
export const INTERIM_PANEL_BOTH_EX_VAT = 85_000;
export const INTERIM_PANEL_ONE_EX_VAT = 65_000;

export interface PanelSelection { controller: boolean; silo_weighing: boolean }

/** The interim per-panel Budget amount (ex VAT), or null when the room has neither controller nor weighing. */
export function interimPanelRate(sel: PanelSelection | null | undefined): number | null {
  if (!sel) return null;
  if (sel.controller && sel.silo_weighing) return INTERIM_PANEL_BOTH_EX_VAT;
  if (sel.controller || sel.silo_weighing) return INTERIM_PANEL_ONE_EX_VAT;
  return null;
}

export const INTERIM_PANEL_REASON = "NewQuip interim Budget amount for a control panel (CL1 and/or BF), pending the workshop's standard bill of materials.";
export const INTERIM_PANEL_PLAIN = "Provisional: an interim NewQuip allowance for the control panel, to be replaced by the panel's actual bill of materials, so this price may change.";
