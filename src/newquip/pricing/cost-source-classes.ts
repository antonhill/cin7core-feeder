// COST-SOURCE CLASSIFICATION FOR FREIGHT (no cost figure is held here, only which price source each SKU's supplier price came from).
//
// The engine multiplies a supplier cost by its item category's freight factor. That is right for a supplier-NATIVE cost (a foreign-currency or local supplier price that still has to be landed). It is WRONG for a price that is
// already a landed ZAR figure: freight would be charged twice. Classes, in the order they are decided:
//   1. FOREIGN-CURRENCY supplier-native cost (USD / EUR in Cin7)  -> category freight, once.            [automatic: the record's currency]
//   2. LANDED ZAR REFERENCE (this list)                           -> NO further freight.               [classified below, with the evidence]
//   3. LOCAL ZAR supplier price, freight treatment not established -> existing category freight KEPT (the Manager's setting); the exposure is reported, nothing is silently changed.
//   4. FIXED BUDGET SELLING PRICE (control panel R65,000/R85,000)  -> no freight, no markup (control-panel-interim.ts).
//   5. BUDGET-ONLY LANDED COST BASIS (door BOM, register / UAT basis) -> markup once, no freight (quote-bridge.ts).
// The Master Price List's freight column is an allowance inside its own retail formula, not a verified landed multiplier, so it is NOT used to set any factor.
//
// Class 2 is exactly the SKUs whose supplier price in Cin7 was loaded from NewQuip's Sage Evolution LATEST inventory cost, which Sean confirmed is the LOCAL ZAR LANDED cost (2026-11-17 clarification; Sage export 2026-09-15).
export const LANDED_ZAR_REFERENCE_SKUS: ReadonlyMap<string, string> = new Map([
  ["NQ1060", "Loaded from the Sage Evolution latest cost (the Master list cost is 0)."],
  ["NQ3401", "Loaded from the Sage Evolution latest cost (supplier not on the Master)."],
  ["NQPP1017", "Loaded from the Sage Evolution latest cost (the Master list price is dated 2023)."],
  ["NQ1088", "Loaded from the Sage Evolution latest cost (the Master list price is dated 2021)."],
]);
export const landedZarSkuSet = (): ReadonlySet<string> => new Set(LANDED_ZAR_REFERENCE_SKUS.keys());
