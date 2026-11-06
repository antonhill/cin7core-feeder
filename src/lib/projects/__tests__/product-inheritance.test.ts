// Product inheritance end to end: approved quotation -> project scope register -> Cin7 Advanced Sale -> invoice proposals -> posting.
// The functional input is the existing NewQuip demonstration quotation NQ-Q-0001 (test input only; it and the P0 records are never altered).
import { beforeEach, describe, expect, it } from "vitest";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { buildAcceptedBaseline, baselineMatchesHash, hashOf, type AcceptedBaseline } from "@/newquip/quote/baseline";
import { redactInternalFinancials } from "@/newquip/quote/margin";
import { POC_SIX_STAGE_SCHEDULE } from "@/newquip/quote/billing-schedule";
import { quoteToProjectBaseline } from "@/newquip/quote/to-project";
import { buildPhysicalScope } from "@/newquip/quote/physical-scope";
import { buildCustomerSummary } from "@/newquip/grower/customer-summary";
import { NQ_Q_0001_DRAFT } from "@/newquip/quote/__tests__/demo-quote-fixture";
import { FakeDb } from "./fake-db";
import { goldenFixtureBaseline } from "../baseline";
import { approveClaim, createClaimDraft, createProjectFromBaseline, loadProjectView, recordProgress, setOpeningCommitments, submitClaimForApproval } from "../project-store";
import { applyResolution, effectiveScope, scopeFromSnapshot, variationScope, type ScopeItem } from "../product-scope";
import { resolveScopeItem, loadProjectScope } from "../scope-store";
import { createSaleForProject, type SaleCreateOutcome, type SaleCreationPort } from "../cin7-sale-creation-store";
import { CREATE_CONFIRMATION_TEXT } from "../cin7-sale-creation";
import { buildAdvancedSaleOrderBody } from "@/cin7/sale-order-write";
import { proposeInvoice, stageKind, validateSelection } from "../invoice-proposal";
import { prepareInvoiceProposal } from "../invoice-proposal-store";
import { linkCin7Sale, postClaimToCin7, type Cin7Port, type Cin7SaleView, type InvoiceOutcome, type InvoiceRequest, type WriteGates } from "../cin7-posting-store";
import { POST_CONFIRMATION_TEXT } from "../cin7-posting";
import { approveVariation, raiseVariation } from "../variation-store";
import { createVariationBillingProject } from "../variation-billing-store";
import { buildPhysicalStatus } from "../physical-status";
import { loadPhysicalStatus } from "../physical-store";

const ORG = "org-a";
const ON: WriteGates = { writesEnabled: true, orgEnabled: true, isManager: true };
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as Error).message; } return undefined; };
const R = (n: number) => n * 100;
const APPROVALS = { customerConfirmedAt: "t", customerConfirmedCents: 1, customerConfirmedBy: "r", handoffBy: "r", estimatorSignoffBy: "e", estimatorSignoffAt: "t", managerApprovedBy: "m", managerApprovedAt: "t" };

function approvedDemo(): { baseline: AcceptedBaseline; hash: string } {
  const ctx = (withholdCost: boolean) => ({ priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost });
  return buildAcceptedBaseline({ quoteRef: "NQ-Q-0001", revision: 1, draft: NQ_Q_0001_DRAFT, evaluation: evaluateDraft(NQ_Q_0001_DRAFT, ctx(true)), marginEvaluation: evaluateDraft(NQ_Q_0001_DRAFT, ctx(false)), approvals: APPROVALS });
}

