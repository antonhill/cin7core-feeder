import type { GrowerConfigurationInput, GrowerItemKey, Hypothesis, OptionalItemKey, QuantityUnit, RuleStatus } from "./types";

// The Grower rule table. ONE entry per generated item. This is where Sean's confirmed rules get plugged
// in: to promote a rule, set `classification: "verified"` and supply `verifiedCompute`. Until then the
// engine never emits a quantity for the item (see calculate.ts → evaluateRule).
//
// Nothing here is a Cin7 SKU — product mapping lives in mapping.ts.

export type RuleMode = "automatic" | "default" | "manual";

/**
 * How a quantity is decided — shown on the read-only Template Detail and used by the readiness review. Distinct from
 * `classification` (how firmly the rule is established): a rule can be fully CONFIRMED and still be a human decision.
 */
export type RuleTreatment =
  | "auto_calculated" //            a confirmed rule produces the quantity
  | "default_with_override" //      a confirmed minimum; upward override allowed, retained visibly, reason required
  | "suggested_estimator_confirm" // a confirmed basis is shown as a SUGGESTION; the estimator confirms the final quantity
  | "estimator_input" //            manual BY DESIGN (Sean): the estimator/rep enters it; not unfinished functionality
  | "engineering_review"; //        optional scope that needs an engineering decision before it has a quantity

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
  treatment: RuleTreatment;
  overrideAllowed: boolean;
  /**
   * The quantity is an ESTIMATOR INPUT by design: it is read from `input.estimatorQuantities[itemKey]` and, once supplied,
   * is a complete value — not an override and not a defect.
   */
  estimatorEntry?: boolean;
  /** A SUGGESTED per-room quantity (display only; never the authoritative quantity). */
  suggested?: (input: GrowerConfigurationInput) => number | null;
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
  defaultCompute?: (input: GrowerConfigurationInput) => number | null;
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

/** CCM feeder capacity — CONFIRMED by Sean Round 2 #2 and the final feedback (45 pigs per CCM feeder). */
export const CCM_FEEDER_CAPACITY_PIGS = 45;
/** Drinker basis — CONFIRMED (15 pigs per drinker). Rounding / per-pen minimum were not supplied, so the result is only a SUGGESTION. */
export const PIGS_PER_DRINKER = 15;
/** Lighting minimum — CONFIRMED (final feedback): minimum lights = ceil(room floor area / 25). A default, not a ceiling. */
export const LIGHTING_MIN_M2_PER_LIGHT = 25;

const SRC = "AS.23.4015.07 - Topigs Warden (Update 2026).xlsm, sheet AS.23.4015.07";

