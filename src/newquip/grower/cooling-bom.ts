// SUMPLESS PAD COOLING: the CONFIRMED bill-of-materials quantities (NEWQUIP_GROWER_PRICING_HANDOFF_2026-11-25, section 6). PURE: it returns a list of SKUs and quantities for one system of a given length. It prices
// nothing, reads no cost and is NOT yet wired into a quotation: a system length input, the labour days and the travel / food / accommodation charges are separate, owner-approved steps (see
// docs/newquip/NEWQUIP_GROWER_PRICING_IMPLEMENTATION_MATRIX.md). Costs are the current Cin7 component costs, looked up at run time by the existing pricing engine.
//
// Every formula below is the handoff's. The three places the handoff leaves a reading open are returned in `assumptions` so no caller can present them as settled:
//   A1  for a system over 20 m "every plumbing quantity doubles": the UNROUNDED quantity is doubled and then rounded up to whole containers (acetone and Sikaflex 1.5 -> 3, not 2 -> 4).
//   A2  KNQCOOL16 (cleaning fittings) is a gutter-section item, 2 per system, and is NOT doubled over 20 m.
//   A3  no supported length range was given: lengths outside 0.6 m (one pad) to 200 m are refused as an input-sanity check, not a commercial rule; a system of 3 m or less has no middle gutter kit.

export type CoolingSection = "gutter" | "pad" | "fixings" | "plumbing";
export interface CoolingLine { sku: string; description: string; section: CoolingSection; quantity: number }
export interface CoolingBom { lengthM: number; plumbingDoubled: boolean; lines: CoolingLine[]; assumptions: string[] }

/** Input-sanity bounds, NOT commercial rules (the handoff gave none). The minimum is one pad (0.6 m): below it no pad would be quoted. The maximum only stops an absurd or mistyped length from producing absurd quantities; NewQuip to confirm. */
export const COOLING_MIN_LENGTH_M = 0.6;
export const COOLING_MAX_LENGTH_M = 200;


/** A system longer than this has every plumbing quantity doubled; exactly this length does not. */
export const COOLING_DOUBLE_PLUMBING_OVER_M = 20;
const GUTTER_SECTION_M = 3;
const PAD_LENGTH_M = 0.6;

/** Plumbing per system at 20 m or less, from the handoff's 12 m example. `raw` may be fractional: it is rounded up to whole containers AFTER any doubling. */
const PLUMBING: ReadonlyArray<{ sku: string; description: string; raw: number }> = [
  { sku: "NQ3330", description: "50mm single union ball valve", raw: 4 },
  { sku: "NQ3331", description: "50mm 90° plain elbow", raw: 10 },
  { sku: "NQ3332", description: "50mm plain union", raw: 4 },
  { sku: "NQ3333", description: "50->25mm 90° reducing tee", raw: 1 },
  { sku: "NQ3334", description: "25mm single union ball valve", raw: 1 },
  { sku: "NQ3335", description: "2-inch PP tank connector", raw: 1 },
  { sku: "NQ3336", description: "1.5-inch non-return valve", raw: 1 },
  { sku: "NQ2968", description: "50mm strainer", raw: 1 },
  { sku: "N3771", description: "1000mic sediment filter element", raw: 1 },
  { sku: "NQ3339", description: "Male thread adaptor 50x63x1.5", raw: 1 },
  { sku: "NQ3340", description: "Male thread adaptor 50x63x2", raw: 1 },
  { sku: "NQ3338", description: "Female spigot thread adaptor 50mm x 2", raw: 3 },
  { sku: "NQ3341", description: "50mm Class 9 grey pipe (6 m length)", raw: 1 },
  { sku: "NQ1118", description: "Pump", raw: 1 },
  { sku: "NQ3368", description: "Pump cover", raw: 1 },
  { sku: "NQ1211", description: "M8x20 SST bolt", raw: 11 },
  { sku: "NQ1342", description: "M8 nut", raw: 11 },
  { sku: "NQ1029", description: "M8x60 coach screw", raw: 6 },
  { sku: "NQ1089", description: "Wall plug No.10", raw: 6 },
  { sku: "NQ3275", description: "M8x15 washer", raw: 6 },
  { sku: "NQ3369", description: "Acetone 500ml", raw: 1.5 },
  { sku: "NQ3382", description: "Mutton cloth roll", raw: 1 },
  { sku: "NQ3344", description: "Sikaflex 551 600ml", raw: 1.5 },
  { sku: "NQ1532", description: "PTFE plumbing tape", raw: 2 },
  { sku: "NQ2185", description: "PVC glue 500ml", raw: 3 },
];

/** Exact ceiling for decimal inputs such as 20.1 / 0.6 (floating point would give 33.5000…4 and similar). */
const ceilDiv = (a: number, b: number): number => Math.ceil(Math.round((a / b) * 1e9) / 1e9);

export function coolingBom(lengthM: number): CoolingBom {
  if (!Number.isFinite(lengthM) || lengthM <= 0) throw new Error("The cooling system length must be a number greater than zero.");
  if (lengthM < COOLING_MIN_LENGTH_M || lengthM > COOLING_MAX_LENGTH_M) throw new Error(`The cooling system length must be between ${COOLING_MIN_LENGTH_M} m and ${COOLING_MAX_LENGTH_M} m.`);
  const basic = 1;
  const middle = Math.max(0, ceilDiv(lengthM, GUTTER_SECTION_M) - 1);
  const waterTank = 1;
  const pads = ceilDiv(lengthM, PAD_LENGTH_M);
  const rods = 4 * (basic + middle) + 2 * waterTank;
  const doubled = lengthM > COOLING_DOUBLE_PLUMBING_OVER_M;
  const lines: CoolingLine[] = [
    { sku: "KNQCOOL02", description: "Basic gutter kit (3m)", section: "gutter", quantity: basic },
    { sku: "KNQCOOL03", description: "Middle gutter kit (3m)", section: "gutter", quantity: middle },
    { sku: "KNQCOOL16", description: "2.5-inch cleaning fitting", section: "gutter", quantity: 2 },
    { sku: "KNQCOOL04", description: "Water tank kit", section: "gutter", quantity: waterTank },
    { sku: "KNQCOOL01", description: "Cooling paper pad 1500x600x150 mm", section: "pad", quantity: pads },
    { sku: "NQ2550", description: "M8 x 1m threaded rod SST", section: "fixings", quantity: rods },
    { sku: "NYNUT", description: "M8 SST nylock nuts", section: "fixings", quantity: rods * 6 },
    { sku: "NQ1964", description: "M8x20 SST washers", section: "fixings", quantity: rods * 3 },
    ...PLUMBING.map((p) => ({ sku: p.sku, description: p.description, section: "plumbing" as const, quantity: Math.ceil(Math.round(p.raw * (doubled ? 2 : 1) * 1e9) / 1e9) })),
  ];
  return {
    lengthM, plumbingDoubled: doubled, lines,
    assumptions: [
      "Over 20 m every plumbing quantity is doubled before it is rounded up to whole containers (acetone and Sikaflex: 1.5 becomes 3). NewQuip to confirm.",
      "KNQCOOL16 (cleaning fitting) stays at 2 per system and is not doubled over 20 m, because it is counted once, in the gutter section. NewQuip to confirm.",
      `No supported length range was given. Lengths are accepted from ${COOLING_MIN_LENGTH_M} m (one pad) to ${COOLING_MAX_LENGTH_M} m as an input-sanity check only; a system of 3 m or less has no middle gutter kit. NewQuip to confirm.`,
    ],
  };
}
