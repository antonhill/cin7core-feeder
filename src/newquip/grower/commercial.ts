import type { GrowerItemKey } from "./types";
import { coolingBom, COOLING_MAX_LENGTH_M, COOLING_MIN_LENGTH_M } from "./cooling-bom";

// COMMERCIAL MAPPING — what a Grower output is made of in Cin7. Deliberately separate from:
//   ENGINEERING RULE   (rules.ts)   how many commercial units are needed
//   CIN7 COMMERCIAL DATA            what each component costs/sells for today (looked up at run time)
// Nothing here calculates a quantity of units, and no price lives here. Package definitions are reviewed
// constants backed by source provenance (Topigs costing workbook / legacy ERP / Cin7 catalogue audit,
// docs/newquip-grower-poc-rule-register.md). "Source-backed" means documentary evidence that this is the
// intended SKU — it does NOT mean NewQuip has approved it; only an explicit session confirmation does.

const WB = "AS.23.4015.07 - Topigs Warden (Update 2026).xlsm";
/** Sean / Tereesha's answers of 2026-11 (the questions workbook, both sheets). A confirmed SKU IDENTITY only: it does not confirm a quantity, a cost basis or a selling price. */
export const FEEDBACK_2026_11 = "NewQuip_Simple_Questions_Sean_Tereesha - Updated.xlsx (Questions and Penning sheets)";

// The figures Sean / Tereesha supplied (2026-11) are deliberately NOT in this module: it is imported by client components, so a figure here would ship to every viewer including a Rep.
// They live in the server-only supplied-references.ts and reach a cost-entitled viewer through a server action.

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
  /** Set when Sean / Tereesha confirmed THIS identity (2026-11); the source is named. Identity only. */
  confirmedBy?: string;
  /** The unit the quantity is expressed in (default "each"). The auger is quoted and costed per METRE although Cin7 reports Item. */
  quantityUnit?: "each" | "metre";
  /** True when Sean / Tereesha supplied a figure for this component (the figure itself is server-only; it is a reference, never a price). */
  hasSuppliedReference?: boolean;
  /** Shown instead of a SKU while none is confirmed (e.g. FORTIS 1.2). */
  skuRequired?: string;
  /** A HISTORIC SURROGATE used in an old quote. Shown for context only — NEVER substituted or priced. */
  historicSurrogate?: { sku: string; name: string };
  /**
   * The component is a PRICING EXCEPTION: it is never priced automatically, even if a price appears, until NewQuip
   * confirms the commercial treatment (e.g. NQ3132 shows Retail 0 in the Master). Value = the reason shown to the estimator.
   */
  pricingException?: string;
  /** The quantity is shared across units (e.g. one power supply per two windows): the PROJECT total is rounded UP to whole items. */
  roundUpTotal?: boolean;
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
  /** Set when the package must NOT be treated as confirmed without an Estimator, whatever its components say. The value is the reason shown. */
  estimatorConfirmation?: string;
  /**
   * A DIFFERENT representation of the same output seen in a later source (e.g. a single sellable SKU in the Master).
   * Recorded, never priced automatically — which representation prices the output is for NewQuip to confirm.
   */
  alternativeIdentity?: { sku: string; description: string; note: string };
}

/**
 * The sumpless pad-cooling package for ONE system of `lengthM` metres (NewQuip handoff 2026-11-25, section 6). Every component quantity is the confirmed formula in cooling-bom.ts; nothing is priced here (current Cin7 component
 * costs are looked up at run time). Returns null when the length is missing or not a positive number: the line then stays unpriced and asks for it, never a guessed length. A component whose quantity is 0 (no middle gutter kit up to 3 m) is omitted.
 * Labour days, travel, food and accommodation are NOT part of this package: they are manual charges and no rate was supplied.
 */
