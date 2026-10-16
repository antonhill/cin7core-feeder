import type { GrowerConfigurationInput, GrowerItemKey, Hypothesis, OptionalItemKey, QuantityUnit, RuleStatus } from "./types";

// The Grower rule table. ONE entry per generated item. This is where Sean's confirmed rules get plugged
// in: to promote a rule, set `classification: "verified"` and supply `verifiedCompute`. Until then the
// engine never emits a quantity for the item (see calculate.ts → evaluateRule).
//
// Nothing here is a Cin7 SKU — product mapping lives in mapping.ts.

export type RuleMode = "automatic" | "default" | "manual";

export interface GrowerRuleDef {
  id: string;
  itemKey: GrowerItemKey;
  label: string;
  /** Present only for optional equipment — the item is 0 unless the flag is on. */
  optionalKey?: OptionalItemKey;
  /** Input fields the rule reads (drives inputsUsed + the register). */
  sourceInputs: (keyof GrowerConfigurationInput)[];
  classification: RuleStatus;
  mode: RuleMode;
  overrideAllowed: boolean;
  /** Topigs PER-ROOM quantity (the historic quotation's figure) + where it came from. */
  historic: { quantityPerRoom: number | null; source: string };
  evidence: string;
  confidence: "high" | "medium" | "low" | "none";
  /** What Sean must confirm — surfaced in the register and the validation checkpoint. */
  seanQuestion: string;
  /** Inferred relationship. Display-only; never priced. */
  hypothesis?: (input: GrowerConfigurationInput, hypothesisOf: (key: GrowerItemKey) => Hypothesis | null) => Hypothesis;
  /** Only set once NewQuip has confirmed the rule. Returns the PER-ROOM quantity. */
  verifiedCompute?: (input: GrowerConfigurationInput) => number;
  /**
   * A confirmed MINIMUM / default. Produces a quantity (basis "system_default") that an estimator or the customer may
   * override — visibly, with a reason. Only for rules whose basis NewQuip has confirmed.
   */
  defaultCompute?: (input: GrowerConfigurationInput) => number;
  /**
   * The quantity is an explicit ESTIMATOR INPUT carried on dedicated input fields (e.g. penning running metres).
   * Returns the PER-ROOM quantity, or null while the estimator has not supplied everything it needs.
   */
  estimatorInput?: (input: GrowerConfigurationInput) => number | null;
  /** What the estimator must still supply when `estimatorInput` returns null. */
  inputRequiredMessage?: (input: GrowerConfigurationInput) => string | null;
  /** Unit of the quantity (default "each"). */
  unit?: QuantityUnit;
}

/** CCM feeder capacity — CONFIRMED by Sean Round 2 #2 ("the CCM feeder which feeds 45 pigs"). */
export const CCM_FEEDER_CAPACITY_PIGS = 45;
/** Drinker basis — CONFIRMED by Sean Round 2 #3 ("The rule is 15 pigs per drinker"). Rounding/minimum NOT confirmed. */
export const PIGS_PER_DRINKER = 15;
/** Lighting minimum — CONFIRMED by Sean Round 2 #5 ("1 per 25 square … the minimum"). */
export const LIGHTING_MIN_M2_PER_LIGHT = 25;
/** Concrete slat 1.2 m × 0.45 m. Used ONLY for a display-only suggestion; the area → units rule is NOT confirmed. */
export const SLAT_AREA_M2 = 1.2 * 0.45;

const SRC = "AS.23.4015.07 - Topigs Warden (Update 2026).xlsm, sheet AS.23.4015.07";