describe("1-3. the approved quotation's products carry into the project unchanged, packages expand once, BOM/reference components are not products", () => {
  const { baseline, hash } = approvedDemo();
  it("the sealed baseline carries the physical scope (sealed by the hash) and the project inherits it verbatim", async () => {
    expect(baseline.physicalScope!.length).toBeGreaterThan(10);
    expect(baselineMatchesHash(baseline, hash)).toBe(true);
    const generic = quoteToProjectBaseline(baseline, hash, "q1");
    expect(generic.physicalScope).toEqual(baseline.physicalScope);
    expect(generic.physicalScope).not.toBe(baseline.physicalScope); // a copy: the sealed baseline is never shared or mutated
    const db = new FakeDb();
    const id = await createProjectFromBaseline(db as never, ORG, "m@x", generic, { reference: "PRJ-NQ-Q-0001", name: "n" });
    expect(scopeFromSnapshot(db.rows("projects").find((p) => p.id === id)!.baseline_snapshot)).toEqual(baseline.physicalScope);
    expect(db.rows("project_stages")).toHaveLength(3); // the project itself is unchanged by inheriting the scope
  });
  it("preserves SKU, description, quantity, unit, product type, package/section origin, selling price and BASE scope", () => {
    const byId = new Map(baseline.physicalScope!.map((i) => [i.id, i]));
    expect(byId.get("feeder")).toMatchObject({ sku: "PNQ082", quantity: 216, unit: "each", productType: "FINISHED_GOOD", scope: "BASE", sellingUnitCents: expect.any(Number), origin: { lineRef: "feeder", section: "Feeding", packageKey: null, source: "QUOTE" }, mapping: { status: "MAPPED" } });
    expect(byId.get("cup_drinker:NQ2886")).toMatchObject({ sku: "NQ2886", quantity: 648, productType: "DIRECT_COMPONENT", origin: { packageKey: "cup_drinker", section: "Drinking" } });
    expect(byId.get("bulk_tank")).toMatchObject({ sku: "SYSH-2750-3", quantity: 12 });
  });
  it("a package expands into its component SKUs once: the package line itself is not also a product, and no SKU is listed twice", () => {
    const ids = baseline.physicalScope!.map((i) => i.id);
    expect(ids).not.toContain("cup_drinker");
    expect(ids.filter((i) => i.startsWith("cup_drinker:")).length).toBe(7);
    const skus = baseline.physicalScope!.filter((i) => i.sku).map((i) => i.sku);
    expect(new Set(skus).size).toBe(skus.length);
    expect(effectiveScope(baseline.physicalScope!.filter((i) => i.mapping.status === "MAPPED")).lines).toHaveLength(skus.length);
  });
  it("the same SKU arriving from two items is summed into ONE Sale line, never duplicated", () => {
    const mk = (id: string, q: number): ScopeItem => ({ id, sku: "NQ2886", description: "Bracket", quantity: q, unit: "each", productType: "DIRECT_COMPONENT", origin: { lineRef: id, label: id, packageKey: "p", section: null, source: "QUOTE" }, scope: "BASE", sellingUnitCents: null, mapping: { status: "MAPPED" } });
    const eff = effectiveScope([mk("a", 3), mk("b", 4)]);
    expect(eff.lines).toEqual([{ sku: "NQ2886", quantity: 7, description: "Bracket", sources: ["a", "b"] }]);
  });
  it("historic-reference components (the M75 system) and unresolved identities (FORTIS LED) are NEVER invented as products: each is one explicit UNMAPPED item", () => {
    const un = baseline.physicalScope!.filter((i) => i.mapping.status === "UNMAPPED");
    expect(un.map((i) => i.id).sort()).toEqual(["flex_auger:UNMAPPED", "led_light:UNMAPPED", "penning_package:UNMAPPED"]);
    expect(un.every((i) => i.sku === null && i.mapping.status === "UNMAPPED" && i.mapping.reason.length > 10)).toBe(true);
    const all = JSON.stringify(baseline.physicalScope);
    for (const histo of ["NQ1163", "NQ1223", "NQ1764", "NQ1942", "T3750001", "HNQ7046", "HNQ7088", "HNQ7093"]) expect(all).not.toContain(histo);
  });
  it("a Cin7 BOM sub-component is not scope: only what the quotation sells appears (an assembled finished good is one SKU line)", () => {
    const items = buildPhysicalScope([{ itemKey: "bulk_tank", label: "Silo", sku: "ASM-1", quantity: 2, unitPriceExVat: 100, revenueCents: 20000, pricedBy: "price_source", note: "" }]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sku: "ASM-1", productType: "FINISHED_GOOD" });
  });
  it("14. an already-sealed baseline without a scope still verifies and yields the identical scope when rebuilt; nothing is mutated", () => {
    const old = structuredClone(baseline) as unknown as Record<string, unknown>;
    delete old.physicalScope;
    const oldHash = hashOf(old);
    expect(baselineMatchesHash(old, oldHash)).toBe(true);
    const rebuilt = quoteToProjectBaseline(old as unknown as AcceptedBaseline, oldHash, "q1").physicalScope;
    expect(rebuilt).toEqual(baseline.physicalScope);
    expect(baselineMatchesHash(old, oldHash)).toBe(true);
    expect(Object.isFrozen(baseline)).toBe(true);
  });
  it("13. no cost or margin reaches the inherited scope, the project baseline or the customer summary; internal figures are redacted for non-managers", () => {
    const generic = quoteToProjectBaseline(baseline, hash, "q1");
    expect(JSON.stringify(generic)).not.toMatch(/internalMargin|marginPct|markupPct|gpCents|landed/i);
    expect(generic.lines.every((l) => l.estimatedCostCents === null)).toBe(true); // the project baseline never carries a cost
    expect(JSON.stringify(baseline.physicalScope)).not.toMatch(/cost|margin|markup/i);
    expect(JSON.stringify(redactInternalFinancials({ draft: NQ_Q_0001_DRAFT, accepted_baseline: baseline }, false))).not.toMatch(/internalMargin/);
    const ev = evaluateDraft(NQ_Q_0001_DRAFT, { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: false });
    expect(JSON.stringify(buildCustomerSummary(ev.budget!))).not.toMatch(/margin|markup|costCents|estimatedCost|landed/i);
    // the internal sheet ties each margin line to its SKU/quantity (the cost lives only here)
    expect(baseline.internalMargin!.lines.find((l) => l.itemKey === "feeder")).toMatchObject({ sku: "PNQ082", quantity: 216 });
  });
});

