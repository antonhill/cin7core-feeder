// BUDGET BASIS + COVERAGE (fixtures only: nothing here is an approved NewQuip product or rate). Proves: an approved default product / dated rate prices the door and optional equipment in a BUDGET evaluation only,
// through the existing engine (a cost-basis rate gets the existing markup once; a selling-price rate is never marked up); unapproved / expired / incomplete entries do nothing; the shipped register is empty;
// the coverage view reports the exact blocker for every category and its Rep-safe part carries no cost.
import { describe, expect, it } from "vitest";
import type { QuoteDraft } from "../draft";
import { evaluateDraft } from "../evaluate";
import { createWorkbookPriceSource } from "../workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "../snapshot";
import { budgetBasisProblems, budgetRateSellingPrice, usableBudgetBasis, type BudgetApproval, type BudgetBasisEntry, type BudgetEvidence, type BudgetRate } from "../budget-basis";
import { readFileSync } from "node:fs";
import { sameApprover } from "../budget-basis";
import { ACTIVE_BUDGET_BASIS } from "../budget-basis-register";
import { buildBudgetCoverage, coverageCounts } from "../budget-coverage";
import { GROWER_ITEM_KEYS } from "../types";
import { nqQ0002, S } from "./nq-q-0002-fixture";

const TODAY = "2026-11-18";
const evidence = (o: Partial<BudgetEvidence> = {}): BudgetEvidence => ({ kind: "supplier_quote", reference: "FIXTURE quote ref", asOf: "2026-11-10", verified: true, uncertainty: null, ...o });
const approval = (o: Partial<BudgetApproval> = {}): BudgetApproval => ({ approvedBy: "FIXTURE Manager", role: "NewQuip Manager", approvedAt: "2026-11-18T08:00:00Z", reference: "FIXTURE approval ref (outside the code)", enteredBy: "FIXTURE Developer", ...o });
const common = { specification: "FIXTURE spec", unit: "each", effectiveFrom: "2026-11-01", expiresOn: "2027-02-28" } as const;
const rate = (o: Partial<BudgetRate> & { itemKey: BudgetRate["itemKey"] }): BudgetRate => ({ kind: "rate", amount: 10000, currency: "ZAR", basis: "selling_price", evidence: evidence(), approval: approval(), ...common, ...o });
const sku = (itemKey: BudgetBasisEntry["itemKey"], s: string, o: Partial<BudgetBasisEntry> = {}): BudgetBasisEntry => ({ kind: "default_sku", itemKey, sku: s, evidence: evidence({ kind: "product_owner_confirmation" }), approval: approval(), ...common, ...o } as BudgetBasisEntry);

// NQ-Q-0002's saved configuration (read-only, in memory) + the door and the controller selected, with a Cin7 cost for the FIXTURE door product in the draft's own pricing.
const draft = (): QuoteDraft => {
  const d = nqQ0002();
  (d.config as unknown as { optionalEquipment: Record<string, boolean> }).optionalEquipment = { ...d.config.optionalEquipment, controller: true };
  d.config.estimatorQuantities = { ...d.config.estimatorQuantities, pvc_door: 2, controller: 2 };
  (d.estimator.pricing!.skus as Record<string, unknown>)["NQ2161"] = S("ZAR", 58_000_000_000); // R5,800 supplier cost (fixture)
  return d;
};
const ctx = (over: Record<string, unknown> = {}) => ({ priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: true, ...over });
const line = (d: QuoteDraft, k: string, over: Record<string, unknown> = {}) => evaluateDraft(d, ctx(over)).budget!.lines.find((l) => l.itemKey === k)!;

