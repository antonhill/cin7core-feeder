import { GROWER_ITEM_KEYS } from "@/newquip/grower/types";
// Freight categories are the quotation's own item keys. This is only the display label for each; nothing here is a rate.
const LABELS: Record<string, string> = {
  bulk_tank: "Bulk feed tank", flex_auger: "M75 feed distribution system", feeder: "CCM feeder", feed_saver_mat: "Feed saver mat", cup_drinker: "Grower cup drinker", concrete_slat: "Concrete slats",
  penning_package: "Penning", led_light: "LED light", pvc_door: "PVC door", controller: "Controller", silo_weighing: "Silo weighing", control_panel: "Control panel", emergency_windows: "Emergency windows",
  pad_cooling: "Pad cooling", cone_fans: "Cone fans", manure_plug: "Manure plug",
};
export const FREIGHT_CATEGORY_OPTIONS: ReadonlyArray<{ key: string; label: string }> = GROWER_ITEM_KEYS.map((k) => ({ key: k, label: LABELS[k] ?? k }));
export const freightCategoryLabel = (key: string): string => LABELS[key] ?? key;
