import { DERIVED_RULES, GROWER_RULES, type GrowerRuleDef } from "./rules";
import type {
  Explanation,
  GeneratedLine,
  GrowerCalculationResult,
  GrowerConfigurationInput,
  GrowerItemKey,
  Hypothesis,
  InputIssue,
  QuantityBasis,
} from "./types";

// Pure, deterministic Grower House calculation. No I/O, no clock, no randomness, no LLM, no React.
// calculateGrowerHouse(input) returns the same result for the same input and does not mutate it.
//
// The core safety property: a quantity is only ever emitted when
//   (a) the rule is classified "verified" AND has a verifiedCompute  → system_calculated, or
//   (b) an estimator supplied an explicit override                     → manual_override, or
//   (c) an optional item is switched off                               → 0, not_selected.
// Every other line has quantity null ("awaiting_validation"). Hypotheses are shown, never priced.

/** The single option per selector the POC has rules for; anything else is an unsupported selection. */
export const SUPPORTED_SELECTIONS = {
  selectedFeederType: "CCM",
  selectedDrinkerType: "CUP_NEW",
  selectedFlooringType: "CONCRETE_1200X450X70",
  selectedPenningType: "PP_GREEN_VENTED",
  selectedLightingType: "FORTIS_1_2_5000K",
} as const;

const ITEM_SELECTOR: Partial<Record<GrowerItemKey, keyof typeof SUPPORTED_SELECTIONS>> = {
  feeder: "selectedFeederType",
  feed_saver_mat: "selectedFeederType",
  cup_drinker: "selectedDrinkerType",
  concrete_slat: "selectedFlooringType",
  penning_package: "selectedPenningType",
  led_light: "selectedLightingType",
};

function checkNumber(
  issues: InputIssue[],
  field: string,
  v: unknown,
  opts: { positive?: boolean; integer?: boolean },
): void {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    issues.push({ field, code: "not_finite", message: `${field} must be a number.` });
    return;
  }
  if (opts.positive && v <= 0) {
    issues.push({ field, code: "not_positive", message: `${field} must be greater than zero.` });
    return;
  }
  if (!opts.positive && v < 0) {
    issues.push({ field, code: "negative", message: `${field} can't be negative.` });
    return;
  }
  if (opts.integer && !Number.isInteger(v)) {
    issues.push({ field, code: "not_integer", message: `${field} must be a whole number.` });
  }
}

export function validateGrowerInput(input: GrowerConfigurationInput): InputIssue[] {
  const issues: InputIssue[] = [];
  checkNumber(issues, "lengthM", input.lengthM, { positive: true });
  checkNumber(issues, "widthM", input.widthM, { positive: true });
  checkNumber(issues, "rooms", input.rooms, { positive: true, integer: true });
  checkNumber(issues, "totalPens", input.totalPens, { positive: true, integer: true });
  checkNumber(issues, "hospitalPens", input.hospitalPens, { integer: true });
  checkNumber(issues, "pigsPerRoom", input.pigsPerRoom, { positive: true, integer: true });
  if (input.slattedFloorAreaM2 != null) checkNumber(issues, "slattedFloorAreaM2", input.slattedFloorAreaM2, { positive: false });
  if (input.penningRunningMetresPerRoom != null) checkNumber(issues, "penningRunningMetresPerRoom", input.penningRunningMetresPerRoom, { positive: false });
  if (input.penningPigSize != null && !["SMALL", "MEDIUM", "LARGE"].includes(input.penningPigSize)) {
    issues.push({ field: "penningPigSize", code: "invalid_pig_size", message: "Pig size must be small, medium or large." });
  }
  if (
    Number.isFinite(input.hospitalPens) &&
    Number.isFinite(input.totalPens) &&
    input.hospitalPens > input.totalPens
  ) {
    issues.push({ field: "hospitalPens", code: "hospital_exceeds_total", message: "Hospital pens can't exceed total pens." });
  }
  for (const [field, supported] of Object.entries(SUPPORTED_SELECTIONS)) {
    const chosen = (input as unknown as Record<string, unknown>)[field];
    if (chosen !== supported) {
      issues.push({
        field,
        code: "unsupported_selection",
        message: `${String(chosen)} has no rule in this POC — only ${supported} is supported.`,
      });
    }
  }
  for (const [key, qty] of Object.entries(input.quantityOverrides ?? {})) {
    if (typeof qty !== "number" || !Number.isFinite(qty) || qty < 0) {
      issues.push({ field: `quantityOverrides.${key}`, code: "negative_override", message: "An override must be a number ≥ 0." });
    }
  }
  return issues;
}

