import { describe, expect, it } from "vitest";
import { isPlausibleCandidate, resolveMapping, MAPPING_MATCHERS, type MappingCandidate } from "../mapping";
import type { GrowerItemKey } from "../types";

// Real NewQuip catalogue names (read-only audit, 2026-10-13). Each item's pool mixes the products a keyword
// search returns — the right ones AND parts/accessories/other sizes — to prove ONE definition separates them.
type P = [sku: string, name: string];
const POOLS: Record<string, P[]> = {
  bulk_tank: [
    ["SYSH-2750-4", "1658 TONS SILO (NEWQUIP BRANDED) - DONT QUOTE"], ["KNQ112", "8TON SILO (SQUARE)"], ["NQ2176", "SILO 109MT INCL LADDER"],
    ["NQ1939", "SILO ANCHOR"], ["NQ2229", "ROOF SHEET FOR 9FT SILO"], ["HO05070600", "SIRIUS-SWS (POULTRY) / SILO WEIGH CONTROLLER"],
  ],
  flex_auger: [
    ["T1750005", "AUGER M75"], ["T024", "3750001 STRIPPED M75 CONTROL UNIT"], ["T020", "2750016 M75 DROP KIT EXCL KNOBS & NYLON ROPE"],
    ["T1000432", "FASTNING CLAMP / AUGER (SHAFT M75/M90)"], ["NQ3383", "DBL PIPE WALL COVER (FLEX AUGER PIPES) INCL RUBBER"],
  ],
  feeder: [
    ["PNQ002", "CCM FEEDER FOR GROWERS"], ["PNQ082", "CCM FEEDER FOR GROWERS WITH MONOFLO NIPPLE"], ["PNQ082-WINDOW", "CCM FEEDER INCL MONOFLO NIPPLE & WINDOW (GROWERS)"],
    ["PNQ014", "CCM FEEDER FOR WEANERS (DO NOT USE)"], ["PNQ029", "DOSING BRACE / CCM FEEDER"], ["PNQ037", "DOSING UNIT / CCM FEEDER"], ["PNQ016", "FEED ADJUST HANDLE (LEFT) / CCM FEEDER"],
  ],
  feed_saver_mat: [
    ["ERT053", "FEED SAVER MAT 8/10MM ANTI-SLID (1000X1000MM)"], ["ERT041", "FEED SAVER MAT 8MM (LENGTH=1000MM & WIDTH=600MM)"],
    ["ERT042", "FEED SAVER MAT 8MM (LENGTH=600MM & WIDTH=600MM)"], ["ERT009", "FEED SAVER MAT 8MM  (LENGTH = 3M & WIDTH = 05M)"],
  ],
  cup_drinker: [
    ["NB3542-03", "CUP DRINKERS (NEW TYPE) GROWER & FINISHER"], ["NB3543-30", "CUP DRINKERS (OLD TYPE) 30WP/ GROWER & FINISHER"],
    ["NB3542-02", "CUP DRINKERS (NEW TYPE) WEANER"], ["NB3542-04", "CUP DRINKERS (NEW TYPE) SOW"], ["QCA00005", "CUP DRINKER (245CM SST PIPE) FOR SOW"],
    ["NQ1744", "CUP DRINKER NIPPLE SOCKET(WEANER/GROWER)"], ["NQSP0016", "CUP DRINKER BRACKET (2PCS PER SET) / STEEL PENNING"],
  ],
  concrete_slat: [
    ["NQ1161", "CONCRETE SLAT (12x045M)"], ["NQ2341", "CONCRETE SLAT (1200x458x70)"], ["NQ2773", "CONCRETE SLAT (115M X 045M)"],
    ["NQ2197", "CONCRETE SLAT ( 900MM X 450MM )"], ["NQ1236", "CONCRETE SLAT MOULD (12x045M)"], ["NQ150/01", "CONCRETE SLAT FASTENER"],
  ],
  penning_package: [
    ["BPP007", "PP 50MM VENTI 1M HIGH (BLACK) (PER METER)"], ["BPP013", "PP 35MM VENTI 800MM HIGH(RECYCLED GREEN-PER METER)"], ["BPP006", "PP 50MM SOLID 1M HIGH (BLACK) (PER METER)"],
  ],
  led_light: [
    ["ONC1000000265", "TULEX-HO-120-BASIC-3000K (LED TUBE LIGHT)"], ["NQ2401", "50W LED FLOOD LIGHT & CABLE"], ["NQCP607", "LED CONTROL PANEL"],
  ],
  pvc_door: [
    ["NQ3118", "POLYPROP SINGLE DOOR INCL SST (1010MM X 2055MM)"], ["NQ3119", "POLYPROP SINGLE DOOR INCL SST (580MM X 1805MM)"], ["NQ3120", "POLYPORP SINGLE DOOR INCL SST (1180MM X 2125MM)"],
    ["ERT013", "PVC DOOR WITH ALU FRME & RUB JNT 2000x1000MM(LEFT)"], ["NQ2837", "PVC DOOR 2MX800MM  INCLUDING FRAME(COLCOM)"],
    ["NQ2308", "DOOR POST LOCK SST (SPECIAL) L/H"], ["NQ2808", "DOOR HANDLE 2510MM X 250MM SST 304"], ["KNQ085", "CAP FOR DOOR SST (H= 780MM) / 50MM PANEL"],
  ],
};

