// CONSOLIDATED ACCEPTANCE (release candidate): the whole NewQuip chain on one codebase with the real pricing engine and workbook snapshot -
// Load Demo Defaults -> R10m quote -> manager-only margins -> approval -> project scope -> Cin7 Sale preparation (R0) -> progress-invoice proposal
// without SKU re-entry -> variation isolation -> P0 -> writes OFF. Cin7 is modelled by in-memory fakes; nothing here can reach the network.
import { describe, expect, it } from "vitest";
import { createWorkbookPriceSource } from "@/newquip/grower/workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "@/newquip/grower/snapshot";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { emptyDraft } from "@/newquip/grower/draft";
import { applyDemoDefaults } from "@/newquip/grower/demo-defaults";
import { buildAcceptedBaseline, baselineMatchesHash, type AcceptedBaseline } from "@/newquip/quote/baseline";
import { buildMarginSheet, redactInternalFinancials } from "@/newquip/quote/margin";
import { POC_SIX_STAGE_SCHEDULE } from "@/newquip/quote/billing-schedule";
import { quoteToProjectBaseline } from "@/newquip/quote/to-project";
import { FakeDb } from "./fake-db";
import { approveClaim, createClaimDraft, createProjectFromBaseline, loadProjectView, recordProgress, setOpeningCommitments, submitClaimForApproval } from "../project-store";
import { resolveScopeItem } from "../scope-store";
import { createSaleForProject, type SaleCreationPort } from "../cin7-sale-creation-store";
import { CREATE_CONFIRMATION_TEXT } from "../cin7-sale-creation";
import { prepareInvoiceProposal } from "../invoice-proposal-store";
import { linkCin7Sale, postClaimToCin7, type Cin7Port, type Cin7SaleView, type InvoiceOutcome, type InvoiceRequest, type WriteGates } from "../cin7-posting-store";
import { POST_CONFIRMATION_TEXT } from "../cin7-posting";
import { approveVariation, raiseVariation } from "../variation-store";
import { createVariationBillingProject, loadConsolidatedProject } from "../variation-billing-store";
import { effectiveScope, scopeFromSnapshot } from "../product-scope";
import { runP0, type P0Port } from "../p0-checklist";
import { cin7WritesEnabled, NEWQUIP_REQUIRED_SUPABASE_REF } from "../write-flag";
import { NEWQUIP_POC_CIN7_INSTANCE_ID, OPERATIONAL_CUSTOMER_DENYLIST } from "@/newquip/access";

const ORG = "org-nq";
const ON: WriteGates = { writesEnabled: true, orgEnabled: true, isManager: true };
const ctx = (withholdCost: boolean) => ({ priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost });
const APPROVALS = { customerConfirmedAt: "t", customerConfirmedCents: 1, customerConfirmedBy: "r", handoffBy: "r", estimatorSignoffBy: "e", estimatorSignoffAt: "t", managerApprovedBy: "m", managerApprovedAt: "t" };
const R = (n: number) => n * 100;

