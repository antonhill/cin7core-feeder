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
/** Penning is priced per RUNNING METRE and the rate depends on the pig size (Sean Round 2 #7). */
export type PenningPigSize = "SMALL" | "MEDIUM" | "LARGE";

export interface GrowerConfigurationInput {
  lengthM: number;
  widthM: number;
  /**
   * Number of actual ROOMS within the buildings — the multiplier for every per-room BOM quantity
   * (Sean Round 2 #1: "an actual room within the building"; Topigs = 6 buildings × 2 rooms = 12 rooms).
   * lengthM / widthM / pens / pigs below describe ONE room.
   */
  rooms: number;
  totalPens: number;
  hospitalPens: number;
  /**
   * Pigs in ONE room. Sean's sheet calls this "Pigs / building ±600" but the reference unit is a room (20 pens × 30 = 600),
   * so it is treated as per-room. Used only for display-only suggestions (feeder capacity, drinkers) — never to price.
   */
  pigsPerRoom: number;
  selectedFeederType: FeederType;
  selectedDrinkerType: DrinkerType;
  selectedFlooringType: FlooringType;
  selectedPenningType: PenningType;
  selectedLightingType: LightingType;
  /** ESTIMATOR INPUT: actual slatted floor area of ONE room in m². Layouts vary (some houses have no walkways); never derived. */
  slattedFloorAreaM2?: number | null;
  /** ESTIMATOR INPUT: pig size the penning is for. */
  penningPigSize?: PenningPigSize | null;
  /** ESTIMATOR INPUT: penning RUNNING METRES for ONE room (not m²). */
  penningRunningMetresPerRoom?: number | null;
  optionalEquipment: Record<OptionalItemKey, boolean>;
  /** Estimator-entered PER-ROOM quantities. The only way a requires_validation line gets a quantity. */
  quantityOverrides?: Partial<Record<GrowerItemKey, number>>;
  /** Why each override was entered (Sean Round 1: "Yes and they must give a reason"). A missing reason is flagged, not defaulted. */
  quantityOverrideReasons?: Partial<Record<GrowerItemKey, string>>;
}

export type InputIssueCode =
  | "not_finite"
  | "not_positive"
  | "negative"
  | "not_integer"
  | "hospital_exceeds_total"
  | "unsupported_selection"
  | "negative_override"
  | "invalid_pig_size";

export interface InputIssue {
  field: string;
  code: InputIssueCode;
  message: string;
}

export type QuantityBasis =
  | "system_calculated" // a verified rule produced it
  | "system_default" // a confirmed MINIMUM/default produced it; an estimator/customer may override (visibly)
  | "estimator_input" // the quantity IS an explicit estimator input (e.g. penning running metres)
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

export type QuantityUnit = "each" | "running_metre";

export interface GeneratedLine {
  itemKey: GrowerItemKey;
  label: string;
  unit: QuantityUnit;
  ruleId: string;
  ruleStatus: RuleStatus;
  basis: QuantityBasis;
  /** SYSTEM CALCULATED or manual — null means "do not show a confident quantity". */
  quantityPerRoom: number | null;
  projectQuantity: number | null;
  overrideState: "none" | "manual_override";
  /** The system default/minimum for this line, retained even while overridden (null when the rule has none). */
  defaultQuantityPerRoom: number | null;
  /** Reason an estimator gave for an override; null if none was given (flagged by the budget). */
  overrideReason: string | null;
  /** What the estimator must supply before this line can have a quantity (null when nothing is outstanding). */
  inputRequired: string | null;
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
