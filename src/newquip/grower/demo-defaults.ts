import type { QuoteDraft } from "./draft";
import { emptyDraft } from "./draft";
import { TOPIGS_GROWER_INPUT } from "./fixture";

// DEMO DEFAULTS - the NewQuip demonstration quotation, loadable into the CURRENT editable draft with one click.
//
// SOURCE (not invented): these are the exact inputs of the demonstration quote NQ-Q-0001 ("Test Customer" / "Test Farm 1", created
// 2026-10-27 and taken to MANAGER_APPROVED_FINAL on the hosted NewQuip POC organisation), read back from that quote's saved draft.
// Only the customer name's accidental trailing space was trimmed. Nothing here is a price list: selling prices, costs and margins are
// always recalculated by the existing engine from the workbook snapshot, and the five estimator price resolutions below are exactly the
// "POC MANUAL PRICE OVERRIDE" values that quote used (each with its original reason).
//
// Loading is a PURE REPLACEMENT of the draft's inputs with these constants, so repeating it can never duplicate anything. It touches
// nothing but the draft held in the editor (and it keeps the customer selected on the quotation): it does not save, approve, freeze, create a project or call Cin7. Audited internal cost
// overrides (not part of the demonstration) are preserved.
export const DEMO_DEFAULTS_SOURCE = "Demonstration quote NQ-Q-0001 (Test Customer / Test Farm 1), recovered from its saved draft.";

const OVERRIDE_REASON = "Master workbook has no usable price. Temporary POC estimator value only.";

export const DEMO_DEFAULTS: Readonly<QuoteDraft> = Object.freeze({
  customerName: "Test Customer",
  siteName: "Test Farm 1",
  quoteType: "day_to_day",
  config: {
    lengthM: 49.5, widthM: 14.43, rooms: 12, totalPens: 20, hospitalPens: 2, pigsPerRoom: 600,
    selectedFeederType: "CCM", selectedDrinkerType: "CUP_NEW", selectedFlooringType: "CONCRETE_1200X450X70",
    selectedPenningType: "PP_GREEN_VENTED", selectedLightingType: "FORTIS_1_2_5000K",
    slattedFloorAreaM2: 120, penningPigSize: "SMALL", penningRunningMetresPerRoom: 20, feederVariant: "STANDARD",
    optionalEquipment: { controller: false, silo_weighing: false, control_panel: false, emergency_windows: false, pad_cooling: false, cone_fans: false, manure_plug: false },
    estimatorQuantities: {
      feeder: 18, pvc_door: 2, bulk_tank: 1, cone_fans: 4, controller: 2, flex_auger: 1, cup_drinker: 54, manure_plug: 2,
      pad_cooling: 3, concrete_slat: 1320, control_panel: 2, silo_weighing: 2, emergency_windows: 2,
    },
    quantityOverrides: { led_light: 38, feed_saver_mat: 18 },
    quantityOverrideReasons: { led_light: "Test", feed_saver_mat: "Test" },
    exclusions: {},
  },
  estimator: {
    confirmedMappings: { feeder: "PNQ082", pvc_door: "NQ2114", bulk_tank: "SYSH-2750-3", concrete_slat: "NQ1161", feed_saver_mat: "ERT053" },
    confirmedPackages: ["cup_drinker", "led_light"],
    charges: { delivery: 979_992, installation: 1_200_000, concrete_slat_delivery: 250_000 },
    unitPrices: { flex_auger: 45_000 },
    priceResolutions: {
      pvc_door: { unitPriceExVat: 3000, reason: OVERRIDE_REASON },
      led_light: { unitPriceExVat: 881, reason: OVERRIDE_REASON },
      cup_drinker: { unitPriceExVat: 548, reason: OVERRIDE_REASON },
      concrete_slat: { unitPriceExVat: 203, reason: OVERRIDE_REASON },
      feed_saver_mat: { unitPriceExVat: 919, reason: OVERRIDE_REASON },
    },
    assumptions: "Test",
  },
} as QuoteDraft);

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The groups of the draft that differ from the demonstration, named as the editor shows them. Empty = the draft already is the demo. */
export function demoDifferences(current: QuoteDraft): string[] {
  const d = DEMO_DEFAULTS;
  const out: string[] = [];
  if (current.siteName.trim() !== d.siteName) out.push("Site"); // the customer is never part of the demo (see applyDemoDefaults)
  if (current.quoteType !== d.quoteType) out.push("Pricing basis");
  const { estimatorQuantities: q1, quantityOverrides: o1, quantityOverrideReasons: r1, exclusions: x1, ...room1 } = current.config;
  const { estimatorQuantities: q2, quantityOverrides: o2, quantityOverrideReasons: r2, exclusions: x2, ...room2 } = d.config;
  if (!same(room1, room2)) out.push("Room inputs and system selections");
  if (!same(q1, q2)) out.push("Estimator quantities");
  if (!same(o1, o2) || !same(r1, r2)) out.push("Quantity overrides");
  if (!same(x1, x2)) out.push("Customer exclusions");
  if (!same(current.estimator.confirmedMappings, d.estimator.confirmedMappings) || !same(current.estimator.confirmedPackages, d.estimator.confirmedPackages)) out.push("Confirmed products and packages");
  if (!same(current.estimator.charges, d.estimator.charges)) out.push("Delivery, installation and slat delivery");
  if (!same(current.estimator.unitPrices, d.estimator.unitPrices) || !same(current.estimator.priceResolutions, d.estimator.priceResolutions)) out.push("Estimator prices and overrides");
  if (current.estimator.assumptions !== d.estimator.assumptions) out.push("Assumptions");
  return out;
}

