import { GROWER_TEMPLATE } from "./final-feedback";
import { DERIVED_RULES, GROWER_RULES, type RuleTreatment } from "./rules";
import { commercialMappingFor, MANUAL_COMMERCIAL_LINES } from "./commercial";
import type { GrowerItemKey } from "./types";

// GROWER HOUSE TEMPLATE v1 — the read-only Template Detail model. Derived from the live rule table and mapping definitions so
// it can never drift from what the engine does. This is NOT the future Rules & Templates editor; there is nothing to edit.

export const TREATMENT_LABEL: Record<RuleTreatment | "charge" | "derived", string> = {
  auto_calculated: "Auto-calculated",
  default_with_override: "Default / suggested minimum",
  suggested_estimator_confirm: "Suggested basis — estimator confirms",
  estimator_input: "Estimator input (manual by design)",
  engineering_review: "Optional — engineering review / estimator input",
  charge: "Estimator-entered commercial charge",
  derived: "Derived (verified formula)",
};

export interface TemplateSection {
  n: number;
  name: string;
  required: boolean;
  /** Why an optional/required stance applies. */
  requirementNote: string;
  ruleRefs: string[];
  /** Current rule behaviour, plain words. */
  behaviour: string;
  treatment: keyof typeof TREATMENT_LABEL;
  /** Product / mapping reference (SKU, package, or why none). */
  mappingRef: string;
  overridePolicy: string;
}

const rule = (k: GrowerItemKey) => GROWER_RULES.find((r) => r.itemKey === k)!;
const mapRef = (k: GrowerItemKey): string => {
  const m = commercialMappingFor(k);
  if (!m) return "No product mapping";
  switch (m.kind) {
    case "single": return k === "feeder" ? "PNQ082 (standard) · PNQ082-WINDOW (window option)" : m.recommendedSku;
    case "package": return m.estimatorPriced ? `${m.name} — reference package, priced by the estimator` : `${m.name} package (${m.components.length} components)`;
    case "estimator_priced": return `Priced per ${m.unit} by pig size — SKU mapping is a future production concern`;
    case "unresolved": return `Estimator selects: ${(m.manualSelectionSkus ?? []).join(" / ")}`;
    default: return "—";
  }
};

const REQUIRED_NOTE = "Required by default; may be excluded at the customer's request (reason recorded).";
const OVERRIDE_REQUIRES_REASON = "Override allowed — retained alongside the default, reason required.";

