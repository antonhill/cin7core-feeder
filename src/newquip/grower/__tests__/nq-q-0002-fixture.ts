// READ-ONLY regression fixture: NQ-Q-0002's saved configuration and pricing, rebuilt IN MEMORY (nothing here reads or writes the database).
import { emptyDraft, type QuoteDraft } from "../draft";

export const S = (currency: string, e7: number, fm = 1150000) => ({ at: "t", by: "auto", source: "auto", freight: { factorMicro: fm, addOnCents: 0, source: "test" }, costDate: "2026-11-13", costKind: "cin7_auto", currency, supplierId: "s", supplierName: "s", currencySource: "cin7_supplier", nativeUnitCostE7: e7 });

export function nqQ0002(): QuoteDraft {
  const d = emptyDraft();
  return {
    ...d, customerName: "Spark", siteName: "Guide demo site", quoteType: "project" as const,
    config: { ...d.config, rooms: 12, widthM: 14.43, lengthM: 49.5, totalPens: 20, hospitalPens: 2, pigsPerRoom: 600, penningPigSize: "SMALL" as const, slattedFloorAreaM2: 120, penningRunningMetresPerRoom: 20,
      quantityOverrides: { led_light: 38, feed_saver_mat: 18 }, quantityOverrideReasons: { led_light: "Test", feed_saver_mat: "Test" },
      estimatorQuantities: { feeder: 18, pvc_door: 2, bulk_tank: 1, flex_auger: 1, cup_drinker: 54, concrete_slat: 1320 } },
    estimator: { ...d.estimator, charges: { delivery: 15000, installation: 20000, commissioning: 5000, concrete_slat_delivery: 8000 }, unitPrices: { flex_auger: 250000 }, templateRevision: "grower-2026-11" as const,
      pricing: { enabled: true, ruleVersionId: "newquip-supplier-v1", revision: 2, pricingDate: "2026-11-17T20:07:06.462Z", forwardCover: {}, skuPriceOverrides: {}, targetAdjustment: null,
        fxQuotes: { EUR: { asOf: "2026-11-17T11:00:00Z", source: "OXR", rateMicro: 18615387 }, USD: { asOf: "2026-11-17T11:00:00Z", source: "OXR", rateMicro: 16942404 } },
        projectMarkup: { at: "t", by: "auto", reason: "settings", markupBps: 2000 },
        skus: { NYNUT: S("ZAR", 8200000), ERT053: S("EUR", 268440995), NQ1017: S("ZAR", 31400000), NQ1161: S("ZAR", 1880500000), NQ1380: S("ZAR", 1693000000), NQ1386: S("ZAR", 83800000), NQ2784: S("ZAR", 861700000), NQ2886: S("ZAR", 539800000), PNQ082: S("EUR", 3934800000, 1250000), HNQ7046: S("EUR", 257219662), HNQ7088: S("EUR", 9696510), HNQ7093: S("EUR", 5765496), QCA00003: S("USD", 65454755), "SYSH-2750-3": S("USD", 11745100000, 1300000) } } },
  } as never as QuoteDraft;
}