/** True when the draft holds anything beyond a blank one, i.e. loading the demo would REPLACE someone's entries (a confirmation is needed). */
export function hasEntries(current: QuoteDraft): boolean {
  const blank = emptyDraft();
  // The selected customer is kept by the demo load, so it never counts as an entry that would be replaced.
  return !same({ ...current, customerName: "", estimator: { ...current.estimator, costOverrides: undefined } }, { ...blank, customerName: "", estimator: { ...blank.estimator, costOverrides: undefined } });
}

export interface DemoLoad {
  draft: QuoteDraft;
  /** Groups whose values were replaced (empty when the draft already was the demonstration). */
  replaced: string[];
}

/** Returns the draft with the demonstration inputs applied. Pure; the input is not modified; applying twice equals applying once. */
export function applyDemoDefaults(current: QuoteDraft): DemoLoad {
  const replaced = demoDifferences(current);
  const demo = structuredClone(DEMO_DEFAULTS) as QuoteDraft;
  const draft: QuoteDraft = {
    ...demo,
    // The customer the Rep selected is NOT part of the demonstration: it is kept exactly as it is (blank stays blank).
    customerName: current.customerName,
    estimator: { ...demo.estimator, ...(current.estimator.costOverrides ? { costOverrides: structuredClone(current.estimator.costOverrides) } : {}) },
  };
  return { draft, replaced };
}

// ── CONTEXTUAL SAMPLES (UX-006i1) ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The global whole-quote loader is now a Preview-only testing utility. These two fill ONE step of the draft held in the editor and nothing else: they never save, submit, approve, sign off or
// call any server action (the page's live recalculation previews the result as for any edit). Pure; the input is not modified; applying twice equals applying once.

const ROOM_KEYS = ["lengthM", "widthM", "rooms", "totalPens", "hospitalPens", "pigsPerRoom"] as const;
/** What "Load sample measurements" fills: the six room measurements of the Topigs sample. The site name, pricing basis, equipment, quantities and prices are untouched. */
export const SAMPLE_MEASUREMENTS_FILLS = "length, width, number of rooms, total and hospital pens and pigs per room (Topigs sample)";
export function applyMeasurementsSample(current: QuoteDraft): { draft: QuoteDraft; replaced: boolean } {
  const config = { ...current.config };
  for (const k of ROOM_KEYS) (config as Record<string, unknown>)[k] = TOPIGS_GROWER_INPUT[k];
  return { draft: { ...current, config }, replaced: ROOM_KEYS.some((k) => !same(current.config[k], TOPIGS_GROWER_INPUT[k])) };
}
/** True when any room measurement already holds a value that the sample would replace. */
export function hasMeasurementEntries(current: QuoteDraft): boolean {
  const blank = emptyDraft().config;
  return ROOM_KEYS.some((k) => !same(current.config[k], blank[k]) && !same(current.config[k], TOPIGS_GROWER_INPUT[k]));
}

const EQUIPMENT_KEYS = ["selectedFeederType", "selectedDrinkerType", "selectedFlooringType", "selectedPenningType", "selectedLightingType", "slattedFloorAreaM2", "penningPigSize", "penningRunningMetresPerRoom", "feederVariant", "optionalEquipment", "estimatorQuantities", "quantityOverrides", "quantityOverrideReasons", "exclusions"] as const;
/** What "Load recommended configuration" fills: the CONFIG part of the demonstration quote. Charges, the M75 price, assumptions, product mappings and manual prices (Estimator-owned) are NOT touched. */
export const RECOMMENDED_CONFIG_FILLS = "the system selections (including the penning pig size) and optional equipment, and REPLACES every quantity you entered, the quantity overrides and their reasons (the customer exclusions are cleared). It keeps the site, room measurements, charges, M75 price, assumptions, product choices and manual prices";
export function applyRecommendedConfiguration(current: QuoteDraft): { draft: QuoteDraft; replaced: boolean } {
  const config = { ...current.config };
  for (const k of EQUIPMENT_KEYS) (config as Record<string, unknown>)[k] = structuredClone((DEMO_DEFAULTS.config as unknown as Record<string, unknown>)[k]);
  return { draft: { ...current, config }, replaced: EQUIPMENT_KEYS.some((k) => !same((current.config as unknown as Record<string, unknown>)[k], (DEMO_DEFAULTS.config as unknown as Record<string, unknown>)[k])) };
}
/** True when the equipment part of the draft already holds entries that the recommended configuration would replace (a confirmation is needed). */
export function hasEquipmentEntries(current: QuoteDraft): boolean {
  // The WHOLE equipment section is compared: it differs from blank (something is entered) AND from the recommendation (so something would be replaced, including values edited or cleared since the load).
  const pick = (c: unknown) => Object.fromEntries(EQUIPMENT_KEYS.map((k) => [k, (c as Record<string, unknown>)[k]]));
  const cur = pick(current.config);
  return !same(cur, pick(emptyDraft().config)) && !same(cur, pick(DEMO_DEFAULTS.config));
}
