import type { GrowerConfigurationInput, GrowerItemKey, Hypothesis, OptionalItemKey, RuleStatus } from "./types";

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
}

const SRC = "AS.23.4015.07 - Topigs Warden (Update 2026).xlsm, sheet AS.23.4015.07";

/** floor() tolerant of binary float error, e.g. 49.5 / 0.45 = 109.99999999999999. */
function tolerantFloor(x: number): number {
  return Math.floor(x + 1e-9);
}

export const GROWER_RULES: GrowerRuleDef[] = [
  {
    id: "GROWER-TANK-001",
    itemKey: "bulk_tank",
    label: "Bulk feed tank",
    sourceInputs: ["pigsPerBuilding"],
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
    evidence: "M75 selected and '2 x lines' in the description; Growers.xlsx lists auger size, length, elbows, drops, tandem, control unit. No BOM breakdown in the quote.",
    confidence: "none",
    seanQuestion: "Which auger size is chosen and why (M55/M75/M90/M130)? What is the Flex package BOM (auger length, elbows, drops, drop tubes, control unit, suspension), and does it scale with building length?",
  },
  {
    id: "GROWER-FEEDER-001",
    itemKey: "feeder",
    label: "CCM feeder (incl. monoflo drinking nipples)",
    sourceInputs: ["totalPens", "hospitalPens", "selectedFeederType"],
    classification: "requires_validation",
    mode: "automatic",
    overrideAllowed: true,
    historic: { quantityPerRoom: 18, source: `${SRC} row 85: E85 is the typed constant =18` },
    evidence: "18 typed as a constant. 20 total pens − 2 hospital pens = 18 matches, but so would other relationships.",
    confidence: "medium",
    seanQuestion: "Is feeders = total pens − hospital pens (one per standard pen)? Do hospital pens ever get a feeder? Is it always one feeder per pen?",
    hypothesis: (i) => ({
      expression: `${i.totalPens} total pens − ${i.hospitalPens} hospital pens`,
      value: i.totalPens - i.hospitalPens,
    }),
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
    evidence: "The workbook itself links mats to feeders (=E85). The relationship is evidenced; the quantity still depends on the unvalidated feeder rule.",
    confidence: "high",
    seanQuestion: "Confirm one mat per feeder always. Is a mat ever omitted (e.g. solid floor / fastening type)?",
    hypothesis: (_i, h) => {
      const f = h("feeder");
      return { expression: "= feeder quantity (workbook formula E86 = E85)", value: f?.value ?? null, caveat: "Inherits the unvalidated feeder rule." };
    },
  },
  {
    id: "GROWER-DRINKER-001",
    itemKey: "cup_drinker",
    label: "Grower cup drinker (incl. 800mm SST pipe & bracket)",
    sourceInputs: ["totalPens", "hospitalPens", "selectedDrinkerType"],
    classification: "requires_validation",
    mode: "automatic",
    overrideAllowed: true,
    historic: { quantityPerRoom: 54, source: `${SRC} row 87: E87 is the typed constant 54` },
    evidence: "54 typed as a constant. 54 = 3 × 18 (the feeder count), but 54 / 20 pens is not an integer, so it is not a per-pen figure.",
    confidence: "low",
    seanQuestion: "How many cup drinkers per pen (or per feeder)? Do hospital pens get a different drinker (the Weaner sheet adds cup drinkers for hospital pens)?",
    hypothesis: (_i, h) => {
      const f = h("feeder");
      return {
        expression: "3 × feeder quantity (observation only: 54 = 3 × 18)",
        value: f?.value == null ? null : 3 * f.value,
        caveat: "Pattern-match on one data point; no source formula.",
      };
    },
  },
  {
    id: "GROWER-SLAT-001",
    itemKey: "concrete_slat",
    label: "Concrete slats 1.2m × 0.45m (incl. crane delivery)",
    sourceInputs: ["lengthM", "widthM", "selectedFlooringType"],
    classification: "requires_validation",
    mode: "automatic",
    overrideAllowed: true,
    historic: { quantityPerRoom: 1320, source: `${SRC} row 88: E88 is the typed formula =110*12` },
    evidence: "=110*12 is typed. floor(49.5 / 0.45) = 110 and floor(14.43 / 1.2) = 12 reproduce it exactly, and 1,320 × 0.54 m² ≈ the 714.3 m² floor area. Strong pattern, but the workbook states no rule.",
    confidence: "medium",
    seanQuestion: "Is slat count = floor(length / 0.45) × floor(width / 1.2)? What of the slatted-area fraction (fully vs partially slatted), walkways, and the pit/wall allowances? Is 1,320 per room or already the whole project?",
    hypothesis: (i) => {
      const along = tolerantFloor(i.lengthM / 0.45);
      const across = tolerantFloor(i.widthM / 1.2);
      return { expression: `floor(${i.lengthM} / 0.45) × floor(${i.widthM} / 1.2) = ${along} × ${across}`, value: along * across };
    },
  },
  {
    id: "GROWER-PEN-001",
    itemKey: "penning_package",
    label: "PP Green 50mm × 0.9m vented penning package (incl. SST posts & fastening)",
    sourceInputs: ["totalPens", "hospitalPens", "selectedPenningType"],
    classification: "requires_validation",
    mode: "manual",
    overrideAllowed: true,
    historic: { quantityPerRoom: 1, source: `${SRC} row 95: qty 1, "(20 pens)"` },
    evidence: "Sold as one package for 20 pens. The 'G Posts' / 'G Penning' sheets build it, but the package contents and layout are not derived anywhere visible.",
    confidence: "none",
    seanQuestion: "What is in a penning package (panels, gates, posts, fastenings per pen)? Does it scale per pen, per row, or per pen layout drawing? Hospital pen handling?",
  },
  {
    id: "GROWER-LIGHT-001",
    itemKey: "led_light",
    label: "FORTIS 1.2 5000K LED light (incl. clips & cable)",
    sourceInputs: ["lengthM", "widthM", "selectedLightingType"],
    classification: "requires_validation",
    mode: "automatic",
    overrideAllowed: true,
    historic: { quantityPerRoom: 38, source: `${SRC} row 97: E97 typed 38; D97 guide formula =B77/14` },
    evidence: "The workbook's own guide cell (floor area / 14) gives 51.0, but 38 was typed. The estimator overrode the guide; the real rule is unknown.",
    confidence: "low",
    seanQuestion: "What is the lighting rule (lux target, m² per fitting, rows/spacing)? Why was 38 used instead of the area/14 guide of 51?",
    hypothesis: (i) => ({
      expression: `floor area ${round2(i.lengthM * i.widthM)} m² ÷ 14 (workbook guide cell D97)`,
      value: round2((i.lengthM * i.widthM) / 14),
      caveat: "CONTRADICTED by the historic quantity (38). Not a usable estimate.",
    }),
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
    evidence: "4 typed. Present in the Topigs quote but not in the brief's 'known output' list — included so the golden case is not silently understated.",
    confidence: "none",
    seanQuestion: "Is the door count a fixed default or derived (e.g. per building end / per pen row)?",
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
    opt(5, "pad_cooling", "Sumpless pad cooling (plastic pads, gutters, pumps)", 93, "Guide size 18m × 1.5m × 0.15m in D93."),
    opt(6, "cone_fans", '57" fibreglass cone fans (380v)', 94, "Guide default 6 in D94."),
    opt(7, "manure_plug", "250mm manure plug (tube, seal, plug w/ breather)", 96, ""),
  ];
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Verified derived-figure rules (no BOM item). Both are proven by formulas in the Topigs workbook. */
export const DERIVED_RULES = {
  floorArea: { id: "GROWER-GEO-001", formula: "floor area = length × width", evidence: `${SRC} cell B77 = A76*B76 (49.5 × 14.43 = 714.285)` },
  roomMultiplier: { id: "GROWER-ROOMS-001", formula: "project quantity = per-room quantity × rooms", evidence: `${SRC} cell P101 = P99*G79 (sum × number of rooms)` },
} as const;