export const GROWER_RULES: GrowerRuleDef[] = [
  {
    id: "GROWER-TANK-001",
    itemKey: "bulk_tank",
    label: "Bulk feed tank",
    sourceInputs: ["pigsPerRoom"],
    classification: "manual",
    mode: "manual",
    treatment: "estimator_input",
    estimatorEntry: true,
    overrideAllowed: true,
    historic: { quantityPerRoom: 1, source: `${SRC} row 83: "13.39t Bulk feed tank (based on 650kg/m³)", qty 1` },
    evidence: "Tank sizing is not a supplied rule (the workbook only says 'based on 650kg/m³'). Per the final POC treatment (tank sizing unless separately confirmed) the estimator selects and enters the tank quantity.",
    confidence: "none",
    seanQuestion: "None for the POC — estimator input by design. (Post-POC: how is tank size chosen, and is it per room or shared?)",
  },
  {
    id: "GROWER-AUGER-001",
    itemKey: "flex_auger",
    label: "M75 feed distribution system",
    sourceInputs: ["lengthM", "rooms"],
    classification: "manual",
    mode: "manual",
    treatment: "estimator_input",
    estimatorEntry: true,
    overrideAllowed: true,
    historic: { quantityPerRoom: 1, source: `${SRC} row 84: "M75 Flex auger system (2 x lines…)", qty 1` },
    evidence: "CONFIRMED (Sean, final feedback): M75 sizing/configuration is a CLIENT PREFERENCE selected manually by experienced reps. This supersedes the earlier expectation that the hidden W/W1 formulas be ported. The estimator enters the number of systems per room and the commercial amount; no formula automation is presented as authoritative.",
    confidence: "high",
    seanQuestion: "None for the POC — ESTIMATOR INPUT by design. (Post-POC option: codify the W/W1 formulas as a suggestion.)",
  },
  {
    id: "GROWER-FEEDER-001",
    itemKey: "feeder",
    label: "CCM feeder (incl. monoflo drinking nipples)",
    sourceInputs: ["totalPens", "hospitalPens", "pigsPerRoom", "selectedFeederType", "feederVariant"],
    classification: "manual",
    mode: "manual",
    treatment: "suggested_estimator_confirm",
    estimatorEntry: true,
    overrideAllowed: true,
    historic: { quantityPerRoom: 18, source: `${SRC} row 85: E85 is the typed constant =18` },
    evidence: `CONFIRMED (Sean): one CCM feeder feeds ${CCM_FEEDER_CAPACITY_PIGS} pigs; the standard product is PNQ082 and PNQ082-WINDOW is the same feeder with the window option (a variant, not a conflicting identity). NOT supplied: whole-feeder rounding and split / hospital-pen behaviour — so the final quantity is confirmed by the estimator and ceil(pigs / ${CCM_FEEDER_CAPACITY_PIGS}) is NOT presented as the engineering rule.`,
    confidence: "high",
    seanQuestion: "Post-POC: exact feeder quantity rounding / split-pen rule.",
    hypothesis: (i) => {
      const perPen = i.totalPens > 0 ? i.pigsPerRoom / i.totalPens : null;
      return {
        expression: `CCM capacity ${CCM_FEEDER_CAPACITY_PIGS} pigs per feeder; average ${perPen == null ? "—" : round2(perPen)} pigs per pen (${i.pigsPerRoom} pigs ÷ ${i.totalPens} pens)`,
        value: null,
        caveat: "Capacity basis only. Rounding and split-pen behaviour were not supplied — the estimator confirms the quantity.",
      };
    },
  },
  {
    id: "GROWER-MAT-001",
    itemKey: "feed_saver_mat",
    label: "Feed saver mat (1m × 1m) under CCM feeder",
    sourceInputs: ["totalPens", "hospitalPens"],
    classification: "provisional",
    mode: "default",
    treatment: "default_with_override",
    overrideAllowed: true,
    historic: { quantityPerRoom: 18, source: `${SRC} row 86: E86 is the formula =E85 (feeder quantity)` },
    evidence: "The workbook links mats to feeders (=E85) and Sean (Round 2 rules #3) confirmed 1 mat per feeder. The default therefore follows the estimator-confirmed feeder quantity and is empty until that is entered. Mats come in different sizes — the 1000 × 1000 mm ERT053 is the only mapped product.",
    confidence: "high",
    seanQuestion: "Post-POC: which mat size applies to which feeder? (1 per feeder is confirmed.)",
    defaultCompute: (i) => i.estimatorQuantities?.feeder ?? i.quantityOverrides?.feeder ?? null,
  },
  {
    id: "GROWER-DRINKER-001",
    itemKey: "cup_drinker",
    label: "Grower cup drinker (incl. 800mm SST pipe & bracket)",
    sourceInputs: ["pigsPerRoom", "selectedDrinkerType"],
    classification: "manual",
    mode: "manual",
    treatment: "suggested_estimator_confirm",
    estimatorEntry: true,
    overrideAllowed: true,
    historic: { quantityPerRoom: 54, source: `${SRC} row 87: E87 is the typed constant 54` },
    evidence: `CONFIRMED (Sean): ${PIGS_PER_DRINKER} pigs per drinker. NOT supplied: rounding, per-pen minimum, hospital / split-pen behaviour. The suggestion is shown beside the field; the estimator confirms the final quantity. The historic Topigs 54 does not prove a formula (600 ÷ ${PIGS_PER_DRINKER} = 40).`,
    confidence: "high",
    seanQuestion: "Post-POC: drinker rounding and per-pen minimum.",
    suggested: (i) => (Number.isFinite(i.pigsPerRoom) ? round2(i.pigsPerRoom / PIGS_PER_DRINKER) : null),
    hypothesis: (i) => {
      const raw = i.pigsPerRoom / PIGS_PER_DRINKER;
      return {
        expression: `${i.pigsPerRoom} pigs ÷ ${PIGS_PER_DRINKER} pigs per drinker = ${round2(raw)} (unrounded)`,
        value: round2(raw),
        caveat: "SUGGESTED only — rounding / per-pen minimum were not supplied. The estimator confirms the quantity.",
      };
    },
  },
  {
    id: "GROWER-SLAT-001",
    itemKey: "concrete_slat",
    label: "Concrete slats 1.2m × 0.45m (incl. crane delivery)",
    sourceInputs: ["slattedFloorAreaM2", "selectedFlooringType"],
    classification: "manual",
    mode: "manual",
    treatment: "estimator_input",
    estimatorEntry: true,
    overrideAllowed: true,
    historic: { quantityPerRoom: 1320, source: `${SRC} row 88: E88 is the typed formula =110*12` },
    evidence: "CONFIRMED (Sean, final feedback): the rep manually enters the required slat quantity. The slatted floor area depends on the farmer's layout (some have no walkways; sizes can be customised), so the quantity is ESTIMATOR INPUT BY DESIGN and is never derived from area. The actual slatted area is kept as context only.",
    confidence: "high",
    seanQuestion: "None — manual by design.",
  },
  {
    id: "GROWER-PEN-001",
    itemKey: "penning_package",
    label: "PP penning (priced per running metre, by pig size)",
    sourceInputs: ["penningPigSize", "penningRunningMetresPerRoom"],
    classification: "verified",
    mode: "manual",
    treatment: "estimator_input",
    overrideAllowed: true,
    unit: "running_metre",
    historic: { quantityPerRoom: 244.87, source: `${SRC} 'G Posts (2)' rows 41–47: 244.87 m of panel for 20 pens (the historic quote sold it as one package, qty 1)` },
    evidence: "CONFIRMED (Sean, final feedback): penning sells at R1,300 (small), R1,500 (medium) and R2,200 (large) per RUNNING METRE ex VAT. Inputs are the pig size and the running metres per room; the commercial line is project running metres × rate. A SKU mapping is a future production concern — not needed for the POC commercial result.",
    confidence: "high",
    seanQuestion: "Post-POC: SKU mapping per pig size and any tier breaks.",
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
    classification: "verified",
    mode: "default",
    treatment: "default_with_override",
    overrideAllowed: true,
    historic: { quantityPerRoom: 38, source: `${SRC} row 97: E97 typed 38 — a CUSTOMER-SPECIFIC override (the farmer wanted more lights)` },
    evidence: `CONFIRMED (Sean, final feedback): minimum lights = ceil(room floor area / ${LIGHTING_MIN_M2_PER_LIGHT}). This is a DEFAULT / SUGGESTED minimum because the customer may request more: the calculated minimum is always retained and visible, an upward override is allowed, and an override reason is required. (Topigs' 38 was such a customer request.)`,
    confidence: "high",
    seanQuestion: "None — confirmed. (Product SKU for FORTIS 1.2 is a separate mapping item.)",
    defaultCompute: (i) => Math.ceil(round2(i.lengthM * i.widthM) / LIGHTING_MIN_M2_PER_LIGHT),
  },
  {
    id: "GROWER-DOOR-001",
    itemKey: "pvc_door",
    label: "PVC SST door (incl. frame)",
    sourceInputs: [],
    classification: "manual",
    mode: "manual",
    treatment: "estimator_input",
    estimatorEntry: true,
    overrideAllowed: true,
    historic: { quantityPerRoom: 4, source: `${SRC} row 98: qty 4 (not in the engineering brief's output list)` },
    evidence: "CONFIRMED (Sean Round 2 #11): selection is ALWAYS MANUAL — the size is in the Cin7 product description, so there is no automatic door-sizing formula. Quantity depends on the client's specification.",
    confidence: "high",
    seanQuestion: "None for the rule (manual by design). Candidate SKUs: NQ2114 / NQ2113 / NQ2112 / NQ2161 / NQ2281 — the estimator chooses by description.",
  },
  ...optionalRules(),
];