/** Evaluate one rule definition against the input. Exported so a promoted ("verified") rule is testable. */
export function evaluateRule(
  def: GrowerRuleDef,
  input: GrowerConfigurationInput,
  hypothesisOf: (key: GrowerItemKey) => Hypothesis | null = () => null,
): { basis: QuantityBasis; quantityPerRoom: number | null } {
  if (def.optionalKey && !input.optionalEquipment[def.optionalKey]) {
    return { basis: "not_selected", quantityPerRoom: 0 };
  }
  const override = input.quantityOverrides?.[def.itemKey];
  if (def.overrideAllowed && override !== undefined) {
    return { basis: "manual_override", quantityPerRoom: override };
  }
  if (def.classification === "verified" && def.verifiedCompute) {
    return { basis: "system_calculated", quantityPerRoom: def.verifiedCompute(input) };
  }
  // A confirmed minimum/default produces a quantity, but it is labelled a DEFAULT and stays overridable.
  if (def.defaultCompute) {
    return { basis: "system_default", quantityPerRoom: def.defaultCompute(input) };
  }
  // The quantity is itself an explicit estimator input on dedicated fields (e.g. penning running metres).
  const typed = def.estimatorInput?.(input);
  if (typed != null) return { basis: "estimator_input", quantityPerRoom: typed };
  void hypothesisOf;
  return { basis: "awaiting_validation", quantityPerRoom: null };
}