export function coolingPackageFor(lengthM: number | null | undefined): PackageMapping | null {
  if (lengthM == null || !Number.isFinite(lengthM) || lengthM < COOLING_MIN_LENGTH_M || lengthM > COOLING_MAX_LENGTH_M) return null;
  const bom = coolingBom(lengthM);
  return {
    kind: "package", itemKey: "pad_cooling", name: `Sumpless pad cooling, ${lengthM} m system`, layoutDriven: false,
    provenance: "NEWQUIP_GROWER_PRICING_HANDOFF_2026-11-25, section 6: confirmed quantity formulas by system length; current Cin7 component costs approved for the Budget calculation. " + bom.assumptions.join(" "),
    estimatorConfirmation: "NewQuip confirmed the quantity formulas on 2026-11-25, including the plumbing doubling over 20 m and the cleaning fitting counted once (two per system). The 0.6 m to 200 m length check is provisional for UAT and needs production approval. The Estimator confirms the package at sign-off. Labour, travel, food and accommodation are not included.",
    components: bom.lines.filter((l) => l.quantity > 0).map((l) => fixed(`${l.section}-${l.sku}`, l.sku, l.description, l.quantity, `Handoff 2026-11-25 s6 (${l.section})`)),
  };
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
  /** The SKU NewQuip proposed as the replacement. Offered first, never selected automatically. */
  proposedSku?: string;
  /** Earlier candidates NewQuip replaced: no longer offered for this item. */
  retiredSkus?: string[];
  /** True when a figure was supplied for the proposed SKU (server-only; its commercial basis is NOT established). */
  hasSuppliedReference?: boolean;
}

export type CommercialMapping = SingleSkuMapping | PackageMapping | ManualMapping | UnresolvedMapping | EstimatorPricedMapping;

const single = (itemKey: GrowerItemKey, recommendedSku: string, basis: string, confidence: SingleSkuMapping["confidence"] = "high"): SingleSkuMapping => ({
  kind: "single", itemKey, recommendedSku, basis, confidence,
});

const fixed = (id: string, sku: string, description: string, qtyPerUnit: number, evidence: string): PackageComponent => ({
  id, sku, description, identity: "source_backed", quantityStatus: "source_fixed", qtyPerUnit, evidence,
});

const shared = (id: string, sku: string, description: string, qtyPerUnit: number, evidence: string): PackageComponent => ({ ...fixed(id, sku, description, qtyPerUnit, evidence), roundUpTotal: true });

const layout = (id: string, sku: string | null, description: string, historic: number, evidence: string, extra: Partial<PackageComponent> = {}): PackageComponent => ({
  id, sku, description, identity: sku ? "source_backed" : "unidentified", quantityStatus: "requires_validation", qtyPerUnit: null, historicTopigsQty: historic, evidence, ...extra,
});

/**
 * The cup-drinker package. `confirmed` = true is the grower-2026-11 definition: NewQuip confirmed the seven-component bill of materials and said NOT to replace it with NB3542-03 (handoff 2026-11-25), so it is
 * a fixed, source-backed composition. `confirmed` = false is the original grower-2026-10 definition, kept verbatim so a quotation created under it prices exactly as it did.
 */
function cupDrinkerPackage(confirmed: boolean): PackageMapping {
  return {
    kind: "package", itemKey: "cup_drinker", name: confirmed ? "Sow Cup Drinker Including Mounting Material" : "Grower cup drinker", layoutDriven: false,
    provenance: confirmed
      ? `${WB} sheet 'cup', GROWER CUP block (rows 43–49). CONFIRMED by NewQuip (NEWQUIP_GROWER_PRICING_HANDOFF_2026-11-25, section 9): the seven-component BOM is final, do NOT replace it with NB3542-03, and current Cin7 component costs are approved for the Budget calculation. The customer-facing description is "Sow Cup Drinker Including Mounting Material".`
      : `${WB} sheet 'cup', GROWER CUP block (rows 43–49); subtotal R475.99 × 1.15 = R548 per drinker.`,
    ...(confirmed ? { estimatorConfirmation: "NewQuip confirmed this composition on 2026-11-25 (handoff). The Estimator still confirms the package and its quantity at sign-off, exactly as for every other package." } : {
      alternativeIdentity: {
        sku: "NB3542-03",
        description: "CUP DRINKERS (NEW TYPE) GROWER & FINISHER",
        note: "The NewQuip Master (05 Oct 2026, per the owner's Round 2 brief) lists this as the current drinker product. Sean Round 1 separately confirmed the 7-part composition. Which representation prices the drinker is NOT settled — it is never chosen automatically (Round 3).",
      },
    }),
    components: [
      fixed("cup", "QCA00003", "Round drinking cup – large (11cm SS pipe) – grower", 1, "cup!B43"),
      fixed("pipe", "NQ1380", "Water pipe 1/2in SST 800mm", 1, "cup!B44"),
      fixed("plate", "NQ2784", "SST backing plate (cups) 2mm / 3 holes", 1, "cup!B45"),
      fixed("bracket", "NQ2886", "Cup drinker bracket, pen mount", 1, "cup!B46"),
      fixed("bolt", "NQ1386", "Bolt M8×65 SST", 5, "cup!B47 (qty formula 3 + 2)"),
      fixed("nut", "NYNUT", "Nylock nut M8 SST", 5, "cup!B48"),
      fixed("washer", "NQ1017", "Washer M8×25×2 SST", 5, "cup!B49"),
    ],
  };
}

