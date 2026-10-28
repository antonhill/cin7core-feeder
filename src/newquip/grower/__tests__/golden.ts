import { emptyDraft, type QuoteDraft } from "../draft";
import { TOPIGS_GROWER_INPUT } from "../fixture";

// A COMPLETE, READY Grower quote used across the tests (synthetic quantities + the synthetic price snapshot).
// Topigs engineering inputs; the estimator supplies every manual-by-design quantity; FORTIS 1.2 (no SKU) is resolved by the
// estimator with a reason; M75 is priced by the estimator; delivery / installation / slat delivery are entered.

export function readyDraft(over: Partial<QuoteDraft> = {}): QuoteDraft {
  const d = emptyDraft();
  return {
    ...d,
    customerName: "Topigs Warden",
    siteName: "Warden Grower House",
    quoteType: "project",
    ...over,
    config: {
      ...structuredClone(TOPIGS_GROWER_INPUT),
      feederVariant: "STANDARD",
      slattedFloorAreaM2: 500,
      penningPigSize: "MEDIUM",
      penningRunningMetresPerRoom: 100,
      estimatorQuantities: { bulk_tank: 1, flex_auger: 1, feeder: 14, cup_drinker: 40, concrete_slat: 700, pvc_door: 4 },
      quantityOverrides: {},
      quantityOverrideReasons: {},
      exclusions: {},
      ...(over.config ?? {}),
    },
    estimator: {
      confirmedMappings: { bulk_tank: "SYSH-2750-3", feeder: "PNQ082", feed_saver_mat: "ERT053", concrete_slat: "NQ1161", pvc_door: "NQ2114" },
      confirmedPackages: ["cup_drinker"],
      charges: { delivery: 250_000, installation: 400_000, concrete_slat_delivery: 36_000 },
      unitPrices: { flex_auger: 150_000 },
      priceResolutions: { led_light: { unitPriceExVat: 900, reason: "FORTIS 1.2 has no SKU yet — estimator price from the supplier's current list" } },
      assumptions: "POC synthetic scenario.",
      ...(over.estimator ?? {}),
    },
  };
}
