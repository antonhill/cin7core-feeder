import type { GrowerItemKey } from "./types";

// COMMERCIAL MAPPING — what a Grower output is made of in Cin7. Deliberately separate from:
//   ENGINEERING RULE   (rules.ts)   how many commercial units are needed
//   CIN7 COMMERCIAL DATA            what each component costs/sells for today (looked up at run time)
// Nothing here calculates a quantity of units, and no price lives here. Package definitions are reviewed
// constants backed by source provenance (Topigs costing workbook / legacy ERP / Cin7 catalogue audit,
// docs/newquip-grower-poc-rule-register.md). "Source-backed" means documentary evidence that this is the
// intended SKU — it does NOT mean NewQuip has approved it; only an explicit session confirmation does.

const WB = "AS.23.4015.07 - Topigs Warden (Update 2026).xlsm";

/** How a component's quantity per commercial unit is known. */
export type ComponentQuantityStatus =
  | "source_fixed" // a fixed composition of one commercial unit (e.g. 5 bolts per drinker) — safe to multiply
  | "requires_validation"; // depends on layout/length/engineering — NOT usable for pricing

/** How firmly the component's SKU identity is established. */
export type ComponentIdentity =
  | "source_backed" // documentary evidence for this exact SKU
  | "uncertain" // evidence conflicts; sku is null and candidateSkus lists the contenders — never auto-chosen
  | "unidentified"; // no SKU identified in the source

export interface PackageComponent {
  id: string;
  /** Null when identity is uncertain/unidentified. */
  sku: string | null;
  /** Contenders when the identity is not settled. Shown, never selected automatically. */
  candidateSkus?: string[];
  description: string;
  identity: ComponentIdentity;
  quantityStatus: ComponentQuantityStatus;
  /** Quantity per ONE commercial unit — set only when quantityStatus is "source_fixed". */
  qtyPerUnit: number | null;
  /** The Topigs quotation's figure, kept as a labelled HISTORIC REFERENCE. Never priced, never an engineering rule. */
  historicTopigsQty?: number | null;
  /** Known gaps, e.g. "present in the legacy ERP but not in Cin7". */
  note?: string;
  evidence: string;
  /** Shown instead of a SKU while none is confirmed (e.g. FORTIS 1.2). */
  skuRequired?: string;
  /** A HISTORIC SURROGATE used in an old quote. Shown for context only — NEVER substituted or priced. */
  historicSurrogate?: { sku: string; name: string };
  /**
   * The component is a PRICING EXCEPTION: it is never priced automatically, even if a price appears, until NewQuip
   * confirms the commercial treatment (e.g. NQ3132 shows Retail 0 in the Master). Value = the reason shown to the estimator.
   */
  pricingException?: string;
}

/** CCM feeder product by variant (Sean final): the window option is the SAME feeder with a window — a variant, not a conflict. */
export const FEEDER_SKU_BY_VARIANT = { STANDARD: "PNQ082", WINDOW: "PNQ082-WINDOW" } as const;
export function feederSkuFor(variant: "STANDARD" | "WINDOW" | undefined): string {
  return FEEDER_SKU_BY_VARIANT[variant ?? "STANDARD"];
}

export interface SingleSkuMapping {
  kind: "single";
  itemKey: GrowerItemKey;
  /** Source-backed recommendation — NOT a human confirmation. */
  recommendedSku: string;
  basis: string;
  confidence: "high" | "medium-high";
}

export interface PackageMapping {
  kind: "package";
  itemKey: GrowerItemKey;
  name: string;
  provenance: string;
  /** True when component quantities depend on the physical layout (penning, Flex). */
  layoutDriven: boolean;
  components: PackageComponent[];
  /**
   * M75 (Sean final): the system size is a client preference chosen manually by experienced reps, so the commercial price is
   * an ESTIMATOR INPUT. The components below are a labelled REFERENCE of the historic Topigs package — never priced, never
   * authoritative engineering.
   */
  estimatorPriced?: boolean;
  /**
   * A DIFFERENT representation of the same output seen in a later source (e.g. a single sellable SKU in the Master).
   * Recorded, never priced automatically — which representation prices the output is for NewQuip to confirm.
   */
  alternativeIdentity?: { sku: string; description: string; note: string };
}

/** Priced per a unit the estimator supplies (e.g. penning per running metre by pig size). No automatic price. */
export interface EstimatorPricedMapping {
  kind: "estimator_priced";
  itemKey: GrowerItemKey;
  unit: string;
  reason: string;
  /** Historic SKU family, for the estimator's reference only. */
  historicSkus?: string[];
}