export function growerTemplateSections(): TemplateSection[] {
  const optionalIds = GROWER_RULES.filter((r) => r.optionalKey).map((r) => r.id);
  return [
    { n: 1, name: "Site & Rooms", required: true, requirementNote: "Always required — every per-room quantity multiplies by the room count.", ruleRefs: [DERIVED_RULES.floorArea.id, DERIVED_RULES.roomMultiplier.id], behaviour: "Floor area = length × width. Pigs, pens and area describe ONE room (pigsPerRoom); every per-room quantity × number of rooms.", treatment: "derived", mappingRef: "No product", overridePolicy: "Not applicable — inputs, not quantities." },
    { n: 2, name: "Feeders", required: true, requirementNote: REQUIRED_NOTE, ruleRefs: [rule("feeder").id, rule("feed_saver_mat").id], behaviour: "CCM feeder capacity 45 pigs. Final quantity confirmed by the estimator (rounding / split-pen rule not supplied). Window option is a variant. Feed saver mat follows the feeder quantity (1 per feeder).", treatment: "suggested_estimator_confirm", mappingRef: `${mapRef("feeder")} · mat ${mapRef("feed_saver_mat")}`, overridePolicy: "Estimator enters the quantity (no reason needed — no system value to override). Mat default may be overridden with a reason." },
    { n: 3, name: "Drinkers", required: true, requirementNote: REQUIRED_NOTE, ruleRefs: [rule("cup_drinker").id], behaviour: "15 pigs per drinker shown as a suggestion; the estimator confirms the final quantity.", treatment: "suggested_estimator_confirm", mappingRef: mapRef("cup_drinker"), overridePolicy: "Estimator confirms the quantity; the suggestion stays visible beside it." },
    { n: 4, name: "Slats", required: true, requirementNote: REQUIRED_NOTE, ruleRefs: [rule("concrete_slat").id], behaviour: "The rep enters the required slat quantity. Slatted area is context only — never converted automatically.", treatment: "estimator_input", mappingRef: `${mapRef("concrete_slat")} · delivery is a separate estimator-entered charge`, overridePolicy: "Manual by design — no override concept." },
    { n: 5, name: "Lighting", required: true, requirementNote: REQUIRED_NOTE, ruleRefs: [rule("led_light").id], behaviour: "Minimum lights = ceil(room floor area / 25). A default — the customer may request more.", treatment: "default_with_override", mappingRef: "FORTIS 1.2 5000K — SKU REQUIRED / UNMAPPED (HNQ7046 FERAX is a historic surrogate only, never substituted)", overridePolicy: `${OVERRIDE_REQUIRES_REASON} Downward change is an exclusion, not an override.` },
    { n: 6, name: "M75 Feed Distribution", required: true, requirementNote: REQUIRED_NOTE, ruleRefs: [rule("flex_auger").id, rule("bulk_tank").id], behaviour: "System size is a client preference selected by experienced reps. The estimator enters the number of systems and the commercial price. NQ3132 is N/A / supplier quote required and is never priced at zero. Bulk tank quantity is also estimator-selected.", treatment: "estimator_input", mappingRef: `${mapRef("flex_auger")} · tank ${mapRef("bulk_tank")}`, overridePolicy: "Manual by design — W/W1 formulas are not ported." },
    { n: 7, name: "Penning", required: true, requirementNote: REQUIRED_NOTE, ruleRefs: [rule("penning_package").id], behaviour: "Inputs: pig size + running metres per room. Priced at R1,300 (small) / R1,500 (medium) / R2,200 (large) per running metre ex VAT.", treatment: "estimator_input", mappingRef: mapRef("penning_package"), overridePolicy: "Rate is fixed by pig size; running metres are the estimator's input." },
    { n: 8, name: "Doors", required: true, requirementNote: REQUIRED_NOTE, ruleRefs: [rule("pvc_door").id], behaviour: "Door selection is always manual — the size is in the product description. No sizing formula.", treatment: "estimator_input", mappingRef: mapRef("pvc_door"), overridePolicy: "Manual by design." },
    { n: 9, name: "Ventilation", required: false, requirementNote: "OPTIONAL inside the Grower template (Sean).", ruleRefs: optionalIds, behaviour: "AS.03 contains a fan-inclusive example but is not in the POC source set. Engineering review, then the estimator enters quantities. No fan quantity or controller rule is invented.", treatment: "engineering_review", mappingRef: "No automatic product mapping (pad cooling, cone fans, controller, silo weighing, panel, emergency windows, manure plugs)", overridePolicy: "Estimator input after engineering review." },
    { n: 10, name: "Delivery", required: true, requirementNote: REQUIRED_NOTE, ruleRefs: ["COMMERCIAL-CHARGE-DELIVERY"], behaviour: "Estimator-entered amount (courier invoice: truck size × price; distance affects it). No automatic freight model.", treatment: "charge", mappingRef: "Not a SKU", overridePolicy: "Estimator-entered amount, ex VAT." },
    { n: 11, name: "Installation", required: true, requirementNote: REQUIRED_NOTE, ruleRefs: ["COMMERCIAL-CHARGE-INSTALLATION"], behaviour: "Estimator-entered amount (service reports: days × daily rate). No automatic model.", treatment: "charge", mappingRef: `Not a SKU${MANUAL_COMMERCIAL_LINES.length ? ` (slat delivery charge accompanies slats)` : ""}`, overridePolicy: "Estimator-entered amount, ex VAT." },
  ];
}

export const TEMPLATE_HEADER = {
  name: GROWER_TEMPLATE.name,
  version: GROWER_TEMPLATE.version,
  status: "Active" as const,
  note: "Read-only. Everything in the reference quote is mandatory by default; customer requirements can change it, visibly.",
};
