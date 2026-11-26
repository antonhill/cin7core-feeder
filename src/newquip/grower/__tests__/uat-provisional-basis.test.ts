// UAT-ONLY PROVISIONAL BASIS: isolated, env-supplied, never an approval. Neutral FIXTURE amounts only (no NewQuip cost is in the repository).
import { describe, expect, it } from "vitest";
import type { QuoteDraft } from "../draft";
import { evaluateDraft } from "../evaluate";
import { createWorkbookPriceSource } from "../workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "../snapshot";
import { DOOR_SIZES } from "../door-sizes";
import { ACTIVE_BUDGET_BASIS } from "../budget-basis-register";
import { UAT_PROVISIONAL_ENV, UAT_PROVISIONAL_PLAIN, uatProvisionalRatesFromEnv } from "../uat-provisional-basis";
import { nqQ0002 } from "./nq-q-0002-fixture";

const ENV = JSON.stringify({
  [`pvc_door|${DOOR_SIZES["2.1x1.2"].specification}`]: { amount: 8000, asOf: "2026-11-24" },
  [`pvc_door|${DOOR_SIZES["2.1x1.0"].specification}`]: { amount: 7500, asOf: "2026-11-24" },
});
const rates = uatProvisionalRatesFromEnv({ [UAT_PROVISIONAL_ENV]: ENV });
const door = (size: string | null): QuoteDraft => { const d = structuredClone(nqQ0002()) as QuoteDraft & { config: Record<string, unknown> }; d.config.doorSize = size as never; return d; };
const line = (d: QuoteDraft, over: Record<string, unknown> = {}) => evaluateDraft(d, { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: false, provisionalPackages: true, budgetAsOf: "2026-11-26", uatProvisionalRates: rates, ...over }).budget!.lines.find((l) => l.itemKey === "pvc_door")!;

describe("UAT provisional door basis", () => {
  it("parses only well-formed entries and never throws", () => {
    expect(uatProvisionalRatesFromEnv({})).toEqual([]);
    expect(uatProvisionalRatesFromEnv({ [UAT_PROVISIONAL_ENV]: "not json" })).toEqual([]);
    expect(uatProvisionalRatesFromEnv({ [UAT_PROVISIONAL_ENV]: JSON.stringify({ "pvc_door|x": { amount: -1, asOf: "2026-11-24" }, "nobar": { amount: 5, asOf: "2026-11-24" }, "pvc_door|y": { amount: 5, asOf: "yesterday" } }) })).toEqual([]);
    expect(rates).toHaveLength(2);
  });
  it("prices each size from its OWN basis: cost x 1.20 once, no freight; always provisional with a Rep-safe, UAT-labelled message", () => {
    const a = line(door("2.1x1.2")); const b = line(door("2.1x1.0"));
    expect(a).toMatchObject({ status: "priced", unitPrice: 9600, pricedBy: "budget_rate" }); expect(b).toMatchObject({ status: "priced", unitPrice: 9000 });
    expect(a.revenueExTax).toBeCloseTo(24 * 9600, 2); expect(b.revenueExTax).toBeCloseTo(24 * 9000, 2);
    expect(a.provisional?.plain).toBe(UAT_PROVISIONAL_PLAIN); expect(a.provisional?.plain).not.toMatch(/R\d|cost|markup|margin|freight|NQ3444/i);
  });
  it("with no size, with the variable absent, or in a non-Budget evaluation nothing is priced from it", () => {
    expect(line(door(null)).status).not.toBe("priced");
    expect(line(door("2.1x1.2"), { uatProvisionalRates: undefined }).status).not.toBe("priced");
    expect(line(door("2.1x1.2"), { provisionalPackages: false }).status).not.toBe("priced");
  });
  it("it never overrides the real register or an Estimator's own product, and the shipped register is still empty", () => {
    expect(ACTIVE_BUDGET_BASIS).toHaveLength(0);
    const d = door("2.1x1.2"); d.estimator.confirmedMappings = { pvc_door: "NQ2161" } as never;
    expect(line(d).mappingSource).toBe("estimator");
  });
  it("it is only for the door of the CURRENT template", () => {
    const d = door("2.1x1.2"); delete (d.estimator as { templateRevision?: string }).templateRevision;
    expect(line(d).status).not.toBe("priced");
  });
});