// ── Cin7 Advanced Sale from the inherited scope ────────────────────────────────
class SalePort implements SaleCreationPort {
  skus = new Set<string>(); sales = new Map<string, import("../cin7-sale-creation").SaleReadBack>(); creates: Array<Parameters<SaleCreationPort["createSale"]>[0]> = [];
  async customerExists() { return true; }
  async customerDefaults() { return { taxRule: "Standard Rate Sales", revenueAccount: "200", location: "MSTR" }; }
  async resolveProducts(s: string[]) { const ids = new Map<string, string>(); const missing: string[] = []; for (const k of s) { if (this.skus.has(k)) ids.set(k, `id-${k}`); else missing.push(k); } return { ids, missing }; }
  async assemblySkus() { return []; }
  async stockAt() { return []; }
  async createSale(req: Parameters<SaleCreationPort["createSale"]>[0]): Promise<SaleCreateOutcome> {
    this.creates.push(req);
    const id = `sale-${this.creates.length}`;
    this.sales.set(id, { id, type: "Advanced Sale", orderStatus: "AUTHORISED", customer: req.header.customer, externalId: req.header.externalId, taxRule: req.header.taxRule,
      lines: req.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, priceCents: 0 })), charges: req.charges.map((c) => ({ description: c.description, priceCents: Math.round(c.priceExVat * 100), taxCents: Math.round(c.taxAmount * 100) })), invoiceCount: 0, fulfilmentCount: 0 });
    return { kind: "created", saleId: id, saleNumber: "SO-1" };
  }
  async readSale(id: string) { return structuredClone(this.sales.get(id)!); }
  async findByExternalId() { return []; }
}
const saleInput = (projectId: string, over: Record<string, unknown> = {}) => ({ orgId: ORG, projectId, instanceId: "i", confirmation: CREATE_CONFIRMATION_TEXT, customerName: "Test Customer", location: "MSTR", revenueAccount: "200", cin7TaxRule: "Standard Rate Sales", now: new Date("2026-10-28T10:00:00Z"), ...over });

describe("4, 12. the Cin7 Advanced Sale is populated from the inherited scope, fails closed on anything unmapped, and never invents SKUs", () => {
  let db: FakeDb; let port: SalePort; let projectId: string;
  beforeEach(async () => {
    db = new FakeDb(); port = new SalePort();
    const { baseline, hash } = approvedDemo();
    projectId = await createProjectFromBaseline(db as never, ORG, "m@x", quoteToProjectBaseline(baseline, hash, "q1", POC_SIX_STAGE_SCHEDULE), { reference: "PRJ-NQ-Q-0001", name: "n" });
    for (const i of baseline.physicalScope!) if (i.sku) port.skus.add(i.sku);
  });
  it("refuses while any scope item is unmapped, names every one, stores no intent and sends nothing", async () => {
    const m = await err(createSaleForProject(db as never, port, ON, "mgr@x", saleInput(projectId)));
    expect(m).toMatch(/product scope is not ready/);
    for (const frag of ["M75", "penning", "LED"]) expect(m!.toLowerCase()).toContain(frag.toLowerCase());
    expect(port.creates).toHaveLength(0);
    expect(db.rows("project_cin7_sale_creations")).toHaveLength(0);
  });
  it("once a manager resolves each unmapped item (with a reason), the Sale carries exactly the approved SKUs and quantities, at R0", async () => {
    for (const id of ["flex_auger:UNMAPPED", "penning_package:UNMAPPED"]) await resolveScopeItem(db as never, port, { isManager: true }, "mgr@x", { orgId: ORG, projectId, itemId: id, kind: "EXCLUDE", reason: "Estimator-priced system supplied outside Cin7 stock" });
    await resolveScopeItem(db as never, port, { isManager: true }, "mgr@x", { orgId: ORG, projectId, itemId: "led_light:UNMAPPED", kind: "MAP", sku: "NQ2784", quantity: 456, reason: "FORTIS not stocked; mapped by the manager" });
    const r = await createSaleForProject(db as never, port, ON, "mgr@x", saleInput(projectId));
    expect(r.state).toBe("RECONCILED");
    const lines = Object.fromEntries(port.creates[0].lines.map((l) => [l.sku, l.quantity]));
    expect(lines).toMatchObject({ PNQ082: 216, ERT053: 216, NQ1161: 15840, NQ2114: 24, "SYSH-2750-3": 12, QCA00003: 648, NQ1386: 3240, NQ2784: 648 + 456 }); // NQ2784 = package component + the mapped LED, summed once
    expect(Object.keys(lines).length).toBe(port.creates[0].lines.length); // one line per SKU
    const body = buildAdvancedSaleOrderBody("s", port.creates[0].lines, port.creates[0].charges) as { Lines: Array<{ Price: number; Total: number; Tax: number }> };
    expect(body.Lines.every((l) => l.Price === 0 && l.Total === 0 && l.Tax === 0)).toBe(true);
    expect(port.creates[0].charges.reduce((n, c) => n + c.priceExVat, 0)).toBeCloseTo(10_000_000, 0);
  });
  it("a SKU that does not exist in Cin7 fails explicitly - nothing is created, substituted or altered", async () => {
    for (const id of ["flex_auger:UNMAPPED", "penning_package:UNMAPPED", "led_light:UNMAPPED"]) await resolveScopeItem(db as never, port, { isManager: true }, "mgr@x", { orgId: ORG, projectId, itemId: id, kind: "EXCLUDE", reason: "outside Cin7" });
    port.skus.delete("PNQ082");
    expect(await err(createSaleForProject(db as never, port, ON, "mgr@x", saleInput(projectId)))).toMatch(/do not exist in Cin7: PNQ082/);
    expect(port.creates).toHaveLength(0);
    expect(db.rows("project_cin7_sale_creations")).toHaveLength(0);
  });
  it("resolutions are controlled: manager only, reason required, only unmapped items, a MAP target must exist in Cin7, frozen after a Sale/claim", async () => {
    const r = (o: Record<string, unknown>, gates = { isManager: true }) => resolveScopeItem(db as never, port, gates, "mgr@x", { orgId: ORG, projectId, itemId: "led_light:UNMAPPED", kind: "EXCLUDE", reason: "x", ...o } as never);
    expect(await err(r({}, { isManager: false }))).toMatch(/manager/);
    expect(await err(r({ reason: " " }))).toMatch(/reason/);
    expect(await err(r({ itemId: "feeder" }))).toMatch(/only an unmapped item/i);
    expect(await err(r({ itemId: "nope" }))).toMatch(/not in the project/);
    expect(await err(r({ kind: "MAP", sku: "DOES-NOT-EXIST", quantity: 1 }))).toMatch(/does not exist in Cin7/);
    expect(await err(r({ kind: "MAP", sku: "NQ2784", quantity: 0 }))).toMatch(/positive quantity/);
    const items = await r({ kind: "MAP", sku: "NQ2784", quantity: 5, reason: "mapped" });
    expect(items.find((i) => i.id === "led_light:UNMAPPED")!.resolution).toMatchObject({ kind: "MAP", sku: "NQ2784", quantity: 5, reason: "mapped", by: "mgr@x" });
    expect(await err(r({ kind: "EXCLUDE" }))).toMatch(/already has a recorded resolution/);
    db.rows("project_cin7_sale_links").push({ id: "l", org_id: ORG, project_id: projectId, cin7_sale_id: "S" });
    expect(await err(r({ itemId: "penning_package:UNMAPPED" }))).toMatch(/Sale already exists/);
  });
  it("applyResolution is pure and the scope register is idempotent: loading it again changes nothing", async () => {
    const before = await loadProjectScope(db as never, ORG, projectId);
    const again = await loadProjectScope(db as never, ORG, projectId);
    expect(again.items).toEqual(before.items);
    const x = applyResolution(before.items, { itemId: "led_light:UNMAPPED", kind: "EXCLUDE", reason: "r", by: "m", at: "t" });
    expect(x.ok && before.items.find((i) => i.id === "led_light:UNMAPPED")!.resolution).toBeFalsy(); // input not mutated
  });
});

