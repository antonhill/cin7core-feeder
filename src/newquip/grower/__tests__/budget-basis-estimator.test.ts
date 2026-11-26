// THE THREE PRICING SOURCES AT THE ESTIMATOR (NewQuip decision, 26 Nov 2026). NEUTRAL FIXTURE amounts only: no NewQuip cost is in the repository.
//   A supplier-costed (needs a Cin7 supplier)  ·  B Budget BOM cost + markup once, no freight (door, both sizes)  ·  C fixed Budget selling price (control panel R65,000 one controller/BF, R85,000 both).
// B and C must be confirmable by the Estimator WITHOUT a supplier, stay provisional, need recorded evidence before they can be final, and be Estimator-priced "by design" for the Manager.
import { describe, expect, it } from "vitest";
import type { QuoteDraft } from "../draft";
import { evaluateDraft } from "../evaluate";
import { createWorkbookPriceSource } from "../workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "../snapshot";
import { DOOR_SIZES } from "../door-sizes";
import { UAT_PROVISIONAL_ENV, uatProvisionalRatesFromEnv } from "../uat-provisional-basis";
import { INTERIM_PANEL_BOTH_EX_VAT, INTERIM_PANEL_ONE_EX_VAT } from "../control-panel-interim";
import { skuLessManualItems, evidenceStateOf } from "@/newquip/pricing/estimator/manual-evidence";
import { skuNeedsOf } from "@/newquip/pricing/estimator/workspace-view";
import { BY_DESIGN_PRICED_BY } from "@/newquip/quote/baseline-exception";
import { buildWorkspace, taskStatusWord, type WorkspaceFacts } from "@/newquip/quote/estimator-workspace";
import type { BudgetQuote } from "../quote-bridge";
import type { PricingWorkspaceView } from "@/newquip/pricing/estimator";
import { nqQ0002 } from "./nq-q-0002-fixture";

const ENV = JSON.stringify({
  [`pvc_door|${DOOR_SIZES["2.1x1.2"].specification}`]: { amount: 8000, asOf: "2026-11-24" },
  [`pvc_door|${DOOR_SIZES["2.1x1.0"].specification}`]: { amount: 7500, asOf: "2026-11-24" },
});
const rates = uatProvisionalRatesFromEnv({ [UAT_PROVISIONAL_ENV]: ENV });
type Cfg = { doorSize?: string | null; controller?: boolean; silo?: boolean };
const draftFor = (o: Cfg, confirmed: string[] = []): QuoteDraft => {
  const d = structuredClone(nqQ0002()) as QuoteDraft & { config: Record<string, unknown> };
  d.config.doorSize = (o.doorSize ?? null) as never;
  d.config.optionalEquipment = { ...(d.config.optionalEquipment as object), controller: Boolean(o.controller), silo_weighing: Boolean(o.silo), control_panel: Boolean(o.controller || o.silo) } as never;
  d.config.estimatorQuantities = { ...(d.config.estimatorQuantities as object), control_panel: 2, controller: 2, silo_weighing: 2 } as never;
  d.estimator.confirmedPackages = confirmed as never;
  return d;
};
// An ESTIMATOR evaluation: NOT a Budget evaluation (no provisionalPackages), with the documented bases available.
const estimator = (d: QuoteDraft, over: Record<string, unknown> = {}) => evaluateDraft(d, { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: false, budgetAsOf: "2026-11-26", uatProvisionalRates: rates, ...over }).budget!;
const lineOf = (b: BudgetQuote, k: string) => b.lines.find((l) => l.itemKey === k)!;

describe("B: the door's Budget BOM cost basis at the Estimator (both sizes)", () => {
  for (const [size, unit] of [["2.1x1.2", 9600], ["2.1x1.0", 9000]] as const) {
    it(`${size}: unconfirmed it is OFFERED (never priced, no supplier asked); once the Estimator confirms it, it is priced: its own cost + the markup ONCE, no freight, provisional`, () => {
      const before = lineOf(estimator(draftFor({ doorSize: size })), "pvc_door");
      expect(before.status).not.toBe("priced");
      expect(before.budgetBasis).toMatchObject({ kind: "bom_cost_markup" });
      expect(before.sku).toBeNull();
      const after = lineOf(estimator(draftFor({ doorSize: size }, ["pvc_door"])), "pvc_door");
      expect(after).toMatchObject({ status: "priced", pricedBy: "budget_rate", unitPrice: unit, sku: null });
      expect(after.provisional?.plain).toMatch(/UAT|internal/i);
    });
  }
  it("each size uses its OWN basis (no cross-use) and a door with no size is never priced", () => {
    const a = lineOf(estimator(draftFor({ doorSize: "2.1x1.2" }, ["pvc_door"])), "pvc_door").unitPrice;
    const b = lineOf(estimator(draftFor({ doorSize: "2.1x1.0" }, ["pvc_door"])), "pvc_door").unitPrice;
    expect(a).not.toBe(b);
    expect(lineOf(estimator(draftFor({ doorSize: null }, ["pvc_door"])), "pvc_door").status).not.toBe("priced");
  });
  it("an Estimator's own supplier-costed product still wins over the Budget basis (A is preserved)", () => {
    const d = draftFor({ doorSize: "2.1x1.2" }, ["pvc_door"]); d.estimator.confirmedMappings = { pvc_door: "NQ2161" } as never;
    expect(lineOf(estimator(d), "pvc_door").pricedBy).not.toBe("budget_rate");
  });
  it("the cost-bearing detail is withheld from a viewer who may not see cost", () => {
    const l = lineOf(estimator(draftFor({ doorSize: "2.1x1.2" }), { withholdCost: true }), "pvc_door");
    expect(l.budgetBasis?.detail).toBeUndefined();
    expect(JSON.stringify(l)).not.toMatch(/8000|8 000/);
  });
});