/** A commercial charge that is not a physical SKU (e.g. delivery). Documented; not priced in this POC. */
export interface ManualMapping {
  kind: "manual";
  id: string;
  /** The Grower item this charge accompanies. */
  linkedItemKey: GrowerItemKey;
  description: string;
  reason: string;
  /** Topigs historic figure (ZAR per unit) — documentation only, never used in totals. */
  historicTopigsPerUnitZar: number | null;
}

export interface UnresolvedMapping {
  kind: "unresolved";
  itemKey: GrowerItemKey;
  reason: string;
  /** Candidates the estimator chooses between BY HAND (e.g. PVC doors — the size is in the Cin7 description). Never auto-confirmed. */
  manualSelectionSkus?: string[];
}

export type CommercialMapping = SingleSkuMapping | PackageMapping | ManualMapping | UnresolvedMapping | EstimatorPricedMapping;

const single = (itemKey: GrowerItemKey, recommendedSku: string, basis: string, confidence: SingleSkuMapping["confidence"] = "high"): SingleSkuMapping => ({
  kind: "single", itemKey, recommendedSku, basis, confidence,
});

const fixed = (id: string, sku: string, description: string, qtyPerUnit: number, evidence: string): PackageComponent => ({
  id, sku, description, identity: "source_backed", quantityStatus: "source_fixed", qtyPerUnit, evidence,
});

const layout = (id: string, sku: string | null, description: string, historic: number, evidence: string, extra: Partial<PackageComponent> = {}): PackageComponent => ({
  id, sku, description, identity: sku ? "source_backed" : "unidentified", quantityStatus: "requires_validation", qtyPerUnit: null, historicTopigsQty: historic, evidence, ...extra,
});