// ── invoice proposals ──────────────────────────────────────────────────────────
const claim = (stages: string[]) => stages.map((s) => ({ stageName: s, amountCents: R(100_000), taxCents: R(15_000) }));
const order = (o = 10) => [{ sku: "A", description: "Feeder", ordered: o }];
const base = { orderLines: order(), invoices: [], shipped: {}, reserved: {}, scopeSkus: ["A"] };

describe("5-9. invoice proposals: commercial charges separate from R0 product lines, driven by verified evidence", () => {
  it("classifies stages", () => {
    expect(["Deposit / Commencement", "Manufacturing", "Equipment Ready", "Delivery", "Installation", "Commissioning", "Variation"].map(stageKind)).toEqual(["DEPOSIT", "MANUFACTURING", "MANUFACTURING", "DELIVERY", "SERVICE", "SERVICE", "OTHER"]);
  });
  it("5. a deposit proposes the commercial charge only: no product lines (even if everything has shipped)", () => {
    const p = proposeInvoice({ ...base, claimLines: claim(["Deposit / Commencement"]), shipped: { A: 10 } });
    expect(p.dispatchRuleApplies).toBe(false);
    expect(p.subtotalCents).toBe(R(100_000)); expect(p.totalCents).toBe(R(115_000));
    expect(p.lines.every((l) => l.proposed === 0 && l.status === "EXCLUDED")).toBe(true);
    expect(p.notes.join(" ")).toMatch(/no physical product lines/);
    expect(proposeInvoice({ ...base, claimLines: claim(["Installation", "Commissioning"]), shipped: { A: 10 } }).lines[0].proposed).toBe(0);
  });
  it("6. a delivery invoice proposes exactly the verified shipped, not-yet-invoiced quantity", () => {
    const p = proposeInvoice({ ...base, claimLines: claim(["Delivery"]), shipped: { A: 6 }, invoices: [{ status: "DRAFT", lines: [{ sku: "A", quantity: 2 }] }] });
    expect(p.lines[0]).toMatchObject({ ordered: 10, invoiced: 2, shipped: 6, eligible: 4, proposed: 4, remainingToInvoice: 8, maxSelectable: 8, status: "PROPOSED" });
    expect(proposeInvoice({ ...base, claimLines: claim(["Delivery"]), shipped: { A: 99 } }).lines[0].eligible).toBe(10); // never above what was ordered
  });
  it("6. unreadable shipment or invoice evidence proposes NOTHING and says so (unknown is not zero)", () => {
    const a = proposeInvoice({ ...base, claimLines: claim(["Delivery"]), shipped: { A: null } }).lines[0];
    expect(a).toMatchObject({ status: "UNKNOWN", proposed: 0, eligible: null }); expect(a.reasons.join(" ")).toMatch(/unreadable/);
    const b = proposeInvoice({ ...base, claimLines: claim(["Delivery"]), shipped: { A: 5 }, invoices: [{ status: "DRAFT", lines: null }] }).lines[0];
    expect(b).toMatchObject({ status: "UNKNOWN", proposed: 0, invoiced: null });
  });
  it("7. manufacturing percentages never create product quantities: a large Manufacturing charge with nothing shipped proposes zero units", () => {
    const p = proposeInvoice({ ...base, claimLines: [{ stageName: "Manufacturing", amountCents: R(6_500_000), taxCents: R(975_000) }, { stageName: "Equipment Ready", amountCents: R(1_300_000), taxCents: R(195_000) }], shipped: {} });
    expect(p.subtotalCents).toBe(R(7_800_000));
    expect(p.lines[0]).toMatchObject({ proposed: 0, status: "NOTHING_ELIGIBLE" });
    expect(p.lines[0].reasons.join(" ")).toMatch(/Nothing has shipped/);
  });
  it("8. partial invoicing keeps the outstanding quantities right; voided invoices free their quantity; multiple invoices are not double counted", () => {
    const inv = (status: string, q: number) => ({ status, lines: [{ sku: "A", quantity: q }] });
    const p = proposeInvoice({ ...base, claimLines: claim(["Delivery"]), shipped: { A: 10 }, invoices: [inv("DRAFT", 3), inv("AUTHORISED", 2), inv("VOIDED", 4)] });
    expect(p.lines[0]).toMatchObject({ invoiced: 5, remainingToInvoice: 5, eligible: 5, proposed: 5 });
    const done = proposeInvoice({ ...base, claimLines: claim(["Delivery"]), shipped: { A: 10 }, invoices: [inv("DRAFT", 10)] }).lines[0];
    expect(done).toMatchObject({ eligible: 0, proposed: 0, status: "NOTHING_ELIGIBLE", remainingToInvoice: 0 });
  });
  it("9. preparing the proposal repeatedly is idempotent (a pure function of the facts)", () => {
    const input = { ...base, claimLines: claim(["Delivery"]), shipped: { A: 4 } };
    expect(proposeInvoice(input)).toEqual(proposeInvoice(structuredClone(input)));
    const frozen = structuredClone(input); proposeInvoice(frozen); expect(frozen).toEqual(input);
  });
  it("7. a manager may select more than has been dispatched only with a reason, never beyond the remaining invoiceable quantity, never an unknown or off-order SKU", () => {
    const p = proposeInvoice({ ...base, claimLines: claim(["Delivery"]), shipped: { A: 2 } });
    expect(validateSelection(p, [{ sku: "A", quantity: 2 }], null)).toBeNull();
    expect(validateSelection(p, [{ sku: "A", quantity: 5 }], null)).toMatch(/reason is required/);
    expect(validateSelection(p, [{ sku: "A", quantity: 5 }], "Contract requires invoicing on completion of manufacture")).toBeNull();
    expect(validateSelection(p, [{ sku: "A", quantity: 11 }], "r")).toMatch(/only 10 remain invoiceable/);
    expect(validateSelection(p, [{ sku: "B", quantity: 1 }], "r")).toMatch(/not on the Cin7 Sale order/);
    expect(validateSelection(p, [{ sku: "A", quantity: 0 }], null)).toMatch(/positive/);
    expect(validateSelection(p, [{ sku: "A", quantity: 1 }, { sku: "A", quantity: 1 }], null)).toMatch(/twice/);
    expect(validateSelection(proposeInvoice({ ...base, claimLines: claim(["Delivery"]), shipped: { A: null } }), [{ sku: "A", quantity: 1 }], "r")).toMatch(/unreadable/);
    expect(validateSelection(proposeInvoice({ ...base, claimLines: claim(["Deposit"]), shipped: { A: 10 } }), [{ sku: "A", quantity: 1 }], null)).toMatch(/reason is required/);
  });
});

