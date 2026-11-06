import { describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { buildConsolidatedCommercial, buildConsolidatedPhysical, type ReportScopeInput } from "../consolidated-report";
import { goldenFixtureBaseline } from "../baseline";
import { createProjectFromBaseline } from "../project-store";
import { approveVariation, raiseVariation } from "../variation-store";
import { createVariationBillingProject, loadConsolidatedCommercial, saveDraftSchedule } from "../variation-billing-store";
import { defaultVariationSchedule } from "../variation-schedule";

const R = (n: number) => n * 100;
const inv = (invoiceNumber: string, ex: number, state = "RECONCILED") => ({ invoiceNumber, amountExVatCents: R(ex), totalCents: Math.round(R(ex) * 1.15), state });

// The tested real-world example (SO-00023 / INV-00027 / INV-00028 / INV-00029), ex VAT.
const base: ReportScopeInput = {
  scope: "BASE", label: "Original contract", projectId: "p-base", contractCents: R(100_000), claimableCents: R(63_000 - 5_000 + 5_000 - 5_000), billingStarted: true,
  claims: [{ claimNumber: "C01", status: "RECONCILED", subtotalCents: R(10_000), totalCents: R(11_500), invoiceNumber: "INV-00027" }, { claimNumber: "C02", status: "RECONCILED", subtotalCents: R(27_000), totalCents: R(31_050), invoiceNumber: "INV-00028" }],
  invoices: [inv("INV-00027", 10_000), inv("INV-00028", 27_000)],
};
const variation: ReportScopeInput = {
  scope: "VARIATION", label: "V001 variation", projectId: "p-v001", contractCents: R(5_000), claimableCents: 0, billingStarted: true,
  claims: [{ claimNumber: "V-C01", status: "RECONCILED", subtotalCents: R(5_000), totalCents: R(5_750), invoiceNumber: "INV-00029" }], invoices: [inv("INV-00029", 5_000)],
};

describe("consolidated commercial report - regression fixture", () => {
  it("R100,000 + V001 R5,000 = R105,000; original invoices R37,000 + variation R5,000 = R42,000; remaining R63,000", () => {
    const r = buildConsolidatedCommercial([base, variation]);
    expect(r.contract).toEqual({ originalCents: R(100_000), approvedVariationsCents: R(5_000), revisedCents: R(105_000) });
    expect(r.invoiced).toEqual({ originalCents: R(37_000), variationsCents: R(5_000), totalCents: R(42_000) });
    expect(r.remainingContractCents).toBe(R(63_000));
    expect(r.scopes.map((s) => [s.label, s.invoiceNumbers.join(","), s.invoicedCents, s.remainingCents])).toEqual([["Original contract", "INV-00027,INV-00028", R(37_000), R(63_000)], ["V001 variation", "INV-00029", R(5_000), 0]]);
    expect(r.warnings).toEqual([]);
  });
  it("keeps TOTAL contract remaining separate from CLAIMABLE NOW", () => {
    const r = buildConsolidatedCommercial([{ ...base, claimableCents: R(20_000) }, variation]);
    expect(r.remainingContractCents).toBe(R(63_000));
    expect(r.claimableNowCents).toBe(R(20_000));
  });
  it("counts each scope once even if it is supplied twice, and flags it", () => {
    const r = buildConsolidatedCommercial([base, variation, variation]);
    expect(r.invoiced.totalCents).toBe(R(42_000));
    expect(r.warnings.join()).toMatch(/more than once/);
  });
  it("an approved variation whose billing has not started is in the contract, not invoiceable, and flagged", () => {
    const r = buildConsolidatedCommercial([base, { ...variation, projectId: "unbilled:v2", label: "V002 variation", contractCents: R(2_000), invoices: [], claims: [], billingStarted: false }]);
    expect(r.contract.revisedCents).toBe(R(102_000));
    expect(r.remainingContractCents).toBe(R(102_000 - 37_000));
    expect(r.warnings.join()).toMatch(/V002 variation: approved but billing has not started/);
  });
  it("flags over-invoicing instead of hiding it", () => {
    expect(buildConsolidatedCommercial([{ ...base, invoices: [inv("INV-X", 100_001)] }]).warnings.join()).toMatch(/exceeds its contract/);
  });
});

describe("consolidated physical by scope", () => {
  const row = (sku: string, rem: number | null) => ({ sku, name: sku, quoted: 1, ordered: 1, invoiced: 1, shipped: 1 - (rem ?? 0), remainingToDeliver: rem });
  it("sums outstanding units per scope and overall; unknown is unknown, not zero", () => {
    const p = buildConsolidatedPhysical([{ label: "Original contract", scope: "BASE", linked: true, rows: [row("NQCP137", 0), row("X", 2)] }, { label: "V001", scope: "VARIATION", linked: true, rows: [row("KNQPP014", 1)] }]);
    expect(p.sections.map((s) => s.outstandingUnits)).toEqual([2, 1]);
    expect(p.outstandingUnits).toBe(3);
    const u = buildConsolidatedPhysical([{ label: "A", scope: "BASE", linked: true, rows: [row("X", null)] }, { label: "B", scope: "VARIATION", linked: true, rows: [row("Y", 1)] }]);
    expect(u.sections[0]).toMatchObject({ outstandingUnits: null, unknownRows: 1 });
    expect(u.outstandingUnits).toBeNull();
    expect(buildConsolidatedPhysical([{ label: "A", scope: "BASE", linked: false, rows: [row("X", 0)] }]).outstandingUnits).toBeNull(); // no Sale = unknown
  });
});

describe("loader: variation billing projects are not double counted", () => {
  it("reads the BASE project, its variation billing project and an unbilled variation exactly once each", async () => {
    const db = new FakeDb();
    const ORG = "org-a";
    const parent = await createProjectFromBaseline(db as never, ORG, "m@x", goldenFixtureBaseline(), { reference: "PRJ-1", name: "Grower" });
    const mk = async (amount: number) => {
      const { variationId } = await raiseVariation(db as never, ORG, "e@x", { projectId: parent, title: "V", description: "", amountCents: amount });
      await saveDraftSchedule(db as never, ORG, parent, variationId, defaultVariationSchedule());
      await approveVariation(db as never, ORG, "m@x", parent, variationId);
      return variationId;
    };
    const v1 = await mk(500_000); await mk(200_000);
    const child = await createVariationBillingProject(db as never, { isManager: true }, "m@x", { orgId: ORG, projectId: parent, variationId: v1 });
    const sale = (project_id: string, claim_id: string, ex: number, num: string) => db.rows("project_claim_cin7_postings").push({ org_id: ORG, project_id, claim_id, posting_state: "RECONCILED", amount_ex_vat_cents: ex, total_cents: Math.round(ex * 1.15), cin7_invoice_number: num });
    sale(parent, "c1", 1_000_000, "INV-A");
    sale(child.billingProjectId, "c2", 500_000, "INV-B");
    const r = (await loadConsolidatedCommercial(db as never, ORG, parent))!;
    const original = goldenFixtureBaseline().contractCents;
    expect(r.contract).toEqual({ originalCents: original, approvedVariationsCents: 700_000, revisedCents: original + 700_000 });
    expect(r.scopes.map((s) => s.label)).toEqual(["Original contract", "V001 variation", "V002 variation"]);
    expect(r.invoiced).toEqual({ originalCents: 1_000_000, variationsCents: 500_000, totalCents: 1_500_000 });
    expect(r.remainingContractCents).toBe(original + 700_000 - 1_500_000);
    expect(r.warnings.join()).toMatch(/V002 variation: approved but billing has not started/);
  });
});