describe("release-candidate chain", () => {
  const draft = applyDemoDefaults(emptyDraft()).draft;
  const manager = evaluateDraft(draft, ctx(false));
  const rep = evaluateDraft(draft, ctx(true));
  const approved = buildAcceptedBaseline({ quoteRef: "NQ-Q-0001", revision: 1, draft, evaluation: rep, marginEvaluation: manager, approvals: APPROVALS });

  it("Load Demo Defaults reproduces the R10m quote, READY, with no open items", () => {
    expect(Math.round(manager.budget!.totals.subtotalExTax * 100)).toBe(R(10_000_000));
    expect(manager.readiness.state).toBe("READY");
    expect(manager.budget!.blockers).toEqual([]);
    expect(approved.baseline.contractCents).toBe(R(10_000_000));
  });
  it("manager-only margins: managers see cost/GP/margin per line, a rep sees none, and the frozen sheet is redacted for non-managers", () => {
    const sheet = buildMarginSheet(manager.budget!);
    expect(sheet.lines.some((l) => l.costCents !== null && l.marginPct !== null)).toBe(true);
    expect(rep.budget!.lines.every((l) => l.estimatedCost === null && l.estimatedGP === null && l.marginPct === null)).toBe(true);
    expect(approved.baseline.internalMargin).toBeDefined();
    expect(JSON.stringify(redactInternalFinancials({ draft, accepted_baseline: approved.baseline }, false))).not.toMatch(/internalMargin/);
  });
  it("an existing sealed quote is never changed by any of this", () => {
    const sealed = JSON.stringify(approved.baseline);
    quoteToProjectBaseline(approved.baseline, approved.hash, "q1"); applyDemoDefaults(draft); effectiveScope(approved.baseline.physicalScope!);
    expect(JSON.stringify(approved.baseline)).toBe(sealed);
    expect(baselineMatchesHash(approved.baseline, approved.hash)).toBe(true);
  });

  it("quote -> project -> Cin7 Sale (R0) -> invoice proposal -> post, with no SKU typed anywhere; variation stays isolated; P0 passes; writes are off", async () => {
    const db = new FakeDb();
    const projectId = await createProjectFromBaseline(db as never, ORG, "m@x", quoteToProjectBaseline(approved.baseline, approved.hash, "q1", POC_SIX_STAGE_SCHEDULE), { reference: "PRJ-NQ-Q-0001", name: "Demo" });
    // the project inherited the approved scope (and only that)
    const scope = effectiveScope(scopeFromSnapshot(db.rows("projects").find((p) => p.id === projectId)!.baseline_snapshot));
    expect(scope.blockers.length).toBe(3); // M75, penning, FORTIS LED: unmapped until a manager decides
    for (const id of ["flex_auger:UNMAPPED", "penning_package:UNMAPPED", "led_light:UNMAPPED"]) {
      await resolveScopeItem(db as never, { resolveProducts: async () => ({ ids: new Map(), missing: [] }) }, { isManager: true }, "mgr@x", { orgId: ORG, projectId, itemId: id, kind: "EXCLUDE", reason: "Supplied outside Cin7 stock (release-candidate test)" });
    }
    const eff = effectiveScope(scopeFromSnapshot(db.rows("projects").find((p) => p.id === projectId)!.baseline_snapshot));
    expect(eff.blockers).toEqual([]);
    expect(eff.lines.length).toBe(12);

    // Cin7 Sale preparation populates the products at R0 without typing
    const sales = new Map<string, import("../cin7-sale-creation").SaleReadBack>();
    let created: Parameters<SaleCreationPort["createSale"]>[0] | null = null;
    const salePort: SaleCreationPort = {
      customerExists: async () => true, customerDefaults: async () => ({ taxRule: "Standard Rate Sales", revenueAccount: "200", location: "MSTR" }),
      resolveProducts: async (s) => ({ ids: new Map(s.map((k) => [k, `id-${k}`])), missing: [] }), assemblySkus: async () => [], stockAt: async () => [],
      createSale: async (req) => {
        created = req;
        sales.set("sale-1", { id: "sale-1", type: "Advanced Sale", orderStatus: "AUTHORISED", customer: req.header.customer, externalId: req.header.externalId, taxRule: req.header.taxRule,
          lines: req.lines.map((l) => ({ sku: l.sku, quantity: l.quantity, priceCents: 0 })), charges: req.charges.map((c) => ({ description: c.description, priceCents: Math.round(c.priceExVat * 100), taxCents: Math.round(c.taxAmount * 100) })), invoiceCount: 0, fulfilmentCount: 0 });
        return { kind: "created", saleId: "sale-1", saleNumber: "SO-1" };
      },
      readSale: async (id) => structuredClone(sales.get(id)!), findByExternalId: async () => [],
    };
    const sale = await createSaleForProject(db as never, salePort, ON, "mgr@x", { orgId: ORG, projectId, instanceId: "i", confirmation: CREATE_CONFIRMATION_TEXT, customerName: "NQ Test Customer", location: "MSTR", revenueAccount: "200", cin7TaxRule: "Standard Rate Sales" });
    expect(sale).toMatchObject({ state: "RECONCILED", linked: true });
    expect(created!.lines.length).toBe(12);
    expect(created!.lines.find((l) => l.sku === "PNQ082")!.quantity).toBe(216);
    expect(created!.charges.reduce((n, c) => n + c.priceExVat, 0)).toBeCloseTo(10_000_000, 0);

    // approved claim, then the progress invoice is proposed from the project + Cin7 facts
    const v = (await loadProjectView(db as never, ORG, projectId))!;
    const st = (n: string) => v.stages.find((s) => s.name.startsWith(n))!.id;
    const rec = (n: string, a: string, b: string) => recordProgress(db as never, ORG, "x@x", { projectId, stageId: st(n), reportedPct: a, approvedPct: b, comment: "c" });
    await rec("Deposit", "100", "100"); await rec("Manufacturing", "75", "65"); await rec("Delivery", "25", "25");
    await setOpeningCommitments(db as never, ORG, "m@x", { projectId, reason: "opening", items: [{ stageId: st("Deposit"), amountCents: v.stages.find((s) => s.id === st("Deposit"))!.valueCents }] });
    const { claimId } = await createClaimDraft(db as never, ORG, "x@x", projectId);
    await submitClaimForApproval(db as never, ORG, projectId, claimId); await approveClaim(db as never, ORG, "mgr@x", projectId, claimId);

    const lines = created!.lines;
    const cin7: Cin7Port & { invoices: InvoiceRequest[] } = {
      invoices: [],
      fetchSale: async (): Promise<Cin7SaleView> => ({ id: "sale-1", saleNumber: "SO-1", type: "Advanced Sale", orderStatus: "AUTHORISED", taxRule: "Standard Rate Sales", invoices: [],
        orderLines: lines.map((l) => ({ productId: l.productId, sku: l.sku, name: l.name, quantity: l.quantity })),
        shipped: Object.fromEntries(lines.map((l) => [l.sku, l.sku === "PNQ082" ? 100 : 0])) }), // only 100 feeders have shipped
      createInvoice: async (req): Promise<InvoiceOutcome> => { cin7.invoices.push(req); const sub = req.charges.reduce((n, c) => n + c.priceExVat, 0); const tax = req.charges.reduce((n, c) => n + c.taxAmount, 0);
        return { kind: "created", invoiceNumber: "INV-1", taskId: "t", status: "DRAFT", totalBeforeTax: sub, tax, total: sub + tax }; },
    };
    await linkCin7Sale(db as never, cin7, ON, "mgr@x", { orgId: ORG, projectId, instanceId: "i", saleId: "4fe3d99c-241d-4404-8795-4c448842108b", revenueAccount: "200" }).catch(() => undefined); // already linked by the Sale creation
    const prepared = await prepareInvoiceProposal(db as never, cin7, { orgId: ORG, projectId, claimId });
    const proposed = prepared.proposal.lines.filter((l) => l.proposed > 0);
    expect(proposed.map((l) => [l.sku, l.proposed])).toEqual([["PNQ082", 100]]); // dispatch evidence drives it, not the 65% manufacturing claim
    expect(prepared.proposal.charges.length).toBeGreaterThan(0);
    const posted = await postClaimToCin7(db as never, cin7, ON, "mgr@x", { orgId: ORG, projectId, claimId, confirmation: POST_CONFIRMATION_TEXT, physicalLines: proposed.map((l) => ({ sku: l.sku, quantity: l.proposed })) });
    expect(posted.state).toBe("CREATED");
    expect(cin7.invoices[0].lines).toEqual([{ productId: "id-PNQ082", sku: "PNQ082", name: expect.any(String), quantity: 100 }]);
    expect(cin7.invoices[0].charges.reduce((n, c) => n + c.priceExVat, 0)).toBeGreaterThan(0);

    // variation: its own scope, own billing project; BASE untouched
    const var1 = await raiseVariation(db as never, ORG, "e@x", { projectId, title: "Additional ventilation", description: "", amountCents: R(480_000) });
    await approveVariation(db as never, ORG, "m@x", projectId, var1.variationId);
    const baseSnap = JSON.stringify(db.rows("projects").find((p) => p.id === projectId)!.baseline_snapshot);
    const { billingProjectId } = await createVariationBillingProject(db as never, { isManager: true }, "m@x", { orgId: ORG, projectId, variationId: var1.variationId, products: [{ sku: "FAN-1", description: "Extraction fan", quantity: 4 }] });
    expect(effectiveScope(scopeFromSnapshot(db.rows("projects").find((p) => p.id === billingProjectId)!.baseline_snapshot)).lines.map((l) => l.sku)).toEqual(["FAN-1"]);
    expect(JSON.stringify(db.rows("projects").find((p) => p.id === projectId)!.baseline_snapshot)).toBe(baseSnap);
    const c = (await loadConsolidatedProject(db as never, ORG, projectId))!;
    expect(c.scopes.map((s) => s.scope)).toEqual(["BASE", "VARIATION"]);
    expect(c.totals.contractCents).toBe(R(10_000_000) + R(480_000));

    // P0 stays read-only and passes for the fixture's SKUs with a correctly set-up customer
    const url = `https://${NEWQUIP_REQUIRED_SUPABASE_REF}.supabase.co`;
    const p0: P0Port = { customerExists: async () => true, customerDefaults: async () => ({ taxRule: "Standard Rate Sales", revenueAccount: "200", location: "MSTR" }),
      resolveProducts: async (s) => ({ ids: new Map(s.map((k) => [k, "id"])), missing: [] }), assemblySkus: async () => [], stockAt: async () => [{ location: "MSTR", available: 1_000_000 }], findByExternalId: async () => [] };
    const report = await runP0({ env: { SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_URL: url, VERCEL_ENV: "preview" }, instances: [{ id: NEWQUIP_POC_CIN7_INSTANCE_ID, name: "NewQuip POC" }], expectedInstanceId: NEWQUIP_POC_CIN7_INSTANCE_ID, denylist: OPERATIONAL_CUSTOMER_DENYLIST, portFor: () => p0 },
      { customerName: "NQ Test Customer", location: "MSTR", taxRule: "Standard Rate Sales", revenueAccount: "200", skus: eff.lines.slice(0, 2).map((l) => ({ sku: l.sku, quantity: 1 })), externalId: "NEWQUIP-PROJECTS-SALE:X" });
    expect(report.counts).toMatchObject({ FAIL: 0, NOT_RUN: 0 });
  });

  it("Cin7 writes are OFF by default, off on Production whatever the flag, and off for any other Supabase project", () => {
    const url = `https://${NEWQUIP_REQUIRED_SUPABASE_REF}.supabase.co`;
    const wired = { SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_URL: url };
    expect(cin7WritesEnabled({ ...wired })).toBe(false);
    expect(cin7WritesEnabled({ ...wired, NEWQUIP_CIN7_WRITES_ENABLED: "true", VERCEL_ENV: "production" })).toBe(false);
    expect(cin7WritesEnabled({ NEWQUIP_CIN7_WRITES_ENABLED: "true" })).toBe(false);
  });
});