export const COMMERCIAL_MAPPINGS: Partial<Record<GrowerItemKey, CommercialMapping>> = {
  // ---- single SKU (source-backed recommendations) ----
  bulk_tank: single("bulk_tank", "SYSH-2750-3",
    "Legacy ERP: '13.39 TONS SILO (NEWQUIP BRANDED)'. Cin7 name shows '1339 TONS' (decimal point lost). NOT SYSH-2750-4 (16.58t, DON'T QUOTE)."),
  // The recommended SKU shown here is the STANDARD variant; the product actually mapped follows the feeder variant (feederSkuFor).
  feeder: single("feeder", "PNQ082",
    `CONFIRMED (Sean): standard CCM feeder = PNQ082; PNQ082-WINDOW where the customer wants the window option. ${WB} sheet CCM: PNQ082 'CCM FEEDER … WITH MONOFLO NIPPLE FOR GROWERS' is activated, PNQ002 deactivated.`),
  feed_saver_mat: single("feed_saver_mat", "ERT053",
    "Only 1000 × 1000 mm feed saver mat in Cin7; the workbook gives no code (price formula only).", "medium-high"),
  concrete_slat: single("concrete_slat", "NQ1161",
    "Cin7 'CONCRETE SLAT (12x045M)' = ERP '(1.2x0.45M)'; the workbook price 203 ≈ ERP latest cost 193.60 × 1.05. Delivery is a SEPARATE charge (see slat delivery)."),

  // ---- packages ----
  cup_drinker: {
    kind: "package", itemKey: "cup_drinker", name: "Grower cup drinker", layoutDriven: false,
    provenance: `${WB} sheet 'cup', GROWER CUP block (rows 43–49); subtotal R475.99 × 1.15 = R548 per drinker.`,
    alternativeIdentity: {
      sku: "NB3542-03",
      description: "CUP DRINKERS (NEW TYPE) GROWER & FINISHER",
      note: "The NewQuip Master (05 Oct 2026, per the owner's Round 2 brief) lists this as the current drinker product. Sean Round 1 separately confirmed the 7-part composition. Which representation prices the drinker is NOT settled — it is never chosen automatically (Round 3).",
    },
    components: [
      fixed("cup", "QCA00003", "Round drinking cup – large (11cm SS pipe) – grower", 1, "cup!B43"),
      fixed("pipe", "NQ1380", "Water pipe 1/2in SST 800mm", 1, "cup!B44"),
      fixed("plate", "NQ2784", "SST backing plate (cups) 2mm / 3 holes", 1, "cup!B45"),
      fixed("bracket", "NQ2886", "Cup drinker bracket, pen mount", 1, "cup!B46"),
      fixed("bolt", "NQ1386", "Bolt M8×65 SST", 5, "cup!B47 (qty formula 3 + 2)"),
      fixed("nut", "NYNUT", "Nylock nut M8 SST", 5, "cup!B48"),
      fixed("washer", "NQ1017", "Washer M8×25×2 SST", 5, "cup!B49"),
    ],
  },
  led_light: {
    kind: "package", itemKey: "led_light", name: "FORTIS 1.2 5000K LED light", layoutDriven: false,
    provenance: `${WB} sheet 'FX': €25.50 + 3 × €0.74 + €1.37 = €29.09 per light (priced on the FERAX 24W ON/OFF, HNQ7046, as a historic surrogate for the FORTIS 1.2).`,
    components: [
      {
        id: "luminaire", sku: null, identity: "unidentified", quantityStatus: "source_fixed", qtyPerUnit: 1,
        description: "FORTIS 1.2 5000K luminaire",
        skuRequired: "FORTIS 1.2 — SKU REQUIRED / UNMAPPED",
        historicSurrogate: { sku: "HNQ7046", name: "FERAX 24W ON/OFF" },
        note: "FORTIS 1.2 is the newer/current product and has NO SKU yet (Sean Round 2 #9). The historic quote used HNQ7046 (FERAX 24W ON/OFF) as a surrogate; it is NOT the FORTIS and is never substituted automatically.",
        evidence: "Sean Round 2 #9; FX!A4 (workbook) — Ferax = HNQ7046, FORTIS has no code",
      },
      {
        id: "clip", sku: null, candidateSkus: ["HNQ7088", "HNQ7093"], identity: "uncertain", quantityStatus: "source_fixed", qtyPerUnit: 3,
        description: "Mounting clip",
        note: "Workbook says HNQ7088 is the clip; ERP/Cin7 say HNQ7093 is 'FERAX CLIP 29MM RVS'. Not decided — NewQuip to confirm.",
        evidence: "FX!A5 (workbook) vs Inventory Master / Cin7 names",
      },
      {
        id: "cable", sku: null, candidateSkus: ["HNQ7093", "HNQ7088"], identity: "uncertain", quantityStatus: "source_fixed", qtyPerUnit: 1,
        description: "Connection cable",
        note: "Workbook says HNQ7093 is the cable; ERP/Cin7 say HNQ7088 is 'FERAX CABLE 0.6M'. Not decided — NewQuip to confirm.",
        evidence: "FX!A6 (workbook) vs Inventory Master / Cin7 names",
      },
    ],
  },
  flex_auger: {
    kind: "package", itemKey: "flex_auger", name: "M75 feed distribution system", layoutDriven: true, estimatorPriced: true,
    provenance: `${WB} sheet 'W1' (Topigs case: 2 × lines of ±49.5m, 18 drop kits). Quantities below are the HISTORIC TOPIGS PACKAGE REFERENCE — formula-driven in the workbook, NOT authorised engineering and NOT priced: M75 is an ESTIMATOR INPUT (Sean final), priced by the estimator as a system.`,
    components: [
      layout("auger", "NQ1163", "Auger M-75 (new), per metre", 134, "W1 row 71"),
      layout("tube", "NQ1223", "TUBE M75 (WHITE) / AUGER PIPE (NEW TYPE) — the M75 MAIN auger tube", 40, "W1 row 52; SKU per the NewQuip Master (workbook listed T2750300)", { note: "The M75 main auger tube. NOT the clear drop tube and NOT NQ.TUBE.63." }),
      layout("clamps", "NQ1764", "M75 tube clamp", 48, "W1 row 56; SKU per the NewQuip Master (workbook listed T2750015)"),
      layout("elbow", "NQ1227", "M75 PVC ELBOW (NEW TYPE)", 8, "W1 row 64; SKU per the NewQuip Master (workbook listed T2750301)"),
      layout("dropkit", "NQ1942", "M75 complete drop kit", 18, "W1 row 13; input B2 = 18 drops; SKU per the NewQuip Master (workbook listed NQ1984)"),
      layout("droptube", "NQ.TUBE.75", "M75 clear drop tube", 5, "W1 row 14 = ROUNDUP(drops / 4); SKU per the NewQuip Master", {
        note: "Clear DROP tube — distinct from the M75 main auger tube (NQ1223). The workbook listed NQ.TUBE.63 (63mm clear drop tube, still a valid SKU per Sean Round 2 #10); that is a different item and is NOT the auger pipe.",
      }),
      layout("control", "T3750001", "M75 control unit with safety switch", 2, "W1 row 39"),
      layout("unloader", "TSA3750505", "M75 unloader double right/left (new type)", 1, "W1 row 35"),
      layout("levelswitch", "T3000365", "Feed level switch dia 75mm", 2, "W1 row 18"),
      layout("drive", "NQ3132", "1.5HP DRIVE UNIT (1.1KW) 380V", 2, "W1 row 77; replaces TRA1.1KW3PH (Sean Round 2 #10)", {
        note: "Replaces the legacy TRA1.1KW3PH.",
        pricingException: "N/A — SUPPLIER QUOTE REQUIRED: the Master shows Retail 0 for NQ3132. It is never quoted as zero. If the job needs it, the estimator resolves the commercial amount or prices the higher-level manual M75 solution.",
      }),
      layout("post", null, "Support post (SST)", 52, "W1 row 83 — SKU cell truncated ('KNQ'), price R760", {
        candidateSkus: ["NQ2601"], identity: "uncertain", note: "NQ2601 'HEAVY DUTY SUPPORT POST SST(1M)' is a likely match but NOT confirmed.",
      }),
      layout("wallplate", "KNQ160", "Wall plate (SST) kit for M55 & M75 auger", 4, "W1 row 97"),
    ],
  },
  // ---- rate-priced ----
  // Penning is priced per RUNNING METRE by pig size (Sean final: R1,300 / R1,500 / R2,200 ex VAT). No SKU is needed for the POC
  // commercial result; the SKU mapping (historic family KNQPP005–008) is a future production concern.
  penning_package: {
    kind: "estimator_priced", itemKey: "penning_package", unit: "running metre",
    reason: "NewQuip penning by pig-size / running-metre basis (small R1,300 · medium R1,500 · large R2,200 per running metre ex VAT). SKU mapping is a future production concern.",
    historicSkus: ["KNQPP005", "KNQPP006", "KNQPP007", "KNQPP008"],
  },

  // ---- unresolved ----
  pvc_door: {
    kind: "unresolved", itemKey: "pvc_door",
    reason: "MANUAL SELECTION — the estimator picks the door product; its size is in the Cin7 product description. There is no automatic door-sizing rule (Sean Round 2 #11).",
    manualSelectionSkus: ["NQ2114", "NQ2113", "NQ2112", "NQ2161", "NQ2281"],
  },
};

