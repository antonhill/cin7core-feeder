// NQ-Q-0020 regression (2026-11-26): a Rep Budget with the PVC door size unchosen has an UNPRICED door, and so must never become a usable PDF. With every supported door size chosen the door is
// provisionally priced and the Budget is complete. Neutral FIXTURE amounts only (no NewQuip cost is in the repository).
import { describe, expect, it } from "vitest";
import type { QuoteDraft } from "../draft";
import { evaluateDraft } from "../evaluate";
import { createWorkbookPriceSource } from "../workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "../snapshot";
import { DOOR_SIZES, DOOR_SIZE_KEYS, DOOR_SIZE_REQUIRED_REASON } from "../door-sizes";
import { UAT_PROVISIONAL_ENV, uatProvisionalRatesFromEnv } from "../uat-provisional-basis";
import { nqQ0002 } from "./nq-q-0002-fixture";
import { ownedWork } from "@/newquip/quote/stage1-steps";

const ENV = JSON.stringify(Object.fromEntries(DOOR_SIZE_KEYS.map((k, i) => [`pvc_door|${DOOR_SIZES[k].specification}`, { amount: 8000 - i * 500, asOf: "2026-11-24" }])));
const rates = uatProvisionalRatesFromEnv({ [UAT_PROVISIONAL_ENV]: ENV });
const withDoor = (size: string | null): QuoteDraft => { const d = structuredClone(nqQ0002()) as QuoteDraft & { config: Record<string, unknown> }; d.config.doorSize = size as never; return d; };
const budgetOf = (d: QuoteDraft) => evaluateDraft(d, { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: true, provisionalPackages: true, budgetAsOf: "2026-11-26", uatProvisionalRates: rates });
const doorLine = (d: QuoteDraft) => budgetOf(d).budget!.lines.find((l) => l.itemKey === "pvc_door")!;

describe("PVC door size and Budget completeness", () => {
  it.each(DOOR_SIZE_KEYS)("door size %s chosen: the door is PROVISIONALLY priced (explicit, traceable source) and the door adds no unpriced item", (size) => {
    const l = doorLine(withDoor(size));
    expect(l.status).toBe("priced");
    expect(l.pricedBy).toBe("budget_rate");
    expect(l.provisional?.plain).toBeTruthy();
    expect(l.unitPrice).toBeGreaterThan(0);
  });
  it("NO door size chosen (the NQ-Q-0020 configuration): the door is unpriced and says WHY with the Rep-owned reason", () => {
    const l = doorLine(withDoor(null));
    expect(l.status).not.toBe("priced");
    expect(l.reason).toBe(DOOR_SIZE_REQUIRED_REASON);
  });
  it("the missing door size is the REP's item (Equipment step), never an Estimator task", () => {
    const l = doorLine(withDoor(null));
    const w = ownedWork({ lines: [], budgetLines: [{ label: l.label, status: l.status, reason: l.reason ?? "" }], blankExclusionCount: 0, blankPriceReasonCount: 0, charges: [] } as never);
    expect(w.rep).toContain(`${l.label}: choose the door size`);
    expect(w.estimator.join(" ")).not.toMatch(/door/i);
  });
  it("an unmapped door for any OTHER reason stays an Estimator product choice", () => {
    const w = ownedWork({ lines: [], budgetLines: [{ label: "PVC SST door (incl. frame)", status: "unmapped", reason: "Product mapping not yet confirmed." }], blankExclusionCount: 0, blankPriceReasonCount: 0, charges: [] } as never);
    expect(w.rep).toEqual([]);
    expect(w.estimator.join(" ")).toMatch(/door/i);
  });
});
