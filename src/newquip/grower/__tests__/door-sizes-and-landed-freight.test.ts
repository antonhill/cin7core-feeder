// DOOR SIZES (explicit Rep selection, one Budget basis per size) and PRICE-SOURCE-LEVEL landed freight. Every approval below is a FIXTURE for the test: the shipped register stays EMPTY and no real approver is implied.
import { describe, expect, it } from "vitest";
import type { QuoteDraft } from "../draft";
import { evaluateDraft } from "../evaluate";
import { createWorkbookPriceSource } from "../workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "../snapshot";
import { calculateGrowerHouse } from "../calculate";
import { DOOR_SIZES, doorSpecificationFor, isDoorSize } from "../door-sizes";
import type { BudgetBasisEntry } from "../budget-basis";
import { ACTIVE_BUDGET_BASIS } from "../budget-basis-register";
import { autoCostFor, isFlag, NO_LANDED_SKUS } from "../../pricing/auto-costing";
import { emptyCommercialSettings, type CommercialSettings } from "../../pricing/commercial-settings";
import type { MasterSupplier, SurveyInput } from "../../pricing/cost-survey";
import { nqQ0002 } from "./nq-q-0002-fixture";

const entry = (size: "2.1x1.2" | "2.1x1.0", amount: number): BudgetBasisEntry => ({
  kind: "rate", itemKey: "pvc_door", specification: DOOR_SIZES[size].specification, unit: "each", amount, currency: "ZAR", basis: "cost",
  evidence: { kind: "product_owner_confirmation", reference: "FIXTURE evidence", asOf: "2026-11-24", verified: true, uncertainty: null },
  approval: { approvedBy: "FIXTURE Approver", role: "NewQuip Manager", approvedAt: "2026-11-25T08:00:00Z", reference: "FIXTURE approval ref (outside the code)", enteredBy: "FIXTURE Developer" },
  effectiveFrom: "2026-11-01", expiresOn: "2027-03-31",
});
const REG = [entry("2.1x1.2", 8000), entry("2.1x1.0", 7500)];
const ctx = (register: readonly BudgetBasisEntry[] = REG) => ({ priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: false, provisionalPackages: true, budgetBasis: register, budgetAsOf: "2026-11-25" });
const door = (size: string | null, qty = 24, rooms = 12): QuoteDraft => {
  const d = structuredClone(nqQ0002()) as QuoteDraft & { config: Record<string, unknown> };
  d.config.estimatorQuantities = { ...d.config.estimatorQuantities, pvc_door: qty / rooms };
  d.config.doorSize = size as never;
  return d;
};
const line = (d: QuoteDraft, register?: readonly BudgetBasisEntry[]) => evaluateDraft(d, ctx(register)).budget!.lines.find((l) => l.itemKey === "pvc_door")!;