/** Commercial charges that accompany an item but are not part of its physical SKU. */
export const MANUAL_COMMERCIAL_LINES: ManualMapping[] = [
  {
    kind: "manual", id: "concrete_slat_delivery", linkedItemKey: "concrete_slat",
    description: "Concrete slat delivery (crane truck)",
    reason: "The Topigs line 'Incl. delivery by crane truck' prices R254.22 = 203 (slat) + 51.22 (delivery). Delivery is a separate charge, not part of NQ1161.",
    historicTopigsPerUnitZar: 51.22,
  },
];

export function commercialMappingFor(itemKey: GrowerItemKey): CommercialMapping | undefined {
  return COMMERCIAL_MAPPINGS[itemKey];
}

export function packageFor(itemKey: GrowerItemKey): PackageMapping | undefined {
  const m = COMMERCIAL_MAPPINGS[itemKey];
  return m?.kind === "package" ? m : undefined;
}

export function estimatorPricedFor(itemKey: GrowerItemKey): EstimatorPricedMapping | undefined {
  const m = COMMERCIAL_MAPPINGS[itemKey];
  return m?.kind === "estimator_priced" ? m : undefined;
}

/** SKUs an estimator may pick BETWEEN by hand for an item (never auto-confirmed). */
export function manualSelectionSkusFor(itemKey: GrowerItemKey): string[] {
  const m = COMMERCIAL_MAPPINGS[itemKey];
  return m?.kind === "unresolved" ? (m.manualSelectionSkus ?? []) : [];
}

export function manualLinesFor(itemKey: GrowerItemKey): ManualMapping[] {
  return MANUAL_COMMERCIAL_LINES.filter((m) => m.linkedItemKey === itemKey);
}

export function singleMappings(): SingleSkuMapping[] {
  return Object.values(COMMERCIAL_MAPPINGS).filter((m): m is SingleSkuMapping => m?.kind === "single");
}

export function recommendedSkuFor(itemKey: GrowerItemKey): SingleSkuMapping | undefined {
  const m = COMMERCIAL_MAPPINGS[itemKey];
  return m?.kind === "single" ? m : undefined;
}

/** Every SKU the commercial mappings name (recommendations + package components + contenders). For catalogue lookups. */
export function referencedSkus(): string[] {
  const out = new Set<string>(Object.values(FEEDER_SKU_BY_VARIANT));
  for (const m of Object.values(COMMERCIAL_MAPPINGS)) {
    if (!m) continue;
    if (m.kind === "single") out.add(m.recommendedSku);
    if (m.kind === "package") for (const c of m.components) { if (c.sku) out.add(c.sku); c.candidateSkus?.forEach((s) => out.add(s)); }
    if (m.kind === "unresolved") m.manualSelectionSkus?.forEach((s) => out.add(s));
  }
  return [...out];
}
