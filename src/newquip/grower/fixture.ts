import type { GrowerConfigurationInput, GrowerItemKey } from "./types";

// GOLDEN FIXTURE — the Topigs Warden Grower House (AS.23.4015.07).
//
// INPUT is fact (it is what the historic quotation was based on). HISTORIC is evidence of what was
// quoted — NOT proof of the formula behind it. Tests assert these as references only; they are never
// fed back into the engine as an answer.

export const TOPIGS_GROWER_INPUT: GrowerConfigurationInput = {
  lengthM: 49.5,
  widthM: 14.43,
  rooms: 12,
  totalPens: 20,
  hospitalPens: 2,
  pigsPerRoom: 600,
  selectedFeederType: "CCM",
  selectedDrinkerType: "CUP_NEW",
  selectedFlooringType: "CONCRETE_1200X450X70",
  selectedPenningType: "PP_GREEN_VENTED",
  selectedLightingType: "FORTIS_1_2_5000K",
  // Round 2: these are ESTIMATOR INPUTS. The Topigs slatted area / penning metres are not independently confirmed, so the
  // golden input leaves them unset rather than back-filling them from the historic quote.
  slattedFloorAreaM2: null,
  penningPigSize: null,
  penningRunningMetresPerRoom: null,
  optionalEquipment: {
    controller: false,
    silo_weighing: false,
    control_panel: false,
    emergency_windows: false,
    pad_cooling: false,
    cone_fans: false,
    manure_plug: false,
  },
};

/** Topigs PER-ROOM quantities from the historic quotation (workbook rows 83–98). */
export const TOPIGS_GROWER_HISTORIC: Record<GrowerItemKey, number> = {
  bulk_tank: 1,
  flex_auger: 1,
  feeder: 18,
  feed_saver_mat: 18,
  cup_drinker: 54,
  concrete_slat: 1320,
  // metres of panel (G Posts rows 41–47); the historic quote sold the penning as ONE package (qty 1). Round 2: penning is per running metre.
  penning_package: 244.87,
  led_light: 38,
  pvc_door: 4,
  controller: 0,
  silo_weighing: 0,
  control_panel: 0,
  emergency_windows: 0,
  pad_cooling: 0,
  cone_fans: 0,
  manure_plug: 0,
};

/** Verified derived figure for the golden input (workbook B77). */
export const TOPIGS_FLOOR_AREA_M2 = 714.285;

/**
 * The Topigs historic lighting quantity (38 per room) is a CUSTOMER-SPECIFIC OVERRIDE of the 1-per-25 m² minimum
 * (Sean Round 2 #5: "the farmer wanted more lights"). The golden validation applies it as a VISIBLE override.
 */
export const TOPIGS_LIGHT_OVERRIDE = { quantityOverrides: { led_light: 38 }, quantityOverrideReasons: { led_light: "Customer-specific: farmer asked for more than the 1-per-25 m² minimum (Topigs quote, Sean Round 2 #5)" } } as const;
