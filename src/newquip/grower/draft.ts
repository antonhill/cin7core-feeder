import type { ChargeKey, EstimatorResolution } from "./quote-bridge";
import type { GrowerConfigurationInput, GrowerItemKey } from "./types";
import type { QuoteType } from "./pricing-source";
import type { CostOverride } from "../quote/margin";
import type { CostEntry } from "@/lib/projects/latest-cost";
import type { UnitBasis } from "@/lib/projects/supplier-price";

// The editable state of one NewQuip Grower quote. Everything in it is an INPUT (engineering inputs from the rep, decisions
// from the estimator); every number the quote shows is recomputed from it by evaluate.ts. Persisted as JSON.

export interface EstimatorState {
  /** Single-SKU product mappings the estimator confirmed (item → SKU). */
  confirmedMappings: Partial<Record<GrowerItemKey, string>>;
  /** Package definitions the estimator confirmed. */
  confirmedPackages: GrowerItemKey[];
  /** Delivery / installation / slat-delivery amounts, ex VAT. */
  charges: Partial<Record<ChargeKey, number | null>>;
  /** Commercial unit prices that are estimator-priced by design (M75: per system), ex VAT. */
  unitPrices: Partial<Record<GrowerItemKey, number | null>>;
  /** Estimator-resolved unit prices for lines the price source cannot price (needs a reason). */
  priceResolutions: Partial<Record<GrowerItemKey, EstimatorResolution>>;
  /** Audited estimator overrides of a line's ESTIMATED COST (reason, who, when). Internal only; never changes a selling price. */
  costOverrides?: Partial<Record<GrowerItemKey | ChargeKey, CostOverride>>;
  /**
   * Physical-SKU costs captured for this estimate (Cin7 latest cost, or an audited manual estimate), keyed by SKU. SERVER-OWNED: a saved draft can never
   * add or change these (see keepServerOwnedCosts); they are written only by the capture / manual-estimate actions, and frozen with the approved quotation.
   */
  physicalCosts?: Record<string, CostEntry>;
  /** SERVER-OWNED, like physicalCosts. The estimator's audited declarations behind the cost estimate: that supplier prices are per stock unit, and an authorised exception that lets an incomplete cost estimate be approved. */
  costBasis?: { unitBasis?: UnitBasis; incompleteAccepted?: { reason: string; by: string; at: string } };
  /** Free-text assumptions that travel with the quote and are frozen in the baseline. */
  assumptions: string;
}

export interface QuoteDraft {
  customerName: string;
  siteName: string;
  quoteType: QuoteType;
  config: GrowerConfigurationInput;
  estimator: EstimatorState;
}

export function emptyEstimatorState(): EstimatorState {
  return { confirmedMappings: {}, confirmedPackages: [], charges: {}, unitPrices: {}, priceResolutions: {}, assumptions: "" };
}

/** A blank draft: numeric inputs are 0 so the engine reports them as missing (DRAFT) rather than guessing. */
export function emptyDraft(): QuoteDraft {
  return {
    customerName: "",
    siteName: "",
    quoteType: "project",
    config: {
      lengthM: 0, widthM: 0, rooms: 1, totalPens: 0, hospitalPens: 0, pigsPerRoom: 0,
      selectedFeederType: "CCM", selectedDrinkerType: "CUP_NEW", selectedFlooringType: "CONCRETE_1200X450X70",
      selectedPenningType: "PP_GREEN_VENTED", selectedLightingType: "FORTIS_1_2_5000K",
      slattedFloorAreaM2: null, penningPigSize: null, penningRunningMetresPerRoom: null, feederVariant: "STANDARD",
      optionalEquipment: { controller: false, silo_weighing: false, control_panel: false, emergency_windows: false, pad_cooling: false, cone_fans: false, manure_plug: false },
      estimatorQuantities: {}, quantityOverrides: {}, quantityOverrideReasons: {}, exclusions: {},
    },
    estimator: emptyEstimatorState(),
  };
}
