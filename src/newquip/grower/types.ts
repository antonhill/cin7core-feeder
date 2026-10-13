// Typed model for the NewQuip Grower House configurator POC.
//
// STATUS VOCABULARY (never promote without evidence — see docs/newquip-grower-poc-rule-register.md):
//   verified              proven by source material AND safe to compute
//   provisional           relationship evidenced in source material but not confirmed by NewQuip
//   manual                an estimator decision, not a formula
//   requires_validation   inferred only; NewQuip (Sean) must confirm before any quantity is trusted

export type RuleStatus = "verified" | "provisional" | "manual" | "requires_validation";

/** Items the Grower House can generate. Engineering identity only — never a Cin7 SKU. */
export type GrowerItemKey =
  | "bulk_tank"
  | "flex_auger"
  | "feeder"
  | "feed_saver_mat"
  | "cup_drinker"
  | "concrete_slat"
  | "penning_package"
  | "led_light"
  | "pvc_door"
  | "controller"
  | "silo_weighing"
  | "control_panel"
  | "emergency_windows"
  | "pad_cooling"
  | "cone_fans"
  | "manure_plug";

export type OptionalItemKey =
  | "controller"
  | "silo_weighing"
  | "control_panel"
  | "emergency_windows"
  | "pad_cooling"
  | "cone_fans"
  | "manure_plug";

export type FeederType = "CCM" | "CAWI";
export type DrinkerType = "CUP_NEW" | "PIGBITE";
export type FlooringType = "CONCRETE_1200X450X70" | "PLASTIC_SOW_SLAT";
export type PenningType = "PP_GREEN_VENTED" | "PP_BLACK_SOLID";
export type LightingType = "FORTIS_1_2_5000K" | "OTHER";

export interface GrowerConfigurationInput {
  lengthM: number;
  widthM: number;
  /** Number of identical "rooms" the per-room BOM is multiplied by (Topigs workbook P101 = P99 × rooms). */
  rooms: number;
  totalPens: number;
  hospitalPens: number;
  pigsPerBuilding: number;
  selectedFeederType: FeederType;
  selectedDrinkerType: DrinkerType;
  selectedFlooringType: FlooringType;
  selectedPenningType: PenningType;
  selectedLightingType: LightingType;
  optionalEquipment: Record<OptionalItemKey, boolean>;
  /** Estimator-entered PER-ROOM quantities. The only way a requires_validation line gets a quantity. */
  quantityOverrides?: Partial<Record<GrowerItemKey, number>>;
}

export type InputIssueCode =
  | "not_finite"
  | "not_positive"
  | "negative"
  | "not_integer"
  | "hospital_exceeds_total"
  | "unsupported_selection"
  | "negative_override";

export interface InputIssue {
  field: string;
  code: InputIssueCode;
  message: string;
}

export type QuantityBasis =
  | "system_calculated" // a verified rule produced it
  | "manual_override" // an estimator typed it
  | "awaiting_validation" // no trustworthy quantity exists
  | "not_selected"; // optional item switched off → 0

export interface Hypothesis {
  /** Human-readable working, e.g. "20 total pens − 2 hospital pens". */
  expression: string;
  /** null when it cannot be evaluated (e.g. depends on another unvalidated quantity). */
  value: number | null;
  /** Shown to the user — the hypothesis is NEVER used to price anything. */
  caveat?: string;
}

export interface HistoricReference {
  /** Topigs per-room quantity, or null when the historic quotation had no numeric figure. */
  quantityPerRoom: number | null;
  source: string;
}

export interface Explanation {
  kind: "verified" | "provisional" | "awaiting" | "manual" | "not_selected";
  headline: string;
  /** Ordered, display-ready lines. Built from rule data by explainLine(), never hand-written in the UI. */
  steps: string[];
}

export interface GeneratedLine {
  itemKey: GrowerItemKey;
  label: string;
  ruleId: string;
  ruleStatus: RuleStatus;
  basis: QuantityBasis;
  /** SYSTEM CALCULATED or manual — null means "do not show a confident quantity". */
  quantityPerRoom: number | null;
  projectQuantity: number | null;
  overrideState: "none" | "manual_override";
  historicReference: HistoricReference;
  hypothesis: Hypothesis | null;
  inputsUsed: Record<string, number | string | boolean>;
  explanation: Explanation;
}

export interface GrowerCalculationResult {
  valid: boolean;
  issues: InputIssue[];
  /** Verified derived figures (building floor area etc.). */
  derived: { floorAreaM2: number | null; rooms: number | null };
  lines: GeneratedLine[];
}