export const GROWER_RULES: GrowerRuleDef[] = [
  {
    id: "GROWER-TANK-001",
    itemKey: "bulk_tank",
    label: "Bulk feed tank",
    sourceInputs: ["pigsPerRoom"],
    classification: "requires_validation",
    mode: "manual",
    overrideAllowed: true,
    historic: { quantityPerRoom: 1, source: `${SRC} row 83: "13.39t Bulk feed tank (based on 650kg/m³)", qty 1` },
    evidence: "Tank size 13.39t typed in D83; label says sizing is 'based on 650kg/m³'. No capacity formula in the workbook.",
    confidence: "none",
    seanQuestion: "How is tank size chosen (days of feed? pigs × daily intake? bulk density 650 kg/m³)? Which silo sizes (2.57/7.61/13.39/19.26/23.5/36.25t) apply to a Grower house, and is the tank per room or shared?",
  },
  {
    id: "GROWER-AUGER-001",
    itemKey: "flex_auger",
    label: "Flex auger system",
    sourceInputs: ["lengthM", "rooms"],
    classification: "requires_validation",
    mode: "manual",
    overrideAllowed: true,
    historic: { quantityPerRoom: 1, source: `${SRC} row 84: "M75 Flex auger system (2 x lines…)", qty 1` },
    evidence: "M75 selected and '2 x lines' in the description. Sean Round 2 #6: M75 pulls from worksheet W (hidden cells K–O) and those formulas are STILL CURRENT, nothing obsolete. The hidden W/W1 formulas are NOT in this repository, so they are not ported here — the quantity stays an estimator entry until they are.",
    confidence: "none",
    seanQuestion: "ROUND 3 / BUILD INPUT: supply the workbook (worksheets W / W1 incl. hidden columns K–O) so the confirmed formulas can be ported verbatim — lines, auger metres, tubes/clamps, bends, drops, drives, supports, control units.",
  },
  {
    id: "GROWER-FEEDER-001",
    itemKey: "feeder",
    label: "CCM feeder (incl. monoflo drinking nipples)",
    sourceInputs: ["totalPens", "hospitalPens", "pigsPerRoom", "selectedFeederType"],
    classification: "requires_validation",
    mode: "manual",
    overrideAllowed: true,
    historic: { quantityPerRoom: 18, source: `${SRC} row 85: E85 is the typed constant =18` },
    evidence: `CONFIRMED (Sean Round 2 #2): feeder quantity depends on the pigs in the pen and how many pigs a feeder feeds; the CCM feeds ${CCM_FEEDER_CAPACITY_PIGS} pigs (PNQ082). NOT confirmed: whole-feeder rounding, split/hospital-pen behaviour — so no quantity is calculated.`,
    confidence: "medium",
    seanQuestion: "ROUND 3 (HIGH): exact CCM feeder quantity / rounding rule — per pen, rounding up or not, and how hospital / split pens are handled.",
    hypothesis: (i) => {
      const perPen = i.totalPens > 0 ? i.pigsPerRoom / i.totalPens : null;
      return {
        expression: `CCM capacity ${CCM_FEEDER_CAPACITY_PIGS} pigs per feeder; average ${perPen == null ? "—" : round2(perPen)} pigs per pen (${i.pigsPerRoom} pigs ÷ ${i.totalPens} pens)`,
        value: null,
        caveat: "Capacity only. Quantity, rounding and split-pen behaviour are NOT confirmed — the estimator enters and confirms the quantity.",
      };
    },
  },
  {
    id: "GROWER-MAT-001",
    itemKey: "feed_saver_mat",
    label: "Feed saver mat (1m × 1m) under CCM feeder",
    sourceInputs: ["totalPens", "hospitalPens"],
    classification: "provisional",
    mode: "automatic",
    overrideAllowed: true,
    historic: { quantityPerRoom: 18, source: `${SRC} row 86: E86 is the formula =E85 (feeder quantity)` },
    evidence: "The workbook itself links mats to feeders (=E85). Sean Round 2 (rules #3): 1 mat per feeder, but mats come in different sizes. The quantity still depends on the unconfirmed feeder quantity.",
    confidence: "high",
    seanQuestion: "Which mat size applies for which feeder? (1 per feeder is confirmed.)",
    hypothesis: (_i, h) => {
      const f = h("feeder");
      return { expression: "= feeder quantity (workbook formula E86 = E85)", value: f?.value ?? null, caveat: "Inherits the unvalidated feeder rule." };
    },
  },
  {
    id: "GROWER-DRINKER-001",
    itemKey: "cup_drinker",
    label: "Grower cup drinker (incl. 800mm SST pipe & bracket)",
    sourceInputs: ["pigsPerRoom", "selectedDrinkerType"],
    classification: "requires_validation",
    mode: "manual",
    overrideAllowed: true,
    historic: { quantityPerRoom: 54, source: `${SRC} row 87: E87 is the typed constant 54` },
    evidence: `CONFIRMED (Sean Round 2 #3): ${PIGS_PER_DRINKER} pigs per drinker. NOT confirmed: rounding, per-pen minimum, hospital / split-pen behaviour. The Topigs figure (54) does not equal ${PIGS_PER_DRINKER}-pigs-per-drinker arithmetic on 600 pigs (40), so the historic number is not evidence of the rule.`,
    confidence: "medium",
    seanQuestion: "ROUND 3 (HIGH): drinker rounding and minimum per pen, and hospital / split-pen behaviour. Why did the Topigs quote use 54 where 600 pigs ÷ 15 = 40?",
    hypothesis: (i) => {
      const raw = i.pigsPerRoom / PIGS_PER_DRINKER;
      return {
        expression: `${i.pigsPerRoom} pigs ÷ ${PIGS_PER_DRINKER} pigs per drinker = ${round2(raw)} (unrounded)`,
        value: round2(raw),
        caveat: "SUGGESTED only — rounding / per-pen minimum / hospital-pen handling are NOT confirmed. The estimator confirms the quantity.",
      };
    },
  },
  {
    id: "GROWER-SLAT-001",
    itemKey: "concrete_slat",
    label: "Concrete slats 1.2m × 0.45m (incl. crane delivery)",
    sourceInputs: ["slattedFloorAreaM2", "selectedFlooringType"],
    classification: "requires_validation",
    mode: "manual",
    overrideAllowed: true,
    historic: { quantityPerRoom: 1320, source: `${SRC} row 88: E88 is the typed formula =110*12` },
    evidence: "CONFIRMED (Sean Round 2 #4): the requirement is driven by the actual SLATTED FLOOR AREA, which depends on the farmer's layout (some have no walkways, sizes can be customised). There is therefore NO universal walkway/footprint-derived slat area. NOT confirmed: area → units conversion, wastage, rounding.",
    confidence: "medium",
    seanQuestion: "ROUND 3 (HIGH): slatted area → number of slats rule, wastage and rounding, and how custom slat sizes are handled.",
    hypothesis: (i) => {
      const a = i.slattedFloorAreaM2;
      if (a == null) return { expression: "Slatted floor area not entered", value: null, caveat: "ESTIMATOR INPUT REQUIRED: enter the slatted floor area for one room." };
      return {
        expression: `${a} m² slatted ÷ ${round2(SLAT_AREA_M2)} m² per 1.2 × 0.45 m slat = ${round2(a / SLAT_AREA_M2)} (unrounded)`,
        value: round2(a / SLAT_AREA_M2),
        caveat: "Arithmetic only. The conversion, wastage and rounding are NOT confirmed — the estimator enters the final quantity.",
      };
    },
  },
  {
    id: "GROWER-PEN-001",
    itemKey: "penning_package",
    label: "PP penning (priced per running metre, by pig size)",
    sourceInputs: ["penningPigSize", "penningRunningMetresPerRoom"],
    classification: "manual",
    mode: "manual",
    overrideAllowed: true,
    unit: "running_metre",
    historic: { quantityPerRoom: 244.87, source: `${SRC} 'G Posts (2)' rows 41–47: 244.87 m of panel for 20 pens (the historic quote sold it as one package, qty 1)` },
    evidence: "CONFIRMED (Sean Round 2 #7): penning is based on RUNNING METRES — not square metres — for each pig size (small / medium / large). A new SKU is opened per size (historic family KNQPP005–008; new sizes get new SKUs). The current rates / products are NOT yet supplied.",
    confidence: "medium",
    seanQuestion: "ROUND 3 (HIGH): current running-metre rate / SKU for each pig size, and any tier breaks.",
    estimatorInput: (i) => (i.penningPigSize && i.penningRunningMetresPerRoom != null && i.penningRunningMetresPerRoom >= 0 ? i.penningRunningMetresPerRoom : null),
    inputRequiredMessage: (i) =>
      !i.penningPigSize && i.penningRunningMetresPerRoom == null ? "Select the pig size and enter the running metres for one room."
        : !i.penningPigSize ? "Select the pig size."
        : i.penningRunningMetresPerRoom == null ? "Enter the running metres for one room."
        : null,
  },
  {
    id: "GROWER-LIGHT-001",
    itemKey: "led_light",
    label: "FORTIS 1.2 5000K LED light (incl. clips & cable)",
    sourceInputs: ["lengthM", "widthM", "selectedLightingType"],
    classification: "provisional",
    mode: "default",
    overrideAllowed: true,
    historic: { quantityPerRoom: 38, source: `${SRC} row 97: E97 typed 38 — a CUSTOMER-SPECIFIC override (the farmer wanted more lights)` },
    evidence: `CONFIRMED (Sean Round 2 #5): the minimum is 1 light per ${LIGHTING_MIN_M2_PER_LIGHT} m²; the customer may ask for more (Topigs' 38 was such a case). Whole lights are taken as the rounded-UP minimum — consistent with Sean's own "about 29" for 714.285 m². The old area ÷ 14 workbook guide is NOT the rule.`,
    confidence: "high",
    seanQuestion: "Confirm whole-light rounding (up) for the minimum. (The 1-per-25 m² minimum itself is confirmed.)",
    defaultCompute: (i) => Math.ceil(round2(i.lengthM * i.widthM) / LIGHTING_MIN_M2_PER_LIGHT),
  },
  {
    id: "GROWER-DOOR-001",
    itemKey: "pvc_door",
    label: "PVC SST door (incl. frame)",
    sourceInputs: [],
    classification: "requires_validation",
    mode: "manual",
    overrideAllowed: true,
    historic: { quantityPerRoom: 4, source: `${SRC} row 98: qty 4 (not in the engineering brief's output list)` },
    evidence: "CONFIRMED (Sean Round 2 #11): selection is ALWAYS MANUAL — the size is in the Cin7 product description, so there is no automatic door-sizing formula. Quantity depends on the client's specification.",
    confidence: "high",
    seanQuestion: "None for the rule (manual by design). Round 1 candidate SKUs: NQ2114 / NQ2113 / NQ2112 / NQ2161 / NQ2281 — the estimator chooses by description.",
  },
  ...optionalRules(),
];

