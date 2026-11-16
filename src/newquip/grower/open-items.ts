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
  /** The wording for a viewer who may NOT see cost: used instead of `treatment` when the treatment names a supplied cost, cost basis or supplier figure. */
  repTreatment?: string;
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
  { n: 10, topic: "Grower LED lighting", disposition: "resolved", treatment: "Sean (2026-11) confirmed HNQ7046 (FERAX 24W luminaire), HNQ7093 (clip, 3 per light) and HNQ7088 (cable, 1 per light), replacing the revolving-light and light-trap SKUs. The per-light quantities are the historic FERAX build-up and the customer-facing name still says FORTIS 1.2, so the Estimator confirms the package and its description." },
  { n: 11, topic: "Day-to-day customer price tier", disposition: "post_poc", treatment: "POC uses workbook Retail ex VAT for day-to-day pricing." },
  { n: 12, topic: "Penning components", disposition: "manual_by_design", treatment: "Sean's fifteen 50 mm-panel components (caps, gate kit, door / gate / starter / support / centre / Z-section posts) are listed for estimating and handover with NO calculated quantity: post spacing, openings, cutting and wastage are not supplied, so each is an Estimator decision. Panels are custom sizes created in Cin7 at order, so they are a specification, not a SKU. The price stays running metres × the approved rate." },
  { n: 13, topic: "M75 drop kit and support post", disposition: "manual_by_design", treatment: "NQ1942 is the complete drop kit (a figure was supplied: a component reference only); NQ1984 is excluded. The drop tube is NQ.TUBE.63 (Sean) or NQ.TUBE.75 (Master): not chosen until NewQuip says which, and NQ.TUBE.63 is verified live in Cin7. NQ3132 (the drive unit) stays a supplier-quote exception. The support post is KNQ050-900, replacing NQ2601. The M75 system price remains an Estimator input.", repTreatment: "M75 drop kit and support post products have been confirmed; the drop tube size and the drive unit are still with the Estimator. The M75 system price is entered by the Estimator." },
  { n: 14, topic: "PVC door", disposition: "manual_by_design", treatment: "NQ3444 is proposed (Cin7: PVC SINGLE DOORS, no size stated) and replaces NQ2112 / NQ2113 / NQ2114. The Estimator confirms the door and size. A figure was supplied for it: recorded as a reference, not a price, no markup applied, basis not stated.", repTreatment: "NQ3444 is proposed as the door and replaces three earlier door products. The Estimator confirms the door and its size." },
  { n: 15, topic: "Auger unit", disposition: "manual_by_design", treatment: "The auger (NQ1163) is quoted and costed per METRE. The quantity is its length in metres, never a count of systems. The supplied per-metre figure is a reference: Cin7 reports the unit as Item and holds its own cost, and no conversion between them is established.", repTreatment: "The auger is quoted per metre: the quantity is its length in metres, never a count of systems." },
  { n: 16, topic: "Included and excluded products", disposition: "resolved", treatment: "NQ1984 is excluded and never offered. PNQ002 (feeder) and SYSH-2750-4 (tank; Cin7 still says DONT QUOTE) are Estimator choices within their own lines: never automatic, never an extra line." },
  { n: 17, topic: "Supplied cost figures", disposition: "post_poc", treatment: "Figures from Sean / Tereesha (NQ1764, NQ1017, NYNUT, NQ1942, NQ.TUBE.63, NQ3444, NQ1163) are references compared with Cin7 on the cost survey. Cin7 stays the cost authority; a different figure is a proposed override until its basis and date are established.", repTreatment: "Some product figures supplied by NewQuip are being reconciled by the Estimator. They do not change the price you see until they are confirmed." },
  { n: 18, topic: "Foreign exchange policy", disposition: "post_poc", treatment: "Sean: the Estimator uses the rate on the day of quoting; the answer also mentions a 90-day rate and RMB rates. Not yet clear whether that is a 90-day average or a forward rate, or why RMB when Cin7 holds EUR and USD suppliers. Unchanged here: the existing FX calculation and freshness controls apply.", repTreatment: "Currency conversion policy is being confirmed by NewQuip. It does not change the price you see." },
];

/** One-line meaning of "room", shown beside the rooms input. */
export const ROOMS_HELP = "An actual room within a building. All per-room quantities are multiplied by this number; pigs, pens and floor area describe ONE room.";

/** Ventilation scope: optional, engineering review. */
export const VENTILATION_SCOPE_STATUS = "OPTIONAL — ENGINEERING REVIEW / ESTIMATOR INPUT" as const;

/** The register as a given viewer may see it: without cost visibility the cost-basis wording of item 1 is replaced by a neutral statement (server-side; nothing to hide client-side). */
export function pocItemRegisterFor(canSeeCost: boolean): PocItem[] {
  if (canSeeCost) return POC_ITEM_REGISTER;
  return POC_ITEM_REGISTER.map((i) => (i.n === 1 ? { ...i, treatment: "Project pricing follows the approved project price basis. The workbook Retail price is not applied on top." } : i.repTreatment ? { ...i, treatment: i.repTreatment } : i)).map(({ repTreatment: _omit, ...i }) => i);
}