describe("the register", () => {
  it("ships EMPTY: no product or rate is activated without approval", () => { expect(ACTIVE_BUDGET_BASIS).toHaveLength(0); });
  it("every ACTIVE entry (none today) must pass the approval safeguards", () => { for (const e of ACTIVE_BUDGET_BASIS) expect(budgetBasisProblems(e, TODAY), `${e.itemKey}`).toEqual([]); });
  it("an entry needs every field; expired / future / non-ZAR / zero amounts are refused with a reason", () => {
    expect(budgetBasisProblems(rate({ itemKey: "controller" }), TODAY)).toEqual([]);
    expect(budgetBasisProblems(rate({ itemKey: "controller", specification: " " }), TODAY)).toContain("specification missing");
    expect(budgetBasisProblems(rate({ itemKey: "controller", expiresOn: "2026-11-01" }), TODAY).join()).toMatch(/expired/);
    expect(budgetBasisProblems(rate({ itemKey: "controller", effectiveFrom: "2026-12-01" }), TODAY).join()).toMatch(/not effective until/);
    expect(budgetBasisProblems(rate({ itemKey: "controller", amount: 0 }), TODAY)).toContain("amount must be a positive number");
    expect(budgetBasisProblems({ ...rate({ itemKey: "controller" }), currency: "EUR" } as never, TODAY)).toContain("only ZAR rates are supported");
  });
  it("APPROVAL SAFEGUARDS: the approver may not be the person who entered the record; the approval must be recorded outside the code, by an authorised role, with a time", () => {
    const p = (o: Partial<BudgetApproval>) => budgetBasisProblems(rate({ itemKey: "controller", approval: approval(o) }), TODAY);
    expect(p({ enteredBy: "fixture manager" })).toContain("the approver cannot be the person who entered the record"); // case-insensitive
    expect(p({ reference: "" }).join()).toMatch(/approval reference missing/);
    expect(p({ role: "Developer" as never }).join()).toMatch(/NewQuip Manager or a designated commercial approver/);
    expect(p({ approvedBy: "" })).toContain("approver missing");
    expect(p({ approvedAt: "" })).toContain("approval time missing");
    expect(p({ enteredBy: "" })).toContain("the person who entered the record is missing");
    expect(budgetBasisProblems({ ...rate({ itemKey: "controller" }), approval: undefined } as never, TODAY)).toContain("approval missing");
    expect(p({ role: "Designated commercial approver" })).toEqual([]);
  });
  it("EVIDENCE SAFEGUARDS: historical ERP data keeps its date and uncertainty and can never be 'verified'; future-dated or undated evidence is refused", () => {
    const e = (o: Partial<BudgetEvidence>) => budgetBasisProblems(rate({ itemKey: "controller", basis: "cost", evidence: evidence(o) }), TODAY);
    expect(e({ kind: "erp_historical", verified: true, uncertainty: "dated" })).toContain("historical ERP evidence cannot be marked verified");
    expect(e({ kind: "erp_historical", verified: false, uncertainty: null })).toContain("the uncertainty of historical or unverified evidence must be stated");
    expect(e({ kind: "erp_historical", verified: false, uncertainty: "ERP report, origin unverified" })).toEqual([]);
    expect(e({ verified: false, uncertainty: null })).toContain("the uncertainty of historical or unverified evidence must be stated");
    expect(e({ asOf: "2026-12-01" })).toContain("evidence is dated in the future");
    expect(e({ asOf: "" })).toContain("evidence date missing");
    expect(e({ reference: "" })).toContain("evidence reference missing");
    expect(e({ asOf: "2019-01-01" }).join()).toMatch(/older than the 5-year maximum age/);
  });
  it("approval time cannot be in the future; self-approval is caught despite initials, punctuation, spacing or an email form", () => {
    expect(budgetBasisProblems(rate({ itemKey: "controller", approval: approval({ approvedAt: "2026-11-25T08:00:00Z" }) }), TODAY)).toContain("approval time is in the future");
    for (const [by, entered] of [["Anton  Hill", "anton hill"], ["anton.hill@newquip.co.za", "Anton Hill"], ["Anton Hill", "anton-hill"], ["ANTON HILL ", "anton hill"]] as const) {
      expect(budgetBasisProblems(rate({ itemKey: "controller", approval: approval({ approvedBy: by, enteredBy: entered }) }), TODAY), `${by} / ${entered}`).toContain("the approver cannot be the person who entered the record");
    }
  });
  it("separation of duties survives name variants (word order, initials, accents, an email form) and refuses look-alike characters; different people are not flagged", () => {
    for (const [a, b] of [["Smith, Sean", "Sean Smith"], ["A. Hill", "Anton Hill"], ["Antón Hill", "anton hill"], ["anton.hill@x.co.za", "Hill Anton"], ["S Smith", "Sean Smith"], ["ahill@x.co.za", "Anton Hill"], ["hilla@x.co.za", "Anton Hill"], ["A. Adams", "Adams Anton"], ["Hill, A.", "Anton Hill"]] as const) expect(sameApprover(a, b), `${a} / ${b}`).toBe(true);
    for (const [a, b] of [["Sean Smith", "Anton Hill"], ["Sean Hill", "Anton Hill"], ["Thandi Mbulo", "Anton Hill"]] as const) expect(sameApprover(a, b), `${a} / ${b}`).toBe(false);
    for (const bad of ["\u0405ean Smith", "Sean Sm1th", "Sean Smith 2"]) expect(budgetBasisProblems(rate({ itemKey: "controller", approval: approval({ approvedBy: bad }) }), TODAY), bad).toContain("names must use plain Latin letters (no look-alike characters)");
    for (const good of ["Sean O'Brien", "Thandi Mbulo-Nkosi", "Sean Smith", "sean.smith@newquip.co.za", "Fran\u00e7ois Du Plessis"]) expect(budgetBasisProblems(rate({ itemKey: "controller", approval: approval({ approvedBy: good }) }), TODAY), good).not.toContain("names must use plain Latin letters (no look-alike characters)");
    expect(budgetBasisProblems(rate({ itemKey: "controller", approval: approval({ approvedBy: "Smith, Sean", enteredBy: "Sean Smith" }) }), TODAY)).toContain("the approver cannot be the person who entered the record");
  });
  it("the register file and its approval rules are protected by CODEOWNERS (a code-owner review is required to change them)", () => {
    const co = readFileSync(new URL("../../../../.github/CODEOWNERS", import.meta.url), "utf8");
    for (const f of ["src/newquip/grower/budget-basis-register.ts", "src/newquip/grower/budget-basis.ts", "docs/newquip-budget-pricing-coverage.md"]) expect(co).toMatch(new RegExp(`^/${f.replace(/[.]/g, "\\.")}\\s+@\\S+`, "m"));
  });
  it("an entry for an item that is not eligible (a core item, the M75, a package) is refused", () => {
    for (const k of ["feeder", "flex_auger", "cup_drinker", "bulk_tank"] as const) expect(budgetBasisProblems(rate({ itemKey: k }), TODAY).join(), k).toMatch(/cannot be priced from the Budget register/);
    expect(usableBudgetBasis([rate({ itemKey: "feeder" })], "feeder", TODAY)).toBeNull();
  });
  it("a default product wins over a rate; the latest approval wins within a kind", () => {
    const reg = [rate({ itemKey: "pvc_door" }), sku("pvc_door", "A"), { ...sku("pvc_door", "B"), approval: approval({ approvedAt: "2026-11-19T08:00:00Z" }) }];
    expect((usableBudgetBasis(reg, "pvc_door", "2026-11-19") as { sku: string }).sku).toBe("B");
  });
  it("a cost-basis rate is AGED by the existing cost-age policy from its evidence date, then marked up ONCE; a selling-price rate is never aged or marked up; no markup = cannot be priced", () => {
    expect(budgetRateSellingPrice(rate({ itemKey: "controller", basis: "cost" }), 2000, TODAY)).toMatchObject({ unitPriceExVat: 12000, markedUp: true, escalationBps: 0 }); // evidence under a year old: no escalation
    expect(budgetRateSellingPrice(rate({ itemKey: "controller", basis: "cost", evidence: evidence({ asOf: "2024-11-18" }) }), 2000, TODAY)).toMatchObject({ unitPriceExVat: 13198.8, escalationBps: 999 }); // two years old: the 1-2 year band
    expect(budgetRateSellingPrice(rate({ itemKey: "controller", basis: "selling_price", evidence: evidence({ asOf: "2024-11-18" }) }), 2000, TODAY)).toEqual({ unitPriceExVat: 10000, markedUp: false, escalationBps: 0 });
    expect(budgetRateSellingPrice(rate({ itemKey: "controller", basis: "cost" }), null, TODAY)).toBeNull();
    expect(budgetRateSellingPrice(rate({ itemKey: "controller", basis: "cost", evidence: evidence({ asOf: "2019-01-01" }) }), 2000, TODAY)).toBeNull();
  });
});

