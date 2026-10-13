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
  pigsPerBuilding: 600,
  selectedFeederType: "CCM",
  selectedDrinkerType: "CUP_NEW",
  selectedFlooringType: "CONCRETE_1200X450X70",
  selectedPenningType: "PP_GREEN_VENTED",
  selectedLightingType: "FORTIS_1_2_5000K",
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
  penning_package: 1,
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