describe("C: the control panel's FIXED Budget selling price at the Estimator", () => {
  for (const [name, cfg, rate] of [["CL1 only", { controller: true }, INTERIM_PANEL_ONE_EX_VAT], ["BF only", { silo: true }, INTERIM_PANEL_ONE_EX_VAT], ["CL1 and BF", { controller: true, silo: true }, INTERIM_PANEL_BOTH_EX_VAT]] as const) {
    it(`${name}: R${rate.toLocaleString("en-ZA")} per panel, no freight, no markup, no supplier, no catalogue SKU; offered until confirmed`, () => {
      const before = lineOf(estimator(draftFor(cfg)), "control_panel");
      expect(before.status).not.toBe("priced");
      expect(before.budgetBasis?.kind).toBe("fixed_selling_price");
      const after = lineOf(estimator(draftFor(cfg, ["control_panel"])), "control_panel");
      expect(after).toMatchObject({ status: "priced", pricedBy: "budget_rate", unitPrice: rate, sku: null, });
      expect(after.quantity).toBeGreaterThan(0);
      expect(after.revenueExTax).toBe(rate * (after.quantity as number));
      expect(after.provisional).toBeTruthy();
    });
  }
  it("with neither CL1 nor BF there is no panel to price and nothing is invented", () => {
    expect(lineOf(estimator(draftFor({}, ["control_panel"])), "control_panel").status).not.toBe("priced");
  });
});

describe("classification: one consistent reading by evidence, cost verification and the Manager's by-design exception", () => {
  const b = estimator(draftFor({ doorSize: "2.1x1.2", controller: true, silo: true }, ["pvc_door", "control_panel"]));
  it("both lines are SKU-less pricing-evidence items (the Estimator's verification of the basis), bound to their price, and are not supplier-cost needs", () => {
    const items = skuLessManualItems(b).filter((i) => i.pricedBy === "budget_rate").map((i) => i.itemKey).sort();
    expect(items).toEqual(["control_panel", "pvc_door"]);
    expect(evidenceStateOf(skuLessManualItems(b).find((i) => i.itemKey === "pvc_door")!, undefined)).toBe("missing");
    expect(skuNeedsOf(b).some((n) => n.itemKeys.includes("pvc_door") || n.itemKeys.includes("control_panel"))).toBe(false);
  });
  it("the Manager's baseline exception treats them as Estimator-priced by design, like M75 and penning", () => {
    expect(BY_DESIGN_PRICED_BY).toContain("budget_rate");
  });
});

describe("the Estimator workspace", () => {
  const facts = (confirmed: string[]): WorkspaceFacts => ({ state: "ESTIMATOR_REVIEW", confirmedCents: null, signedOff: false, canEdit: true, canReview: false, confirmedPackages: confirmed, confirmedMappings: {} });
  const view = { rows: [], costs: { required: 0, verified: 0 }, totals: { margin: null }, manualEvidence: [], autoOwned: false } as unknown as PricingWorkspaceView;
  const ws = (confirmed: string[]) => buildWorkspace({ budget: estimator(draftFor({ doorSize: "2.1x1.0", controller: true }, confirmed)), view, facts: facts(confirmed) });
  it("unconfirmed: a 'Confirm Budget basis' task per line, with NO supplier cost asked for (skus empty)", () => {
    const w = ws([]);
    for (const id of ["pvc_door", "control_panel"]) {
      const t = w.tasks.find((x) => x.id === id)!;
      expect(t).toMatchObject({ kind: "budget_basis", action: "Confirm Budget basis", skus: [] });
      expect(taskStatusWord(t)).toBe("Confirmation needed");
      expect(t.indicators.cost).toBe("na");
    }
  });
  it("confirmed: the lines are complete as documented Budget bases (provisional, evidence still to record), never a missing supplier cost", () => {
    const w = ws(["pvc_door", "control_panel"]);
    expect(w.tasks.find((x) => x.id === "pvc_door" || x.id === "control_panel")).toBeUndefined();
    for (const id of ["pvc_door", "control_panel"]) {
      const c = w.complete.find((x) => x.id === id)!;
      expect(c).toMatchObject({ provisional: true, estimatorPriced: true, costState: "n/a" });
      expect(c.how).toMatch(/Documented Budget basis/);
      expect(c.how).not.toMatch(/supplier cost (needed|missing)/i);
    }
  });
});