function optionalRules(): GrowerRuleDef[] {
  const opt = (
    n: number,
    itemKey: OptionalItemKey,
    label: string,
    row: number,
    note: string,
    extra: Partial<GrowerRuleDef> = {},
  ): GrowerRuleDef => ({
    id: `GROWER-OPT-${String(n).padStart(3, "0")}`,
    itemKey,
    optionalKey: itemKey,
    label,
    sourceInputs: ["optionalEquipment"],
    classification: "manual",
    mode: "manual",
    overrideAllowed: true,
    historic: { quantityPerRoom: 0, source: `${SRC} row ${row}: typed 0 (excluded in the Topigs quote)` },
    evidence: `Optional line, excluded (0) in the historic Grower quote. ${note}`,
    confidence: "none",
    seanQuestion: `If selected, how is the ${label.toLowerCase()} quantity determined?`,
    ...extra,
  });
  return [
    opt(1, "controller", "Thomas-CL1 controller (incl. temperature sensors)", 89, ""),
    opt(2, "silo_weighing", "THOMAS-BF silo weighing (4 load cells, IO board…)", 90, ""),
    opt(3, "control_panel", "Control panel for CL1 & BF", 91, "Workbook: =E89 (follows the controller)."),
    opt(4, "emergency_windows", "Emergency windows (24v RLD winches, power supplies)", 92, "Guide default 6 in D92."),
    opt(5, "pad_cooling", "Sumpless pad cooling (plastic pads, gutters, pumps)", 93, "Guide size 18m × 1.5m × 0.15m in D93. VENTILATION / COOLING SCOPE: PENDING REFERENCE QUOTE VALIDATION."),
    opt(6, "cone_fans", '57" fibreglass cone fans (380v)', 94, "Guide default 6 in D94. VENTILATION / COOLING SCOPE: PENDING REFERENCE QUOTE VALIDATION (Sean: the earlier Grower quote with fans has not been ingested)."),
    opt(7, "manure_plug", "250mm manure plug (tube, seal, plug w/ breather)", 96, ""),
  ];
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Verified derived-figure rules (no BOM item). Both are proven by formulas in the Topigs workbook. */
export const DERIVED_RULES = {
  floorArea: { id: "GROWER-GEO-001", formula: "floor area = length × width", evidence: `${SRC} cell B77 = A76*B76 (49.5 × 14.43 = 714.285)` },
  roomMultiplier: {
    id: "GROWER-ROOMS-001",
    formula: "project quantity = per-room quantity × number of ROOMS",
    evidence: `${SRC} cell P101 = P99*G79 (sum × number of rooms). CONFIRMED (Sean Round 2 #1): a room is an actual room within a building — Topigs = 6 buildings × 2 rooms = 12 rooms.`,
  },
} as const;
