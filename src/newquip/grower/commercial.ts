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
}

export type CommercialMapping = SingleSkuMapping | PackageMapping | ManualMapping | UnresolvedMapping;

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
  feeder: single("feeder", "PNQ082",
    `${WB} sheet CCM: PNQ082 'CCM FEEDER … WITH MONOFLO NIPPLE FOR GROWERS' is activated, PNQ002 deactivated. PNQ082-WINDOW is a window variant.`),
  feed_saver_mat: single("feed_saver_mat", "ERT053",
    "Only 1000 × 1000 mm feed saver mat in Cin7; the workbook gives no code (price formula only).", "medium-high"),
  concrete_slat: single("concrete_slat", "NQ1161",
    "Cin7 'CONCRETE SLAT (12x045M)' = ERP '(1.2x0.45M)'; the workbook price 203 ≈ ERP latest cost 193.60 × 1.05. Delivery is a SEPARATE charge (see slat delivery)."),

  // ---- packages ----
  cup_drinker: {
    kind: "package", itemKey: "cup_drinker", name: "Grower cup drinker", layoutDriven: false,
    provenance: `${WB} sheet 'cup', GROWER CUP block (rows 43–49); subtotal R475.99 × 1.15 = R548 per drinker.`,
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
    provenance: `${WB} sheet 'FX': €25.50 + 3 × €0.74 + €1.37 = €29.09 per light. Sold as FORTIS; named 'FERAX 24W ON/OFF' in the ERP and Cin7.`,
    components: [
      { ...fixed("luminaire", "HNQ7046", "FORTIS 1.2 5000K luminaire (Cin7/ERP name: FERAX 24W ON/OFF)", 1, "FX!A4; ERP avg R484.29 ≈ €25.5 × 19.08"), },
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
    kind: "package", itemKey: "flex_auger", name: "M75 Flex auger system", layoutDriven: true,
    provenance: `${WB} sheet 'W1' (Topigs case: 2 × lines of ±49.5m, 18 drop kits). Quantities below are the HISTORIC TOPIGS PACKAGE REFERENCE — formula-driven in the workbook, not authorised engineering rules.`,
    components: [
      layout("auger", "NQ1163", "Auger M-75 (new), per metre", 134, "W1 row 71"),
      layout("tube", "T2750300", "Tube M75 (white) 3075mm with cone", 40, "W1 row 52"),
      layout("clamps", "T2750015", "Tube clamps M75", 48, "W1 row 56"),
      layout("elbow", "T2750301", "M75 PVC elbow (white) radius 1.5m", 8, "W1 row 64"),
      layout("dropkit", "NQ1984", "M75 drop kit (pig/sheep, excl. knobs & nylon rope)", 18, "W1 row 13; input B2 = 18 drops"),
      layout("droptube", "NQ.TUBE.63", "63mm clear drop tube (2m)", 5, "W1 row 14 = ROUNDUP(drops / 4)", { note: "In the legacy ERP but NOT found in Cin7 under this SKU." }),
      layout("control", "T3750001", "M75 control unit with safety switch", 2, "W1 row 39"),
      layout("unloader", "TSA3750505", "M75 unloader double right/left (new type)", 1, "W1 row 35"),
      layout("levelswitch", "T3000365", "Feed level switch dia 75mm", 2, "W1 row 18"),
      layout("drive", "TRA1.1KW3PH", "1.5HP drive unit (1.1kW) 380V", 2, "W1 row 77", { note: "In the legacy ERP but NOT found in Cin7 under this SKU." }),
      layout("post", null, "Support post (SST)", 52, "W1 row 83 — SKU cell truncated ('KNQ'), price R760", {
        candidateSkus: ["NQ2601"], identity: "uncertain", note: "NQ2601 'HEAVY DUTY SUPPORT POST SST(1M)' is a likely match but NOT confirmed.",
      }),
      layout("wallplate", "KNQ160", "Wall plate (SST) kit for M55 & M75 auger", 4, "W1 row 97"),
    ],
  },
  penning_package: {
    kind: "package", itemKey: "penning_package", name: "PP Green 50mm × 0.9m vented penning", layoutDriven: true,
    provenance: `${WB} sheet 'G Posts (2)': panels R135,257 + hardware R152,529 = R287,786 for 20 pens. Quantities are typed layout figures — HISTORIC REFERENCE only. Colour cell reads 'green?'.`,
    components: [
      layout("panels", null, "PP 50mm venti 0.9m high panels (total length, metres)", 244.87, "G Posts (2) rows 41–47", {
        note: "No 0.9m green 50mm panel found in Cin7 (BPP007 is 1m black; BPP013 is 35mm green). SKU and colour to be confirmed.",
      }),
      layout("doorkit", "KNQ074", "Plastic door kit (gates for 50mm PP penning)", 20, "G Posts (2) row 10"),
      layout("doorcap", "KNQ085", "Cap for door SST / 50mm panel", 20, "G Posts (2) row 11"),
      layout("starter", null, "SST starter post 800mm-H", 55, "G Posts (2) row 14 (no code)"),
      layout("starterfoot", null, "SST double bracket (foot) for starter", 55, "G Posts (2) row 13 (no code)"),
      layout("hdpost", null, "SST heavy duty support post (50mm panel)", 104, "G Posts (2) row 15 (no code)", {
        candidateSkus: ["KNQ050-900", "KNQ050-1000"], identity: "uncertain", note: "Cin7 has 50mm-panel support posts of two heights; not confirmed.",
      }),
      layout("footangled", null, "SST foot bracket (angled)", 121, "G Posts (2) row 16 (no code)"),
      layout("coachscrew", "NQ1175", "Coach screw M8×60 SST", 165, "G Posts (2) row 18"),
      layout("washerscrew", "NQ1017", "Washer M8×25×2 SST (coach screws)", 165, "G Posts (2) row 19"),
      layout("wallplug", "NQ1089", "Wall plug grey No.10", 165, "G Posts (2) row 20"),
      layout("bolt", "NQ1386", "Bolt M8×65 SST", 598, "G Posts (2) row 21"),
      layout("washerbolt", "NQ1017", "Washer M8×25×2 SST (bolts)", 1196, "G Posts (2) row 22"),
      layout("nut", "NYNUT", "Nylock nut M8 SST", 598, "G Posts (2) row 23"),
      layout("dtbar", "NQ2072", "M10×90mm SST double T-bar", 104, "G Posts (2) row 24"),
      layout("washerm10", "NQ1086", "Washer M10×40×3 SST", 329, "G Posts (2) row 25"),
      layout("nutm10", "NQ1126", "Nylock nut M10 SST", 329, "G Posts (2) row 26"),
      layout("stbar", "NQ1199", "Single T-bar M10 SST", 121, "G Posts (2) row 27"),
    ],
  },

  // ---- unresolved ----
  pvc_door: { kind: "unresolved", itemKey: "pvc_door", reason: "NEWQUIP CONFIRMATION REQUIRED — no code or price in the source; Cin7 has many PVC/polypropylene doors." },
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
  const out = new Set<string>();
  for (const m of Object.values(COMMERCIAL_MAPPINGS)) {
    if (!m) continue;
    if (m.kind === "single") out.add(m.recommendedSku);
    if (m.kind === "package") for (const c of m.components) { if (c.sku) out.add(c.sku); c.candidateSkus?.forEach((s) => out.add(s)); }
  }
  return [...out];
}