// ── posting with the proposal rules, concurrency, variations ────────────────────
class InvPort implements Cin7Port {
  created: InvoiceRequest[] = [];
  sale: Cin7SaleView;
  constructor(id: string, public shipped: Record<string, number | null> = { A: 10 }, ordered = 10) {
    this.sale = { id, saleNumber: "SO-1", type: "Advanced Sale", orderStatus: "AUTHORISED", taxRule: "Standard Rate Sales", invoices: [], orderLines: [{ productId: "p1", sku: "A", name: "Feeder", quantity: ordered }] };
  }
  async fetchSale() { return structuredClone({ ...this.sale, shipped: this.shipped }); }
  async createInvoice(req: InvoiceRequest): Promise<InvoiceOutcome> {
    this.created.push(req);
    const sub = req.charges.reduce((n, c) => n + c.priceExVat, 0); const tax = req.charges.reduce((n, c) => n + c.taxAmount, 0);
    this.sale.invoices.push({ invoiceNumber: `INV-${this.created.length}`, taskId: `t${this.created.length}`, memo: req.memo, status: "DRAFT", subtotalCents: Math.round(sub * 100), taxCents: Math.round(tax * 100), totalCents: Math.round((sub + tax) * 100), lines: (req.lines ?? []).map((l) => ({ sku: l.sku, quantity: l.quantity, priceCents: 0 })) });
    return { kind: "created", invoiceNumber: `INV-${this.created.length}`, taskId: `t${this.created.length}`, status: "DRAFT", totalBeforeTax: sub, tax, total: sub + tax };
  }
}
const SALE_ID = "4fe3d99c-241d-4404-8795-4c448842108b";