function optionalRules(): GrowerRuleDef[] {
  // Ventilation scope is OPTIONAL inside the Grower template (Sean final). AS.03 (a fan-inclusive example) is not in the POC
  // source set, so these stay OPTIONAL + ENGINEERING REVIEW / ESTIMATOR INPUT: no fan quantity or controller rule is invented.
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
    treatment: "engineering_review",
    estimatorEntry: true,
    overrideAllowed: true,
    historic: { quantityPerRoom: 0, source: `${SRC} row ${row}: typed 0 (excluded in the Topigs quote)` },
    evidence: `Optional line, excluded (0) in the historic Grower quote. ${note}`.trim(),
    confidence: "none",
    seanQuestion: `If selected: engineering review, then the estimator enters the ${label.toLowerCase()} quantity (AS.03 not yet ingested).`,
    ...extra,
  });
  return [
    opt(1, "controller", "Thomas-CL1 controller (incl. temperature sensors)", 89, ""),
    opt(2, "silo_weighing", "THOMAS-BF silo weighing (4 load cells, IO board…)", 90, ""),
    opt(3, "control_panel", "Control panel for CL1 & BF", 91, "Workbook: =E89 (follows the controller)."),
    opt(4, "emergency_windows", "Emergency windows (24v RLD winches, power supplies)", 92, "Guide default 6 in D92."),
    opt(5, "pad_cooling", "Sumpless pad cooling (plastic pads, gutters, pumps)", 93, "Guide size 18m × 1.5m × 0.15m in D93. VENTILATION: ENGINEERING REVIEW."),
    opt(6, "cone_fans", '57" fibreglass cone fans (380v)', 94, "Guide default 6 in D94. VENTILATION: ENGINEERING REVIEW — AS.03 (fan-inclusive example) is not in the POC source set."),
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