function candidatesFor(item: GrowerItemKey): MappingCandidate[] {
  return (POOLS[item] ?? []).filter(([, name]) => isPlausibleCandidate(item, name)).map(([sku, name]) => ({ sku, name }));
}
const skus = (item: GrowerItemKey) => candidatesFor(item).map((c) => c.sku).sort();
const status = (item: GrowerItemKey, confirmed: string | null = null) => resolveMapping(item, candidatesFor(item), confirmed, new Set()).status;

describe("one definition of a plausible candidate (known Grower cases)", () => {
  it("UNMAPPED — no plausible candidate, despite loose keyword hits", () => {
    for (const item of ["bulk_tank", "flex_auger", "penning_package", "led_light"] as const) {
      expect(candidatesFor(item)).toEqual([]);
      expect(status(item)).toBe("UNMAPPED");
    }
  });
  it("AMBIGUOUS — plausible candidates, none confirmed", () => {
    expect(skus("feeder")).toEqual(["PNQ002", "PNQ082", "PNQ082-WINDOW"]);
    expect(skus("cup_drinker")).toEqual(["NB3542-03", "NB3543-30"]);
    expect(skus("concrete_slat")).toEqual(["NQ1161", "NQ2341"]);
    expect(skus("pvc_door")).toEqual(["ERT013", "NQ3118", "NQ3119", "NQ3120"]);
    for (const item of ["feeder", "cup_drinker", "concrete_slat", "pvc_door"] as const) expect(status(item)).toBe("AMBIGUOUS");
  });
  it("a single plausible candidate is still AMBIGUOUS — never auto-confirmed", () => {
    expect(skus("feed_saver_mat")).toEqual(["ERT053"]);
    const r = resolveMapping("feed_saver_mat", candidatesFor("feed_saver_mat"), null);
    expect(r.status).toBe("AMBIGUOUS");
    expect(r.sku).toBeNull();
  });
  it("MAPPED only after explicit confirmation of a known candidate", () => {
    expect(status("feeder", "PNQ082")).toBe("MAPPED");
    expect(resolveMapping("feeder", candidatesFor("feeder"), "PNQ082").sku).toBe("PNQ082");
  });
  it("a confirmation of an unknown SKU is UNMAPPED, not MAPPED", () => {
    expect(status("feeder", "NOPE")).toBe("UNMAPPED");
  });
  it("a historic description alone is never a candidate", () => {
    expect(resolveMapping("led_light", [], null).status).toBe("UNMAPPED");
  });
});

describe("matcher table", () => {
  it("covers every mappable Grower item exactly once, none naming a SKU", () => {
    const keys = MAPPING_MATCHERS.map((m) => m.itemKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(expect.arrayContaining(["bulk_tank", "flex_auger", "feeder", "feed_saver_mat", "cup_drinker", "concrete_slat", "penning_package", "led_light", "pvc_door"]));
    expect(JSON.stringify(MAPPING_MATCHERS.map((m) => m.reason))).not.toMatch(/[A-Z]{2,}\d{3,}/);
  });
});