function usedInputs(def: GrowerRuleDef, input: GrowerConfigurationInput): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  for (const k of def.sourceInputs) {
    const v = input[k];
    if (k === "optionalEquipment" && def.optionalKey) out[`optionalEquipment.${def.optionalKey}`] = input.optionalEquipment[def.optionalKey];
    else if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

/** Builds the "Why?" content purely from the line's data. The UI renders this verbatim. */
export function explainLine(line: Omit<GeneratedLine, "explanation">, def: GrowerRuleDef, rooms: number | null): Explanation {
  const hist = line.historicReference.quantityPerRoom;
  const histText =
    hist == null ? "Historic Topigs quantity: none recorded" : `Historic Topigs quantity: ${hist} per room`;
  const inputs = Object.entries(line.inputsUsed).map(([k, v]) => `${k} = ${v}`);

  switch (line.basis) {
    case "system_calculated":
      return {
        kind: "verified",
        headline: `${line.label}: calculated by a verified rule`,
        steps: [
          `Rule ${line.ruleId} (verified)`,
          ...(inputs.length ? [`Inputs: ${inputs.join(", ")}`] : []),
          `Result: ${line.quantityPerRoom} per room × ${rooms} rooms = ${line.projectQuantity}`,
        ],
      };
    case "system_default":
      return {
        kind: "provisional",
        headline: `${line.label}: DEFAULT minimum — an estimator or the customer may override`,
        steps: [
          `Rule ${line.ruleId}: ${def.evidence}`,
          `Default: ${line.quantityPerRoom} per room × ${rooms} rooms = ${line.projectQuantity}`,
          histText,
        ],
      };
    case "estimator_input":
      return {
        kind: "manual",
        headline: `${line.label}: quantity from estimator inputs`,
        steps: [
          `Estimator input: ${line.quantityPerRoom} ${line.unit === "running_metre" ? "running metres" : "units"} per room × ${rooms} rooms = ${line.projectQuantity}`,
          ...(inputs.length ? [`Inputs: ${inputs.join(", ")}`] : []),
          histText,
          `Evidence: ${def.evidence}`,
        ],
      };
    case "manual_override":
      return {
        kind: "manual",
        headline: `${line.label}: quantity entered by an estimator`,
        steps: [
          `Rule ${line.ruleId} is not being applied — a manual override is in effect`,
          `Override: ${line.quantityPerRoom} per room × ${rooms} rooms = ${line.projectQuantity}`,
          line.overrideReason ? `Reason: ${line.overrideReason}` : "Reason: NOT GIVEN — an override needs a reason",
          ...(line.defaultQuantityPerRoom != null ? [`System default retained: ${line.defaultQuantityPerRoom} per room`] : []),
          histText,
          `Rule status: ${def.classification.replace("_", " ")}`,
        ],
      };
    case "not_selected":
      return {
        kind: "not_selected",
        headline: `${line.label}: optional, not selected`,
        steps: [`Switch the option on to include it; its quantity then needs a manual entry (rule ${line.ruleId}).`, histText],
      };
    default: {
      const h = line.hypothesis;
      const steps = [histText];
      if (h) {
        steps.push(`Provisional relationship: ${h.expression}${h.value == null ? "" : ` = ${h.value}`}`);
        if (h.caveat) steps.push(h.caveat);
      } else {
        steps.push("No relationship has been proposed for this item.");
      }
      steps.push(`Evidence: ${def.evidence}`);
      steps.push(def.classification === "provisional" ? "Status: provisional — awaiting NewQuip validation" : "Status: awaiting NewQuip validation");
      return {
        kind: def.classification === "provisional" ? "provisional" : "awaiting",
        headline: `${line.label}: rule awaiting NewQuip validation`,
        steps,
      };
    }
  }
}

export function calculateGrowerHouse(input: GrowerConfigurationInput): GrowerCalculationResult {
  const issues = validateGrowerInput(input);
  const blocking = issues.filter((i) => i.code !== "unsupported_selection");
  if (blocking.length > 0) {
    return { valid: false, issues, derived: { floorAreaM2: null, rooms: null }, lines: [] };
  }

  const floorAreaM2 = input.lengthM * input.widthM;
  const rooms = input.rooms;

  // Hypotheses may chain (mat → feeder), so resolve through a lazy lookup over the rule table.
  const defByItem = new Map(GROWER_RULES.map((d) => [d.itemKey, d]));
  const hypothesisOf = (key: GrowerItemKey): Hypothesis | null => {
    const d = defByItem.get(key);
    return d?.hypothesis ? d.hypothesis(input, hypothesisOf) : null;
  };

  const lines: GeneratedLine[] = [];
  for (const def of GROWER_RULES) {
    const selector = ITEM_SELECTOR[def.itemKey];
    if (selector && input[selector] !== SUPPORTED_SELECTIONS[selector]) continue; // unsupported → no line, issue already raised

    const { basis, quantityPerRoom } = evaluateRule(def, input, hypothesisOf);
    const reason = input.quantityOverrideReasons?.[def.itemKey]?.trim() || null;
    const base = {
      itemKey: def.itemKey,
      label: def.label,
      unit: def.unit ?? ("each" as const),
      defaultQuantityPerRoom: def.defaultCompute ? def.defaultCompute(input) : null,
      overrideReason: basis === "manual_override" ? reason : null,
      inputRequired: basis === "awaiting_validation" ? (def.inputRequiredMessage?.(input) ?? null) : null,
      ruleId: def.id,
      ruleStatus: def.classification,
      basis,
      quantityPerRoom,
      projectQuantity: quantityPerRoom == null ? null : quantityPerRoom * rooms,
      overrideState: basis === "manual_override" ? ("manual_override" as const) : ("none" as const),
      historicReference: { quantityPerRoom: def.historic.quantityPerRoom, source: def.historic.source },
      hypothesis: def.hypothesis && basis === "awaiting_validation" ? def.hypothesis(input, hypothesisOf) : null,
      inputsUsed: usedInputs(def, input),
    };
    lines.push({ ...base, explanation: explainLine(base, def, rooms) });
  }
  return { valid: true, issues, derived: { floorAreaM2, rooms }, lines };
}

export { DERIVED_RULES };