async function invoiceWorld(shipped: Record<string, number | null> = { A: 10 }) {
  const db = new FakeDb();
  const projectId = await createProjectFromBaseline(db as never, ORG, "m@x", { ...goldenFixtureBaseline(), lines: [{ lineRef: "L1", sku: "A", description: "Feeder", quantity: 10, salesValueCents: 0, estimatedCostCents: null, suggestedStageName: null }] }, { reference: "PRJ-X", name: "n" });
  const v = (await loadProjectView(db as never, ORG, projectId))!;
  const st = (n: string) => v.stages.find((s) => s.name.startsWith(n))!.id;
  const rec = (n: string, a: string, b: string) => recordProgress(db as never, ORG, "x@x", { projectId, stageId: st(n), reportedPct: a, approvedPct: b, comment: "c" });
  await rec("Deposit", "100", "100"); await rec("Manufacturing", "75", "65"); await rec("Delivery", "25", "25");
  await setOpeningCommitments(db as never, ORG, "m@x", { projectId, reason: "opening", items: [{ stageId: st("Deposit"), amountCents: R(1_000_000) }, { stageId: st("Manufacturing"), amountCents: R(1_500_000) }] });
  const { claimId } = await createClaimDraft(db as never, ORG, "x@x", projectId);
  await submitClaimForApproval(db as never, ORG, projectId, claimId); await approveClaim(db as never, ORG, "mgr@x", projectId, claimId);
  const port = new InvPort(SALE_ID, shipped);
  await linkCin7Sale(db as never, port, ON, "mgr@x", { orgId: ORG, projectId, instanceId: "i", saleId: SALE_ID, revenueAccount: "200" });
  const post = (physicalLines?: Array<{ sku: string; quantity: number }>, earlyReason?: string) => postClaimToCin7(db as never, port, ON, "mgr@x", { orgId: ORG, projectId, claimId, confirmation: POST_CONFIRMATION_TEXT, physicalLines, earlyReason });
  return { db, projectId, claimId, port, post };
}