describe("PVC door sizes: explicit selection, one Budget basis per size, markup once, no freight", () => {
  it("the shipped register is EMPTY, so no door is priced and no approver is implied", () => {
    expect(ACTIVE_BUDGET_BASIS).toHaveLength(0);
    const l = evaluateDraft(door("2.1x1.2"), { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: false, provisionalPackages: true }).budget!.lines.find((x) => x.itemKey === "pvc_door")!;
    expect(l.status).not.toBe("priced"); expect(l.revenueExTax).toBeNull();
  });
  it("2.1 x 1.2 m prices at cost x 1.20 ONCE (R9,600 each, fixture cost R8,000), no freight; 2.1 x 1.0 m at R9,000 each (fixture cost R7,500)", () => {
    const a = line(door("2.1x1.2"));
    expect(a.status).toBe("priced"); expect(a.unitPrice).toBe(9600); expect(a.revenueExTax).toBeCloseTo(24 * 9600, 2); expect(a.provisional).toBeDefined();
    const b = line(door("2.1x1.0"));
    expect(b.unitPrice).toBe(9000); expect(b.revenueExTax).toBeCloseTo(24 * 9000, 2);
    // 8000 x 1.2 = 96004; 7500 x 1.2 = 10541.736: one markup, no 1.15 freight anywhere.
    expect(a.unitPrice).not.toBeCloseTo(8000 * 1.15 * 1.2, 0);
  });
  it("with NO size chosen the door is unpriced and asks for the size (never a default size)", () => {
    const l = line(door(null));
    expect(l.status).not.toBe("priced"); expect(l.reason).toMatch(/Choose the door size/);
  });
  it("a size is priced only from an entry approved for exactly that size; the other size's entry never leaks", () => {
    expect(line(door("2.1x1.0"), [entry("2.1x1.2", 8000)]).status).not.toBe("priced");
    expect(line(door("2.1x1.2"), [entry("2.1x1.0", 7500)]).status).not.toBe("priced");
  });
  it("an entry with a missing approval is refused, so an unapproved cost cannot price a door", () => {
    const bad = { ...entry("2.1x1.2", 8000), approval: { ...entry("2.1x1.2", 1).approval, reference: "" } } as BudgetBasisEntry;
    expect(line(door("2.1x1.2"), [bad]).status).not.toBe("priced");
  });
  it("an Estimator's own confirmed product still wins over the register", () => {
    const d = door("2.1x1.2") as QuoteDraft; d.estimator.confirmedMappings = { pvc_door: "NQ2161" } as never;
    expect(line(d).sku).toBe("NQ2161");
  });
  it("validation accepts only the two sizes; the lookup helpers agree", () => {
    expect(calculateGrowerHouse({ ...door("2.1x1.2").config, doorSize: "3x3" as never }).valid).toBe(false);
    expect(isDoorSize("2.1x1.0")).toBe(true); expect(isDoorSize("x")).toBe(false);
    expect(doorSpecificationFor(null)).toBeNull();
  });
  it("the original template ignores the size and keeps its previous behaviour (any approved door entry, size not consulted)", () => {
    const d = door(null); delete (d.estimator as { templateRevision?: string }).templateRevision;
    expect(line(d, [entry("2.1x1.2", 8000)]).status).toBe("priced");
  });
});

describe("price-source-level freight: a landed ZAR reference takes NO further freight; supplier-native costs are unchanged", () => {
  const NOW = "2026-11-25T09:00:00Z";
  const master = new Map<string, MasterSupplier>([["Z1", { id: "Z1", name: "Local ZAR supplier", currency: "ZAR", active: true }], ["U1", { id: "U1", name: "USD supplier", currency: "USD", active: true }]]);
  const raw = (sku: string, sup: string, cost: number): SurveyInput => ({ sku, found: true, productStatus: "Active", productName: sku, uom: "Item", averageCost: null, unitFields: {}, suppliers: [{ supplierId: sup, supplierName: sup, currency: sup === "U1" ? "USD" : "ZAR", cost, fixedCost: cost, lastSupplied: "2026-11-25", supplierInventoryCode: null, dropShip: false } as never] } as never);
  const SETTINGS: CommercialSettings = { ...emptyCommercialSettings(), markupBps: 2000, freight: { factorMicro: 1_150_000, addOnCents: 0, source: "fixture" }, fx: { USD: { rateMicro: 17_624_370, source: "fixture", asOf: "2026-11-25T07:00:00Z" } } };
  const REF = { version: 7, enteredBy: "fixture" };
  const f = (r: ReturnType<typeof autoCostFor>) => { if (isFlag(r)) throw new Error(r.code); return r.input.freight!.factorMicro; };
  it("by default every SKU takes its category freight exactly as before (the exempt list is empty)", () => {
    expect(NO_LANDED_SKUS.size).toBe(0);
    expect(f(autoCostFor(raw("A", "Z1", 100), master, SETTINGS, REF, NOW))).toBe(1_150_000);
  });
  it("a listed ZAR SKU gets factor 1.000000 and says why; an unlisted SKU in the same call keeps 1.15", () => {
    const landed = new Set(["A"]);
    expect(f(autoCostFor(raw("A", "Z1", 100), master, SETTINGS, REF, NOW, [], landed))).toBe(1_000_000);
    expect(f(autoCostFor(raw("B", "Z1", 100), master, SETTINGS, REF, NOW, [], landed))).toBe(1_150_000);
  });
  it("a foreign-currency cost can never be treated as landed ZAR", () => {
    const r = autoCostFor(raw("U", "U1", 10), master, SETTINGS, REF, NOW, [], new Set(["U"]));
    expect(isFlag(r)).toBe(true);
  });
});