/** The 250 mm manure plug: a finished item (MNQ048) that is exactly one each of MNQ039, MNQ040 and MNQ041 (handoff 2026-11-25, section 8). The Rep enters the quantity; current Cin7 component costs are approved. */
const MANURE_PLUG_PACKAGE: PackageMapping = {
  kind: "package", itemKey: "manure_plug", name: "250mm manure plug (MNQ048)", layoutDriven: false,
  estimatorConfirmation: "NewQuip confirmed this composition on 2026-11-25 (handoff). The Estimator still confirms the package and its quantity at sign-off, exactly as for every other package.",
  provenance: "NEWQUIP_GROWER_PRICING_HANDOFF_2026-11-25, section 8: finished item MNQ048 = MNQ039 x1 + MNQ040 x1 + MNQ041 x1. Current Cin7 component costs approved for the Budget calculation.",
  components: [
    fixed("tube", "MNQ039", "Manure plug component 1 of 3 (MNQ048 BOM)", 1, "Handoff 2026-11-25 s8"),
    fixed("seal", "MNQ040", "Manure plug component 2 of 3 (MNQ048 BOM)", 1, "Handoff 2026-11-25 s8"),
    fixed("plug", "MNQ041", "Manure plug component 3 of 3 (MNQ048 BOM)", 1, "Handoff 2026-11-25 s8"),
  ],
};

/**
 * The emergency window (ERT003, 1500 x 700 mm with motor) and its confirmed 11-line component list (Sean, 2026-11-24 10:22; the one-per-two-windows rule and the quantities are his). One package unit = one window; the Rep enters
 * windows per room (suggested 1). Shared items (power supply, emergency opening) are 1 per 2 windows, ROUNDED UP over the whole quotation. The RLD80 drive, its mounting set and coupling, and the galvanised pipe are written
 * "per room" in the source; with one window per room (the default) that is the same as per window, and the Estimator confirms the package and quantity at sign-off for a room with more windows.
 */