describe("6-10. the stored proposal and posting use the same recomputed rules", () => {
  it("prepareInvoiceProposal reads Cin7 once, writes nothing, and repeating it gives the identical proposal", async () => {
    const w = await invoiceWorld({ A: 4 });
    const writes = w.db.writes.length;
    const a = await prepareInvoiceProposal(w.db as never, w.port, { orgId: ORG, projectId: w.projectId, claimId: w.claimId });
    const b = await prepareInvoiceProposal(w.db as never, w.port, { orgId: ORG, projectId: w.projectId, claimId: w.claimId });
    expect({ ...a, preparedAt: "" }).toEqual({ ...b, preparedAt: "" });
    expect(a.proposal.lines[0]).toMatchObject({ sku: "A", shipped: 4, eligible: 4, proposed: 4 });
    expect(a.proposal.charges.map((c) => c.stageName)).toEqual(expect.arrayContaining(["Manufacturing", "Delivery"]));
    expect(a.proposal.totalCents).toBe(R(950_000) + R(142_500));
    expect(w.db.writes.length).toBe(writes);
    expect(w.port.created).toHaveLength(0);
  });
  it("posting recomputes eligibility from live Cin7 facts: dispatched quantity posts at R0; more than dispatched needs a recorded reason, which is stored", async () => {
    const w = await invoiceWorld({ A: 4 });
    expect(await err(w.post([{ sku: "A", quantity: 6 }]))).toMatch(/reason is required/);
    expect(w.port.created).toHaveLength(0); expect(w.db.rows("project_claim_cin7_postings")).toHaveLength(0);
    const r = await w.post([{ sku: "A", quantity: 6 }], "Contract: invoice on completion of manufacture");
    expect(r.state).toBe("CREATED");
    expect(w.port.created[0].lines).toEqual([{ productId: "p1", sku: "A", name: "Feeder", quantity: 6, earlyReason: "Contract: invoice on completion of manufacture" }]);
    expect(w.db.rows("project_claim_cin7_postings")[0].physical_lines).toEqual([{ sku: "A", quantity: 6, earlyReason: "Contract: invoice on completion of manufacture" }]);
  });
  it("unreadable shipment evidence blocks a physical selection; a commercial-only post still works", async () => {
    const w = await invoiceWorld({ A: null });
    expect(await err(w.post([{ sku: "A", quantity: 1 }], "r"))).toMatch(/unreadable/);
    expect((await w.post()).state).toBe("CREATED");
    expect(w.port.created[0].lines).toBeUndefined();
  });
  it("8. a dispatched quantity is invoiced once: the next proposal shows the remainder and a repeat of the same quantities is refused", async () => {
    const w = await invoiceWorld({ A: 10 });
    await w.post([{ sku: "A", quantity: 6 }]);
    const next = await prepareInvoiceProposal(w.db as never, w.port, { orgId: ORG, projectId: w.projectId, claimId: w.claimId });
    expect(next.proposal.lines[0]).toMatchObject({ invoiced: 6, remainingToInvoice: 4, eligible: 4 });
    // a second claim cannot re-invoice the 6 already on the first invoice
    expect(validateSelection(next.proposal, [{ sku: "A", quantity: 7 }], "r")).toMatch(/only 4 remain invoiceable/);
  });
  it("10. concurrent postings cannot invoice the same units: an in-flight posting's quantity is reserved, and a clash discovered after intent stands down before anything is sent", async () => {
    const w = await invoiceWorld({ A: 10 });
    // another claim's posting is already in flight (PENDING) holding 8 of the 10
    w.db.rows("project_claim_cin7_postings").push({ id: "other", org_id: ORG, project_id: w.projectId, claim_id: "other-claim", sale_link_id: w.db.rows("project_cin7_sale_links")[0].id, posting_state: "PENDING", physical_lines: [{ sku: "A", quantity: 8 }] });
    expect(await err(w.post([{ sku: "A", quantity: 5 }]))).toMatch(/only 2 remain invoiceable/);
    expect(w.port.created).toHaveLength(0);
    expect((await w.post([{ sku: "A", quantity: 2 }])).state).toBe("CREATED");
    expect(w.port.created).toHaveLength(1);
  });
  it("10. a posting that appears between validation and intent (the race) is caught after the intent is stored: this one sends nothing", async () => {
    const w = await invoiceWorld({ A: 10 });
    const linkId = w.db.rows("project_cin7_sale_links")[0].id;
    const realFrom = w.db.from.bind(w.db);
    (w.db as unknown as { from: (t: string) => unknown }).from = (t: string) => {
      const q = realFrom(t) as Record<string, (...a: unknown[]) => unknown>;
      if (t !== "project_claim_cin7_postings") return q;
      const insert = q.insert;
      q.insert = (...a: unknown[]) => {
        const r = insert.apply(q, a);
        // right after OUR intent is stored, a rival posting (another claim) appears holding the same units
        w.db.rows("project_claim_cin7_postings").push({ id: "rival", org_id: ORG, project_id: w.projectId, claim_id: "rival-claim", sale_link_id: linkId, posting_state: "PENDING", physical_lines: [{ sku: "A", quantity: 6 }] });
        return r;
      };
      return q;
    };
    expect(await err(w.post([{ sku: "A", quantity: 6 }]))).toMatch(/another posting on this Sale is already holding/);
    expect(w.port.created).toHaveLength(0);
    expect(w.db.rows("project_claim_cin7_postings").find((p) => p.claim_id === w.claimId)).toMatchObject({ posting_state: "FAILED_CONFIRMED_NO_WRITE", last_error_code: "CONCURRENT_QUANTITY" });
  });
  it("two simultaneous posts for the same claim create at most one invoice", async () => {
    const w = await invoiceWorld({ A: 10 });
    const results = await Promise.allSettled([w.post([{ sku: "A", quantity: 5 }]), w.post([{ sku: "A", quantity: 5 }])]);
    expect(w.port.created.length).toBeLessThanOrEqual(1);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    const lines = w.port.created.flatMap((c) => c.lines ?? []);
    expect(lines.reduce((n, l) => n + l.quantity, 0)).toBeLessThanOrEqual(10);
  });
});

describe("11. variation products and invoices stay isolated from BASE", () => {
  it("a variation's products are entered once at billing start into its own scope; BASE scope and Sale lines are untouched", async () => {
    const db = new FakeDb();
    const parent = await createProjectFromBaseline(db as never, ORG, "m@x", { ...goldenFixtureBaseline(), lines: [{ lineRef: "L1", sku: "A", description: "Feeder", quantity: 10, salesValueCents: 0, estimatedCostCents: null, suggestedStageName: null }] }, { reference: "PRJ-X", name: "n" });
    const v = await raiseVariation(db as never, ORG, "e@x", { projectId: parent, title: "Ventilation", description: "", amountCents: R(480_000) });
    await approveVariation(db as never, ORG, "m@x", parent, v.variationId);
    const baseBefore = JSON.stringify(db.rows("projects").find((p) => p.id === parent)!.baseline_snapshot);
    expect(await err(createVariationBillingProject(db as never, { isManager: true }, "m@x", { orgId: ORG, projectId: parent, variationId: v.variationId, products: [{ sku: "FAN1", description: "Fan", quantity: 0 }] }))).toMatch(/positive/);
    const { billingProjectId } = await createVariationBillingProject(db as never, { isManager: true }, "m@x", { orgId: ORG, projectId: parent, variationId: v.variationId, products: [{ sku: "FAN1", description: "Extraction fan", quantity: 6 }] });
    const child = effectiveScope(scopeFromSnapshot(db.rows("projects").find((p) => p.id === billingProjectId)!.baseline_snapshot));
    expect(child.lines).toEqual([{ sku: "FAN1", quantity: 6, description: "Extraction fan", sources: ["V001:FAN1"] }]);
    expect(effectiveScope(scopeFromSnapshot(db.rows("projects").find((p) => p.id === parent)!.baseline_snapshot)).lines.map((l) => l.sku)).toEqual(["A"]);
    expect(JSON.stringify(db.rows("projects").find((p) => p.id === parent)!.baseline_snapshot)).toBe(baseBefore); // BASE untouched
    expect(variationScope("V002", [{ sku: "X", description: "", quantity: 1 }, { sku: "X", description: "", quantity: 1 }])).toMatchObject({ ok: false });
    // a variation billing project with no products is a commercial-only Sale (empty scope), never inherits BASE products
    const v2 = await raiseVariation(db as never, ORG, "e@x", { projectId: parent, title: "Credit-free extra", description: "", amountCents: R(10_000) });
    await approveVariation(db as never, ORG, "m@x", parent, v2.variationId);
    const c2 = (await createVariationBillingProject(db as never, { isManager: true }, "m@x", { orgId: ORG, projectId: parent, variationId: v2.variationId })).billingProjectId;
    expect(effectiveScope(scopeFromSnapshot(db.rows("projects").find((p) => p.id === c2)!.baseline_snapshot)).lines).toEqual([]);
  });
});