describe("the existing engine, Budget evaluation only", () => {
  it("default behaviour is unchanged: with no register entry the door and the controller are unmapped and unpriced", () => {
    for (const k of ["pvc_door", "controller"]) { const l = line(draft(), k, { provisionalPackages: true }); expect(l.status, k).toBe("unmapped"); expect(l.revenueExTax).toBeNull(); }
  });
  it("an approved default door product is priced through the normal cost + freight + markup path (R5,800 x 1.15 x 1.2 = R8,004 each) and is PROVISIONAL, with Rep-safe wording", () => {
    const l = line(draft(), "pvc_door", { provisionalPackages: true, budgetBasis: [sku("pvc_door", "NQ2161")], budgetAsOf: TODAY });
    expect(l).toMatchObject({ status: "priced", sku: "NQ2161", pricedBy: "price_source", mappingSource: "budget_default" });
    expect(l.unitPrice).toBe(8004); expect(l.revenueExTax).toBe(8004 * 24);
    expect(l.provisional?.plain).toMatch(/^Provisional:/); expect(l.provisional?.plain).not.toMatch(/R\d|cost|markup|margin|NQ2161/i);
  });
  it("an approved SELLING-price rate prices the controller exactly (no second markup); a COST-basis rate is marked up once (the project markup, 20%)", () => {
    const s = line(draft(), "controller", { provisionalPackages: true, budgetBasis: [rate({ itemKey: "controller", amount: 10000, basis: "selling_price" })], budgetAsOf: TODAY });
    expect(s).toMatchObject({ status: "priced", pricedBy: "budget_rate", unitPrice: 10000, revenueExTax: 240000 }); expect(s.provisional).toBeTruthy();
    const c = line(draft(), "controller", { provisionalPackages: true, budgetBasis: [rate({ itemKey: "controller", amount: 10000, basis: "cost" })], budgetAsOf: TODAY });
    expect(c).toMatchObject({ pricedBy: "budget_rate", unitPrice: 12000 });
  });
  it("an approved default product with NO cost stays unpriced (a plausible SKU is never priced from nothing)", () => {
    expect(line(draft(), "controller", { provisionalPackages: true, budgetBasis: [sku("controller", "HO05084000")], budgetAsOf: TODAY }).status).not.toBe("priced");
  });
  it("expired or incomplete entries do nothing; the formal (non-Budget) evaluation ignores the register entirely; an Estimator-confirmed product wins", () => {
    expect(line(draft(), "controller", { provisionalPackages: true, budgetBasis: [rate({ itemKey: "controller", expiresOn: "2026-11-01" })], budgetAsOf: TODAY }).status).toBe("unmapped");
    expect(line(draft(), "controller", { budgetBasis: [rate({ itemKey: "controller" })], budgetAsOf: TODAY }).status).toBe("unmapped"); // no provisionalPackages: not a Budget evaluation
    const d = draft(); d.estimator.confirmedMappings = { ...d.estimator.confirmedMappings, pvc_door: "NQ2161" };
    expect(line(d, "pvc_door", { provisionalPackages: true, budgetBasis: [sku("pvc_door", "OTHER")], budgetAsOf: TODAY })).toMatchObject({ sku: "NQ2161", mappingSource: "estimator" });
  });
  it("an Estimator's valid manual price resolution beats the register (and no false 'not needed' warning appears for a budget-rate line)", () => {
    const d = draft(); d.estimator.priceResolutions = { ...d.estimator.priceResolutions, pvc_door: { at: "t", by: "x", reason: "Estimator price", unitPriceExVat: 3000 } as never };
    const l = line(d, "pvc_door", { provisionalPackages: true, budgetBasis: [rate({ itemKey: "pvc_door", amount: 7000 })], budgetAsOf: TODAY });
    expect(l).toMatchObject({ pricedBy: "estimator_resolution", unitPrice: 3000 });
    const w = evaluateDraft(draft(), ctx({ provisionalPackages: true, budgetBasis: [rate({ itemKey: "controller" })], budgetAsOf: TODAY })).budget!.warnings.join(" ");
    expect(w).not.toMatch(/resolution was entered/);
  });
  it("a default product that cannot be priced is labelled as coming from the register, never as an Estimator confirmation", () => {
    const l = line(draft(), "controller", { provisionalPackages: true, budgetBasis: [sku("controller", "HO05084000")], budgetAsOf: TODAY });
    expect(l.status).not.toBe("priced"); expect(l.mappingSource).toBe("budget_default");
  });
  it("the cost-rate age follows the supplied date, not the server clock", () => {
    const entry = rate({ itemKey: "controller", basis: "cost", evidence: evidence({ asOf: "2024-11-18" }), effectiveFrom: "2024-11-20", expiresOn: "2030-12-31", approval: approval({ approvedAt: "2024-11-20T08:00:00Z" }) });
    expect(line(draft(), "controller", { provisionalPackages: true, budgetBasis: [entry], budgetAsOf: "2026-11-18" }).unitPrice).toBe(13198.8);
    expect(line(draft(), "controller", { provisionalPackages: true, budgetBasis: [entry], budgetAsOf: "2025-11-18" }).unitPrice).toBe(12000); // a year old: still the 0% band
  });
  it("a register entry cannot price a core item or any item key it was not approved for", () => {
    const core = line(draft(), "feeder", { provisionalPackages: true, budgetBasis: [rate({ itemKey: "feeder", amount: 1 })], budgetAsOf: TODAY });
    expect(core.pricedBy).not.toBe("budget_rate");
    expect(line(draft(), "flex_auger", { provisionalPackages: true, budgetBasis: [rate({ itemKey: "flex_auger", amount: 1 })], budgetAsOf: TODAY }).pricedBy).not.toBe("budget_rate");
    expect(line(draft(), "pvc_door", { provisionalPackages: true, budgetBasis: [rate({ itemKey: "controller" })], budgetAsOf: TODAY }).status).toBe("unmapped");
  });
});