const EMERGENCY_WINDOW_PACKAGE: PackageMapping = {
  kind: "package", itemKey: "emergency_windows", name: "Emergency window (ERT003) with its components", layoutDriven: false,
  estimatorConfirmation: "NewQuip confirmed the component list on 2026-11-24. The Estimator confirms the quantity per room (the drive, mounting set, coupling and pipe are written per room in the source).",
  provenance: "Sean Bredenkamp 2026-11-24 10:22 'Emergency window breakdown': ERT003 x1; HO08990730 and HO08020800 1 for every 2 windows; RID503117 x4; RID507450 x1 per room; RID507220 x1 per RID507450; RID590008 x2 per RID507450; NQPP1017 x2 per room; NQ1060 x16; NQ3401 x16; NQ1088 x1.",
  components: [
    fixed("window", "ERT003", "Emergency window 1500 x 700 mm with motor", 1, "Sean 2026-11-24"),
    shared("psu", "HO08990730", "Power supply 24VDC 150VA + 2 manual control 0-10V (1 per 2 windows)", 0.5, "Sean 2026-11-24"),
    shared("opening", "HO08020800", "Emergency opening 24VDC for PS-100 slave (1 per 2 windows)", 0.5, "Sean 2026-11-24"),
    fixed("bearing", "RID503117", "Bearing plate", 4, "Sean 2026-11-24"),
    fixed("drive", "RID507450", "RLD80 / 1K / 24V / 2D25 / Z16 logic drive (1 per room)", 1, "Sean 2026-11-24"),
    fixed("mount", "RID507220", "Mounting set for RLD80 (1 per drive)", 1, "Sean 2026-11-24"),
    fixed("coupling", "RID590008", "Chain bolt coupling (2 per drive)", 2, "Sean 2026-11-24"),
    fixed("pipe", "NQPP1017", "Galvanised pipe 33.4 (1 in) incl. sockets, 6 m length (2 per room)", 2, "Sean 2026-11-24"),
    fixed("washer", "NQ1060", "Body washer M6x19x1.6", 16, "Sean 2026-11-24 (fastening material)"),
    fixed("screw", "NQ3401", "Metapp 12-24 x 38 mm hex flange screw, class 3, plain", 16, "Sean 2026-11-24 (fastening material)"),
    fixed("rope", "NQ1088", "Braided rope 4 mm polyester", 1, "Sean 2026-11-24 (fastening material)"),
  ],
};

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
  cup_drinker: cupDrinkerPackage(true),
  manure_plug: MANURE_PLUG_PACKAGE,
  emergency_windows: EMERGENCY_WINDOW_PACKAGE,
  led_light: {
    kind: "package", itemKey: "led_light", name: "FORTIS 1.2 5000K LED light", layoutDriven: false,
    provenance: `NEWQUIP_GROWER_PRICING_HANDOFF_2026-11-25, section 10: HNQ7046 FERAX 24W luminaire x1, HNQ7093 FERAX 29mm clip x3, HNQ7088 FERAX 0.6m cable x1; NewQuip asked for the customer-facing family to be FERAX (not FORTIS); that rename is HELD because the Rep-safe document guard forbids the brand, owner decision needed. Current Cin7 component costs approved. ${FEEDBACK_2026_11}: Sean confirmed HNQ7046, HNQ7088 and HNQ7093 as the Grower House LED light and accessories, replacing the revolving-light / light-trap SKUs (HO12011000, HO17050750, HO21013750). Function of each, from the Cin7 product names: HNQ7046 = FERAX 24W ON/OFF (the luminaire), HNQ7088 = FERAX CABLE 0.6M (the cable), HNQ7093 = FERAX CLIP 29MM RVS (the mounting clip). The per-light composition (1 luminaire + 3 clips + 1 cable) is the historic ${WB} sheet 'FX' composition: Sean confirmed the SKUs, not the quantities.`,
    estimatorConfirmation: "NewQuip confirmed this composition on 2026-11-25 (handoff). The Estimator still confirms the package and its quantity at sign-off, exactly as for every other package.",
    components: [
      {
        id: "luminaire", sku: "HNQ7046", identity: "source_backed", quantityStatus: "source_fixed", qtyPerUnit: 1,
        description: "Luminaire (Cin7: FERAX 24W ON/OFF)", confirmedBy: FEEDBACK_2026_11,
        note: "Confirmed by Sean (2026-11) as the Grower House light. The template still names it FORTIS 1.2 5000K: whether the customer document should say FERAX 24W or FORTIS 1.2 is for NewQuip to confirm.",
        evidence: `${FEEDBACK_2026_11}; FX!A4 (workbook) — Ferax = HNQ7046`,
      },
      {
        id: "clip", sku: "HNQ7093", identity: "source_backed", quantityStatus: "source_fixed", qtyPerUnit: 3,
        description: "Mounting clip (Cin7: FERAX CLIP 29MM RVS)", confirmedBy: FEEDBACK_2026_11,
        note: "Identity settled by the Cin7 product name: HNQ7093 is the clip and HNQ7088 the cable (the older workbook had them the other way round).",
        evidence: `${FEEDBACK_2026_11}; Cin7 product names (synced catalogue)`,
      },
      {
        id: "cable", sku: "HNQ7088", identity: "source_backed", quantityStatus: "source_fixed", qtyPerUnit: 1,
        description: "Connection cable (Cin7: FERAX CABLE 06M, i.e. 0.6 m)", confirmedBy: FEEDBACK_2026_11,
        evidence: `${FEEDBACK_2026_11}; Cin7 product names (synced catalogue)`,
      },
    ],
  },
  flex_auger: {
    kind: "package", itemKey: "flex_auger", name: "M75 feed distribution system", layoutDriven: true, estimatorPriced: true,
    provenance: `${WB} sheet 'W1' (Topigs case: 2 × lines of ±49.5m, 18 drop kits). Quantities below are the HISTORIC TOPIGS PACKAGE REFERENCE — formula-driven in the workbook, NOT authorised engineering and NOT priced: M75 is an ESTIMATOR INPUT (Sean final), priced by the estimator as a system.`,
    components: [
      layout("auger", "NQ1163", "Auger M-75 (new), per metre", 134, "W1 row 71", {
        quantityUnit: "metre", confirmedBy: FEEDBACK_2026_11, hasSuppliedReference: true,
        note: "Quoted and costed per METRE although Cin7 says Item. The quantity is the auger LENGTH in metres (never the number of systems, never an item count). The physical-length rule is not established (the historic 134 m is a hidden workbook formula for the 2 × 49.5 m Topigs lines), so the Estimator enters the metres; the supplied per-metre figure is a reference, not a verified cost.",
      }),
      layout("tube", "NQ1223", "TUBE M75 (WHITE) / AUGER PIPE (NEW TYPE) — the M75 MAIN auger tube", 40, "W1 row 52; SKU per the NewQuip Master (workbook listed T2750300)", { note: "The M75 main auger tube. NOT the clear drop tube and NOT NQ.TUBE.63." }),
      layout("clamps", "NQ1764", "M75 tube clamp", 48, "W1 row 56; SKU per the NewQuip Master (workbook listed T2750015)"),
      layout("elbow", "NQ1227", "M75 PVC ELBOW (NEW TYPE)", 8, "W1 row 64; SKU per the NewQuip Master (workbook listed T2750301)"),
      layout("dropkit", "NQ1942", "M75 complete drop kit", 18, "W1 row 13; input B2 = 18 drops; SKU per the NewQuip Master (workbook listed NQ1984)", {
        confirmedBy: FEEDBACK_2026_11, hasSuppliedReference: true,
        note: "NQ1942 = 'M75 COMPLETE DROP KIT (SHEEP/PIG INCL KNOBS & ROPE)'. NQ1984 (the drop kit WITHOUT knobs and rope) is excluded by Sean (2026-11) and is never offered.",
      }),
      layout("droptube", null, "M75 clear drop tube", 5, "W1 row 14 = ROUNDUP(drops / 4)", {
        identity: "uncertain", candidateSkus: ["NQ.TUBE.63", "NQ.TUBE.75"], hasSuppliedReference: true,
        note: "Clear DROP tube (distinct from the M75 main auger tube NQ1223). Sean (2026-11) supplied NQ.TUBE.63 with a figure; the NewQuip Master has NQ.TUBE.75. Which size the drop kit uses is not settled, and NQ.TUBE.63 is not in the synced catalogue copy, so it must be verified live in Cin7. Not chosen automatically.",
      }),
      layout("control", "T3750001", "M75 control unit with safety switch", 2, "W1 row 39"),
      layout("unloader", "TSA3750505", "M75 unloader double right/left (new type)", 1, "W1 row 35"),
      layout("levelswitch", "T3000365", "Feed level switch dia 75mm", 2, "W1 row 18"),
      layout("drive", "NQ3132", "1.5HP DRIVE UNIT (1.1KW) 380V", 2, "W1 row 77; replaces TRA1.1KW3PH (Sean Round 2 #10)", {
        note: "Replaces the legacy TRA1.1KW3PH. Function: the M75 DRIVE UNIT (motor), not a drop-kit part. Cin7's product name reads '15HP DRIVE UNIT (11KW) 380V' (the decimal points appear lost: the template says 1.5HP / 1.1KW). Sean's 2026-11 M75 answer did not mention NQ3132, so it is neither confirmed nor excluded: it stays a supplier-quote exception.",
        pricingException: "N/A — SUPPLIER QUOTE REQUIRED: the Master shows Retail 0 for NQ3132. It is never quoted as zero. If the job needs it, the estimator resolves the commercial amount or prices the higher-level manual M75 solution.",
      }),
      layout("post", "KNQ050-900", "Support post (SST heavy duty, 50mm panel, H=900mm)", 52, "W1 row 83 — SKU cell truncated ('KNQ'), price R760", {
        confirmedBy: FEEDBACK_2026_11,
        note: "Sean (2026-11) corrected the support post from NQ2601 ('HEAVY DUTY SUPPORT POST SST (1M)') to KNQ050-900 ('SST HEAVY DUTY SUPPORT POST (50MM PANEL) H=900MM'), the same heavy-duty family at 900 mm for 50 mm panels. The quantity is still layout-driven and unvalidated. NQ2601 is no longer offered for this application.",
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
    reason: "MANUAL SELECTION — the estimator picks the door product. There is no automatic door-sizing rule (Sean Round 2 #11). Sean (2026-11) proposes NQ3444 (Cin7: 'PVC SINGLE DOORS'; 'a mixture of Kunlong and local parts') as the Grower House door and replaced NQ2112, NQ2113 and NQ2114. Cin7's description gives no door size, so the specification cannot be validated from the catalogue: the Estimator confirms the door and its size. Whether NQ3444 is one complete assembly or needs components is not stated, so no component is added alongside it.",
    manualSelectionSkus: ["NQ3444", "NQ2161", "NQ2281"],
    proposedSku: "NQ3444",
    hasSuppliedReference: true,
    retiredSkus: ["NQ2112", "NQ2113", "NQ2114"],
  },
};


/**
 * TEMPLATE REVISIONS. A quotation is evaluated against the template revision it was created under, never the latest one, so changing the template can never silently re-scope or re-price a
 * quotation that already exists. The revision is SERVER-OWNED on the draft (estimator.templateRevision): ABSENT = the original template (grower-2026-10), which is every quotation that existed
 * before the 2026-11 reconfiguration. Only a NEW quotation is stamped with the current revision, and an existing quotation moves to it only through the explicit, audited adoption action.
 */
export const TEMPLATE_REVISION_LEGACY = "grower-2026-10" as const;
export const TEMPLATE_REVISION_CURRENT = "grower-2026-11" as const;
export type TemplateRevision = typeof TEMPLATE_REVISION_LEGACY | typeof TEMPLATE_REVISION_CURRENT;
/** Anything other than the current revision (absent, unknown, tampered) is the ORIGINAL template: the safe reading, because it can only reproduce what the quotation already showed. */
export const templateRevisionOf = (draft: { estimator?: { templateRevision?: unknown } } | null | undefined): TemplateRevision =>
  draft?.estimator?.templateRevision === TEMPLATE_REVISION_CURRENT ? TEMPLATE_REVISION_CURRENT : TEMPLATE_REVISION_LEGACY;

/** The ORIGINAL (grower-2026-10) definitions of the items the 2026-11 answers changed, kept verbatim so a quotation created under them keeps exactly the scope, quantities and pricing it had. */
const LEGACY_COMMERCIAL_MAPPINGS: Partial<Record<GrowerItemKey, CommercialMapping>> = {
  cup_drinker: cupDrinkerPackage(false),
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

/** The mapping for an item under a template revision. The revision is REQUIRED: there is deliberately no default, so no caller can silently read the latest template for an existing quotation. */
/** Items the grower-2026-10 template had NO mapping for; a later revision's mapping must never reach a quotation created under it. */
const LEGACY_UNMAPPED: ReadonlySet<GrowerItemKey> = new Set<GrowerItemKey>(["manure_plug", "emergency_windows"]);

export function commercialMappingFor(itemKey: GrowerItemKey, revision: TemplateRevision): CommercialMapping | undefined {
  if (revision === TEMPLATE_REVISION_LEGACY && LEGACY_UNMAPPED.has(itemKey)) return undefined;
  return revision === TEMPLATE_REVISION_LEGACY && LEGACY_COMMERCIAL_MAPPINGS[itemKey] ? LEGACY_COMMERCIAL_MAPPINGS[itemKey] : COMMERCIAL_MAPPINGS[itemKey];
}

export function packageFor(itemKey: GrowerItemKey, revision: TemplateRevision): PackageMapping | undefined {
  const m = commercialMappingFor(itemKey, revision);
  return m?.kind === "package" ? m : undefined;
}

export function estimatorPricedFor(itemKey: GrowerItemKey): EstimatorPricedMapping | undefined {
  const m = COMMERCIAL_MAPPINGS[itemKey];
  return m?.kind === "estimator_priced" ? m : undefined;
}

/**
 * Items whose product is established and unambiguous in the approved catalogue, so a new quotation uses it without an Estimator reconfirming it
 * (the Estimator still can override it on a quotation, and it is re-checked against the live catalogue at sign-off). Deliberately an explicit list:
 * a mapping becomes automatic only by being named here, never by being merely source-backed. LED light, PVC door, M75, penning and the optional extras are NOT here.
 */
export const CATALOGUE_DEFAULT_ITEMS: ReadonlySet<GrowerItemKey> = new Set<GrowerItemKey>(["bulk_tank", "feeder", "concrete_slat", "feed_saver_mat"]);

/** True when the item resolves to its catalogue product by default (no per-quotation confirmation needed). */
export const isCatalogueDefaultItem = (itemKey: GrowerItemKey): boolean => CATALOGUE_DEFAULT_ITEMS.has(itemKey);

/**
 * A package may be treated as confirmed without an Estimator only when its definition is authoritative and complete: every component has a source-backed SKU and a
 * fixed source quantity, it is not layout- or estimator-priced, and no later source disputes which representation prices it. The cup drinker fails the last test
 * (the Master lists a single sellable SKU, NB3542-03, and which one prices the drinker is for NewQuip to settle), so it keeps an explicit Estimator decision.
 */
export function packageAutoConfirmable(pkg: PackageMapping | undefined): boolean {
  if (!pkg || pkg.estimatorPriced || pkg.layoutDriven || pkg.alternativeIdentity || pkg.estimatorConfirmation) return false;
  return pkg.components.length > 0 && pkg.components.every((c) => c.identity === "source_backed" && !!c.sku && c.quantityStatus === "source_fixed" && c.qtyPerUnit != null && !c.pricingException);
}

/**
 * PROVISIONAL BUDGET PRICING (customer UAT, owner decision 2026-11-18, UAT ONLY). A package that is NOT confirmable without an Estimator (it carries an open `alternativeIdentity` or `estimatorConfirmation`)
 * may still be PRICED PROVISIONALLY for a Rep's BUDGET quotation when its composition is otherwise evidence-complete: every component has a source-backed SKU, a fixed source quantity and no pricing
 * exception, and it is neither layout- nor Estimator-priced. This NEVER confirms the package: the default engine is unchanged, readiness, sign-off, approval and baselines still demand the Estimator's
 * confirmation, and the open question stays visible to Estimators (`internalReasons`). Returns null when the package is not eligible (including when it is already confirmable: nothing is provisional about it).
 */
export interface ProvisionalBasis {
  /** INTERNAL (Estimator / Manager / audit): why it qualifies and what is still open. Never sent to a Rep. */
  qualifies: string;
  internalReasons: string[];
  /** The composition priced: [sku, quantity per package unit]. Internal. */
  composition: Array<{ sku: string; qtyPerUnit: number }>;
  /** Customer- and Rep-safe: what may change. No product code, cost, rate or margin. */
  plain: string;
}
const PROVISIONAL_PLAIN: Partial<Record<GrowerItemKey, string>> = {
  cup_drinker: "Provisional: the exact drinker product and its parts are still to be confirmed, so this price may change.",
  pad_cooling: "Provisional: the cooling quantities follow NewQuip's confirmed formulas for the system length entered; labour, travel and some plumbing details are still to be confirmed, so this price may change.",
  led_light: "Provisional: the light model, the number of parts per light and the product name are still to be confirmed, so this price may change.",
};
export function provisionalPackageBasis(pkg: PackageMapping | undefined): ProvisionalBasis | null {
  if (!pkg || pkg.estimatorPriced || pkg.layoutDriven || packageAutoConfirmable(pkg)) return null;
  const open = [pkg.alternativeIdentity ? `Open alternative: ${pkg.alternativeIdentity.sku} (${pkg.alternativeIdentity.description}). ${pkg.alternativeIdentity.note}` : null, pkg.estimatorConfirmation ?? null].filter((x): x is string => !!x);
  if (open.length === 0) return null;
  const complete = pkg.components.length > 0 && pkg.components.every((c) => c.identity === "source_backed" && !!c.sku && c.quantityStatus === "source_fixed" && c.qtyPerUnit != null && !c.pricingException);
  if (!complete) return null;
  return {
    qualifies: `Every component has a source-backed SKU, a fixed source quantity and no pricing exception (${pkg.name}). This is a provisional budget composition, NOT a NewQuip-approved specification.`,
    internalReasons: open,
    composition: pkg.components.map((c) => ({ sku: c.sku as string, qtyPerUnit: c.qtyPerUnit as number })),
    plain: pkg.alternativeIdentity || pkg.itemKey === "pad_cooling" ? (PROVISIONAL_PLAIN[pkg.itemKey] ?? "Provisional: the product and its parts are still to be confirmed, so this price may change.") : "Provisional: the parts are confirmed, but the Estimator has not yet signed off the package and quantity, so this price may change.",
  };
}

/** The items a BULK "confirm source-backed" action may confirm: only packages that are authoritative and complete. Anything needing the Estimator's own decision (LED, cup drinker) is excluded. */
export function bulkConfirmablePackageKeys(itemKeys: readonly GrowerItemKey[], revision: TemplateRevision): GrowerItemKey[] {
  return itemKeys.filter((k) => packageAutoConfirmable(packageFor(k, revision)));
}

/** SKUs an estimator may pick BETWEEN by hand for an item (never auto-confirmed). Excluded SKUs are never offered. */
export function manualSelectionSkusFor(itemKey: GrowerItemKey, revision: TemplateRevision): string[] {
  const m = commercialMappingFor(itemKey, revision);
  return m?.kind === "unresolved" ? (m.manualSelectionSkus ?? []).filter((s) => !isExcludedSku(s)) : [];
}

/**
 * SKUs the Grower House must never offer or accept (Sean / Tereesha 2026-11). The reason is shown to the Estimator. A mapping to one is refused when it is stored and at sign-off, and it is
 * never offered as a candidate. Nothing here rewrites any stored quotation scope or saved package mapping.
 */
export const EXCLUDED_SKUS: Readonly<Record<string, string>> = {
  "SYSH-2750-4": "DON'T QUOTE (Sage and Cin7 product name; Spark/NewQuip decision 2026-11-26): never offered, never a valid choice for the bulk tank.",
  NQ1984: "Excluded from the Grower House (Sean, 2026-11). It is the M75 drop kit WITHOUT knobs and rope; the complete drop kit is NQ1942.",
};
export const isExcludedSku = (sku: string): boolean => Object.prototype.hasOwnProperty.call(EXCLUDED_SKUS, sku);

/**
 * Products Sean / Tereesha said are INCLUDED, as a deliberate Estimator CHOICE within one item. They are never default, never added to every quotation, and never added in addition to the item's own line
 * (selecting one replaces that item's product). Without a supported engineering rule that is all that can be said of them.
 */
export interface SelectableAlternative { itemKey: GrowerItemKey; sku: string; label: string; caution: string }
export const SELECTABLE_ALTERNATIVES: readonly SelectableAlternative[] = [
  { itemKey: "feeder", sku: "PNQ002", label: "CCM FEEDER FOR GROWERS (PNQ002)", caution: "Included by Sean (2026-11). How it relates to the standard PNQ082 (with monoflo nipples) was not stated, so it is an Estimator choice for the feeder line: never automatic, and never an extra line beside the feeder." },
];
export const alternativesFor = (itemKey: GrowerItemKey): SelectableAlternative[] => SELECTABLE_ALTERNATIVES.filter((a) => a.itemKey === itemKey);

/**
 * Products in a SAVED reusable package mapping that Sean / Tereesha's 2026-11 answers contradict or do not confirm. A saved mapping is a Manager's decision and is never rewritten or deleted here
 * (it is versioned history); this only lets the scope view say, beside that mapping, that it should be replaced by a new version. Returns the notice, or null when nothing in it is flagged.
 */
const SAVED_MAPPING_CAUTIONS: Readonly<Record<string, { skus: readonly string[]; text: string }>> = {
  led_light: { skus: ["HO12011000", "HO17050750", "HO21013750"], text: "These are a revolving light and light-trap parts, not the Grower House LED. Sean (2026-11) confirmed HNQ7046, HNQ7093 and HNQ7088: save a new mapping version." },
  penning_package: { skus: ["DPL-PVC20X600", "KNQ074", "KNQ196", "KNQBP1010", "KNQCP005"], text: "These are not on Sean's 2026-11 Grower Penning Posts list (custom polypropylene panels have no stock SKU). Replace this mapping with a new version built from that list." },
};
export function savedMappingCaution(packageKey: string, skus: readonly string[]): string | null {
  const c = SAVED_MAPPING_CAUTIONS[packageKey];
  if (!c) return null;
  const hit = skus.filter((s) => c.skus.includes(s));
  return hit.length > 0 ? `Saved mapping holds ${hit.join(", ")}. ${c.text}` : null;
}

/** Cin7 product names (synced catalogue copy) for the SKUs an Estimator chooses between by hand, so no UI component carries its own product text. */
export const CHOICE_PRODUCT_NAMES: Readonly<Record<string, string>> = {
  NQ2112: "WHITE DOOR WITH UV 35MM (1980L × 600W)", NQ2113: "WHITE DOOR WITH UV 35MM (1980L × 1000W) NO WINDOWS", NQ2114: "WHITE DOOR WITH UV 35MM (1970L × 1000W)", // the original template's doors (quotations created under it keep them)
  NQ3444: "PVC SINGLE DOORS: Sean's proposed Grower House door. Cin7 gives no size, so confirm the door and its size",
  NQ2161: "WHITE DOOR WITH UV 35MM (1980 × 1000W) WITH WINDOWS",
  NQ2281: "35MM WHITE DOOR (1990 × 790MM)",
};

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
  SELECTABLE_ALTERNATIVES.forEach((a) => out.add(a.sku));
  return [...out].filter((s) => !isExcludedSku(s));
}