describe("5. the project product register (quoted / ordered / assembled / available / invoiced / shipped / remaining)", () => {
  const scope = [{ sku: "A", description: "Feeder", quantity: 10 }, { sku: "B", description: "Door", quantity: 4 }];
  it("shows every required field, with unknown distinct from zero, and no double counting across invoices and partial fulfilments", () => {
    const r = buildPhysicalStatus({
      scope, saleLinked: true,
      ordered: [{ sku: "A", name: "Feeder", quantity: 10 }],
      invoices: [{ invoiceNumber: "I1", status: "DRAFT", lines: [{ sku: "A", quantity: 3 }] }, { invoiceNumber: "I2", status: "AUTHORISED", lines: [{ sku: "A", quantity: 2 }] }, { invoiceNumber: "I3", status: "VOIDED", lines: [{ sku: "A", quantity: 9 }] }],
      fulfilments: [{ number: 1, packLines: [{ sku: "A", quantity: 4 }], shipped: true }, { number: 2, packLines: [{ sku: "A", quantity: 3 }], shipped: true }, { number: 3, packLines: [{ sku: "A", quantity: 3 }], shipped: false }],
      stock: { A: { onHand: 20, allocated: 5, available: 15 } }, assemblies: [{ sku: "A", status: "COMPLETED", quantity: 6 }, { sku: "A", status: "IN PROGRESS", quantity: 2 }],
    });
    expect(r.rows.find((x) => x.sku === "A")).toMatchObject({ quoted: 10, ordered: 10, assemblyCompleted: 6, assemblyInProgress: 2, available: 15, invoiced: 5, shipped: 7, remainingToInvoice: 5, remainingToDeliver: 3 });
    // B is in the approved scope but not on the Sale: ordered is a known 0, everything else from Cin7 is unknown (not zero)
    expect(r.rows.find((x) => x.sku === "B")).toMatchObject({ quoted: 4, ordered: 0, invoiced: 0, shipped: 0, available: null, hasAssemblyRecords: false });
    expect(r.exceptions.map((e) => e.code)).toContain("NOT_ON_ORDER");
  });
  it("before any Sale exists: quoted is known, ordered / available / invoiced / shipped are unknown (null), never 0", () => {
    const r = buildPhysicalStatus({ scope, saleLinked: false, ordered: [], invoices: [], fulfilments: [], stock: {}, assemblies: [] });
    expect(r.rows[0]).toMatchObject({ sku: "A", quoted: 10, ordered: null, available: null, remainingToInvoice: null, remainingToDeliver: null });
    expect(r.rows[0].shipped).toBe(0); expect(r.rows[0].invoiced).toBe(0);
  });
  it("flags a quantity that differs from the approved scope", () => {
    const r = buildPhysicalStatus({ scope, saleLinked: true, ordered: [{ sku: "A", name: "Feeder", quantity: 9 }], invoices: [], fulfilments: [], stock: {}, assemblies: [] });
    expect(r.exceptions.some((e) => e.code === "QUANTITY_DIFFERS_FROM_SCOPE" && e.sku === "A")).toBe(true);
  });
  it("loadPhysicalStatus works without a Sale (scope only) and never writes", async () => {
    const db = new FakeDb();
    const id = await createProjectFromBaseline(db as never, ORG, "m@x", { ...goldenFixtureBaseline(), lines: [{ lineRef: "L1", sku: "A", description: "Feeder", quantity: 10, salesValueCents: 0, estimatedCostCents: null, suggestedStageName: null }] }, { reference: "PRJ-X", name: "n" });
    const writes = db.writes.length;
    const r = await loadPhysicalStatus(db as never, { readSale: async () => { throw new Error("no"); }, readStock: async () => null, readAssemblies: async () => [] }, { orgId: ORG, projectId: id });
    expect(r.linked).toBe(false);
    expect(r.rows[0]).toMatchObject({ sku: "A", quoted: 10, ordered: null });
    expect(db.writes.length).toBe(writes);
  });
});