describe("the coverage view: every selectable category, exact blocker, owner and next action", () => {
  const rows = buildBudgetCoverage([], TODAY);
  const EIGHT = ["pvc_door", "controller", "silo_weighing", "control_panel", "emergency_windows", "pad_cooling", "cone_fans", "manure_plug"];
  it("covers all 16 categories; with the empty register 8 have no defensible price (the NQ-Q-0005 set)", () => {
    expect(rows.map((r) => r.itemKey)).toEqual([...GROWER_ITEM_KEYS]);
    expect(coverageCounts(rows)).toEqual({ READY: 5, PROVISIONAL: 2, RATE_APPROVAL_REQUIRED: 3, SPECIFICATION_REQUIRED: 5, NO_PRICE_SOURCE: 1 });
    const missing = rows.filter((r) => r.repSafe.status === "missing").map((r) => r.itemKey);
    for (const k of EIGHT) expect(missing).toContain(k);
  });
  it("THREE separate questions: an empty register never makes an unpriced category look ready, even when price evidence and a mechanism exist", () => {
    for (const k of EIGHT) { const r = rows.find((x) => x.itemKey === k)!; expect(r.approvedPriceReady, k).toBe(false); }
    expect(rows.filter((r) => r.approvedPriceReady).map((r) => r.itemKey).sort()).toEqual(["bulk_tank", "concrete_slat", "feed_saver_mat", "feeder", "penning_package"]);
    const door = rows.find((r) => r.itemKey === "pvc_door")!;
    expect(door).toMatchObject({ priceEvidence: "current_cin7", mechanismSupported: true, approvedPriceReady: false });
    expect(door.evidenceNote).toMatch(/cannot be told apart from a data-load date/);
    for (const k of ["controller", "silo_weighing", "emergency_windows", "pad_cooling", "cone_fans"]) expect(rows.find((r) => r.itemKey === k)).toMatchObject({ priceEvidence: "historical_only", approvedPriceReady: false });
    expect(rows.find((r) => r.itemKey === "controller")!.evidenceNote).toMatch(/historical, unverified\); not a current Cin7 supplier cost/);
    for (const k of ["control_panel", "manure_plug"]) expect(rows.find((r) => r.itemKey === k)).toMatchObject({ priceEvidence: "none", approvedPriceReady: false });
    expect(rows.find((r) => r.itemKey === "manure_plug")!.mechanismSupported).toBe(false);
    // a provisional package is price-ready provisionally but is NOT an approved price
    for (const k of ["cup_drinker", "led_light"]) expect(rows.find((r) => r.itemKey === k)).toMatchObject({ state: "PROVISIONAL", approvedPriceReady: false });
  });
  it("every non-READY row names the blocker, an owner and the next action; READY rows need none", () => {
    for (const r of rows) { if (r.state === "READY") { expect(r.blocker).toBeNull(); } else { expect(r.blocker, r.itemKey).toBeTruthy(); expect(r.owner, r.itemKey).toBeTruthy(); expect(r.nextAction, r.itemKey).toBeTruthy(); } }
  });
  it("the Rep-safe part carries only a status and a customer-appropriate sentence: no cost, rate, product code or margin", () => {
    for (const r of rows) expect(JSON.stringify(r.repSafe), r.itemKey).not.toMatch(/R\s?\d|cost|rate\b|markup|margin|freight|\b[A-Z]{2,}\d{3,}\b/i);
  });
  it("coverage agrees with the engine: an entry for an item the engine will not price (M75, a package, a core item) never makes it approved-ready", () => {
    for (const k of ["flex_auger", "cup_drinker", "led_light", "feeder"] as const) {
      const r = buildBudgetCoverage([rate({ itemKey: k })], TODAY).find((x) => x.itemKey === k)!;
      expect(r.approvedPriceReady, k).toBe(k === "feeder"); // the core item was already READY; the others stay as they were
      expect(r.priceSource, k).not.toBe("approved_budget_basis");
    }
  });
  it("an UNVERIFIED Cin7 supplier cost is never labelled a current Cin7 cost; a verified one is", () => {
    const e = (verified: boolean) => buildBudgetCoverage([rate({ itemKey: "controller", evidence: evidence({ kind: "cin7_supplier_cost", verified, uncertainty: verified ? null : "last-supplied date unconfirmed" }) })], TODAY).find((r) => r.itemKey === "controller")!;
    expect(e(false).priceEvidence).toBe("approved_record"); expect(e(true).priceEvidence).toBe("current_cin7");
  });
  it("the M75 next action no longer points at a register rate that the engine would refuse", () => {
    expect(buildBudgetCoverage([], TODAY).find((r) => r.itemKey === "flex_auger")!.nextAction).toMatch(/cannot price the M75/);
  });
  it("unverified or non-Cin7 evidence is never labelled a current Cin7 cost", () => {
    const q = buildBudgetCoverage([rate({ itemKey: "controller", evidence: evidence({ kind: "supplier_quote", verified: false, uncertainty: "verbal quote" }) })], TODAY).find((r) => r.itemKey === "controller")!;
    expect(q.priceEvidence).toBe("approved_record"); expect(q.evidenceNote).toMatch(/NOT verified/);
  });
  it("an approved usable entry moves the category to PROVISIONAL and approved-ready, keeping its evidence date and uncertainty visible INTERNALLY; an expired or self-approved one leaves it blocked and says why", () => {
    const ok = buildBudgetCoverage([rate({ itemKey: "controller", basis: "cost", evidence: evidence({ kind: "erp_historical", verified: false, uncertainty: "ERP report of unknown origin", asOf: "2025-11-20" }) })], TODAY).find((r) => r.itemKey === "controller")!;
    expect(ok).toMatchObject({ state: "PROVISIONAL", priceSource: "approved_budget_basis", approvedPriceReady: true, priceEvidence: "historical_only" });
    expect(ok.evidenceNote).toMatch(/erp historical dated 2025-11-20, NOT verified\. Uncertainty: ERP report of unknown origin/);
    expect(JSON.stringify(ok.repSafe)).not.toMatch(/erp|historical|2025/i);
    const lapsed = buildBudgetCoverage([rate({ itemKey: "controller", expiresOn: "2026-11-01" })], TODAY).find((r) => r.itemKey === "controller")!;
    expect(lapsed).toMatchObject({ state: "RATE_APPROVAL_REQUIRED", approvedPriceReady: false }); expect(lapsed.blocker).toMatch(/cannot be used: expired/);
    const selfApproved = buildBudgetCoverage([rate({ itemKey: "controller", approval: approval({ enteredBy: "FIXTURE Manager" }) })], TODAY).find((r) => r.itemKey === "controller")!;
    expect(selfApproved.approvedPriceReady).toBe(false); expect(selfApproved.blocker).toMatch(/approver cannot be the person who entered/);
  });
});
