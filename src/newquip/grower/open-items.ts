// POC ITEM REGISTER — where every Round 1/2/3 question landed after Sean's FINAL feedback (2026-10-27).
// Source of truth for the decisions is final-feedback.ts and docs/newquip-poc-final-implementation-matrix.md; this register
// only classifies each former open item so the UI never shows a "blocker" for something that is manual BY DESIGN.
//
//   resolved           Sean answered; implemented as the rule.
//   manual_by_design   Sean said the rep/estimator decides. Not unfinished functionality, not a defect once supplied.
//   post_poc           a genuine production concern that does not block the POC commercial result.

export type PocItemDisposition = "resolved" | "manual_by_design" | "post_poc";

export interface PocItem {
  n: number;
  topic: string;
  disposition: PocItemDisposition;
  /** What the POC does. */
  treatment: string;
}

export const POC_ITEM_REGISTER: PocItem[] = [
  { n: 1, topic: "Project pricing", disposition: "resolved", treatment: "Project = landed cost + 20% (landed = Cost × ROE × Freight). Workbook Retail MU is NOT applied on top." },
  { n: 2, topic: "Price source", disposition: "resolved", treatment: "NewQuip Master workbook — POC controlled snapshot (Cin7 holds demo data). Swappable behind pricing-source.ts." },
  { n: 3, topic: "CCM feeder quantity / rounding", disposition: "manual_by_design", treatment: "45-pig capacity shown; the estimator confirms the final quantity. Standard (PNQ082) or window (PNQ082-WINDOW) variant is selectable." },
  { n: 4, topic: "Drinker rounding / minimum", disposition: "manual_by_design", treatment: "15 pigs per drinker shown as a suggestion; the estimator confirms the final quantity." },
  { n: 5, topic: "Slat quantity", disposition: "manual_by_design", treatment: "The rep enters the slat quantity. Slatted area is context only — never converted automatically." },
  { n: 6, topic: "Penning rates", disposition: "resolved", treatment: "R1,300 / R1,500 / R2,200 per running metre (small / medium / large). Priced as running metres × rate; SKU mapping is post-POC." },
  { n: 7, topic: "NQ3132 pricing", disposition: "resolved", treatment: "N/A — supplier quote required. Never priced at zero; the estimator resolves the amount or prices the higher-level M75 solution." },
  { n: 8, topic: "M75 sizing", disposition: "manual_by_design", treatment: "Client preference, selected by experienced reps. Estimator enters the configuration and commercial amount; W/W1 formulas are not ported." },
  { n: 9, topic: "Ventilation scope", disposition: "manual_by_design", treatment: "Optional inside Grower. Engineering review / estimator input until AS.03 (fan-inclusive example) is ingested. No fan or controller rule is invented." },
  { n: 10, topic: "FORTIS 1.2 SKU", disposition: "post_poc", treatment: "No current SKU. The workbook snapshot carries a priced POC line; HNQ7046 (FERAX) is shown as a historic surrogate only and never substituted." },
  { n: 11, topic: "Day-to-day customer price tier", disposition: "post_poc", treatment: "POC uses workbook Retail ex VAT for day-to-day pricing." },
];

/** One-line meaning of "room", shown beside the rooms input. */
export const ROOMS_HELP = "An actual room within a building. All per-room quantities are multiplied by this number; pigs, pens and floor area describe ONE room.";

/** Ventilation scope: optional, engineering review. */
export const VENTILATION_SCOPE_STATUS = "OPTIONAL — ENGINEERING REVIEW / ESTIMATOR INPUT" as const;
