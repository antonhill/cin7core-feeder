// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectOverview } from "../ProjectOverview";
import { ConsolidatedReportPanel } from "../ConsolidatedReportPanel";
import { getProjectOverviewDataAction } from "../../overview-actions";
import { getConsolidatedCommercialAction } from "../../variation-billing-actions";
import { buildConsolidatedCommercial } from "@/lib/projects/consolidated-report";
import { R, claim, demoInput, posting, project, progress, scope, stage } from "@/lib/projects/__tests__/overview-fixtures";
import type { ProjectView } from "@/lib/projects/project-view";

vi.mock("../../overview-actions", () => ({ getProjectOverviewDataAction: vi.fn() }));
vi.mock("../../physical-actions", () => ({ getPhysicalStatusAction: vi.fn() }));
vi.mock("../../variation-billing-actions", () => ({ getConsolidatedCommercialAction: vi.fn() }));

const overviewAction = vi.mocked(getProjectOverviewDataAction);
const reportAction = vi.mocked(getConsolidatedCommercialAction);
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

// Owner-shaped single-scope fixtures: three stages fully billed by four APPROVED claims (a fifth is cancelled and has no posting).
function ownerShaped(postings: ReturnType<typeof posting>[]) {
  const base = project({ id: "p-base", project_reference: "PRJ-T-1", original_contract_cents: R(1000) });
  const stages = [stage("s1", 1, "Deposit", R(400)), stage("s2", 2, "Delivery", R(500)), stage("s3", 3, "Install", R(100))];
  const claims = [claim("c1", 1, "APPROVED", R(400)), claim("c2", 2, "APPROVED", R(500)), claim("c3", 3, "APPROVED", R(60)), claim("c4", 4, "APPROVED", R(40)), claim("c5", 5, "CANCELLED_BEFORE_WRITE", R(10))];
  const lines = [["c1", "s1", 400], ["c2", "s2", 500], ["c3", "s3", 60], ["c4", "s3", 40], ["c5", "s3", 10]].map(([c, s, r]) => ({ claim_id: c as string, stage_id: s as string, current_claim_cents: R(r as number) }));
  const i = demoInput({ scopes: [scope({ project: base, stages, events: stages.map((s) => progress(s.id, 10000, 10000)), claims, lines, postings, saleNumber: "SO-1" })], unbilledApprovedVariations: [] });
  return { ok: true as const, data: { scopes: i.scopes, unbilledApprovedVariations: i.unbilledApprovedVariations, deliveries: i.deliveries, estimates: null, viewer: i.viewer } };
}
const ids = ["c1", "c2", "c3", "c4"];
const allReconciled = ids.map((id, n) => posting(id, "RECONCILED", `INV-${n + 1}`, n === 3 ? "AUTHORISED" : "DRAFT", true));

describe("Overview Financial reconciliation names the shared Commercial billing state", () => {
  const show = async (postings: ReturnType<typeof posting>[]) => { overviewAction.mockResolvedValue(ownerShaped(postings)); render(<ProjectOverview projectId="p-base" refreshKey="k" onOpenTab={vi.fn() as never} />); return (await screen.findByTestId("billing-p-base")).textContent!; };
  it("complete: all four APPROVED claims reconciled, three stages fully billed, the cancelled claim ignored", async () => {
    expect(await show(allReconciled)).toBe("Commercial billing: Complete");
    expect(screen.getByText(/4 Cin7 invoices \(.*\), 4 reconciled/)).toBeTruthy();
  });
  it("partial: one invoice created but not reconciled -> In progress, with the reason", async () => {
    const t = await show([...allReconciled.slice(0, 3), posting("c4", "CREATED", "INV-4", "DRAFT", false)]);
    expect(t).toMatch(/^Commercial billing: In progress/);
    expect(t).toMatch(/awaiting reconciliation/);
  });
  it("mismatch: the amount mismatch is named in the summary, the claim row and the state", async () => {
    const t = await show([...allReconciled.slice(0, 3), posting("c4", "CREATED", "INV-4", "DRAFT", false, null, "AMOUNT_MISMATCH")]);
    expect(t).toMatch(/^Commercial billing: Needs attention/);
    expect(t).toMatch(/amount mismatch/);
    expect(screen.getByText(/1 with a recorded amount mismatch/)).toBeTruthy();
    expect(screen.getByText("Amount mismatch recorded")).toBeTruthy();
    expect(screen.queryByText("Not reconciled yet")).toBeNull();
  });
  it("approved but not posted -> Needs attention", async () => {
    expect(await show(allReconciled.slice(0, 3))).toMatch(/^Commercial billing: Needs attention.*not posted to Cin7/);
  });
});

describe("Consolidated report claim rows", () => {
  const report = (claims: Parameters<typeof buildConsolidatedCommercial>[0][number]["claims"]) => buildConsolidatedCommercial([
    { scope: "BASE", label: "Original contract", projectId: "p", contractCents: R(1000), claimableCents: 0, billingStarted: true, claims, invoices: [] },
  ]);
  const view = { project: { id: "p" } } as unknown as ProjectView;
  const run = async (claims: Parameters<typeof report>[0]) => {
    reportAction.mockResolvedValue({ ok: true, data: report(claims) } as never);
    render(<ConsolidatedReportPanel view={view} />);
    (await screen.findByRole("button", { name: "Show commercial position" })).click();
    await waitFor(() => expect(screen.getByText("Original contract")).toBeTruthy());
    return within(screen.getByRole("table")).getAllByRole("row")[1].textContent!;
  };
  it("shows 'Approved · Reconciled as INV-n', never a bare 'Approved', for a posted claim", async () => {
    const t = await run([{ claimNumber: "C01", status: "APPROVED", subtotalCents: R(400), totalCents: R(460), invoiceNumber: "INV-7", postingState: "RECONCILED", reconciled: true, mismatch: false }]);
    expect(t).toMatch(/C01 Approved · Reconciled as INV-7/);
  });
  it("names posted-not-reconciled, a mismatch and an unposted approved claim", async () => {
    const t = await run([
      { claimNumber: "C01", status: "APPROVED", subtotalCents: 1, totalCents: 1, invoiceNumber: "INV-1", postingState: "CREATED", reconciled: false, mismatch: false },
      { claimNumber: "C02", status: "APPROVED", subtotalCents: 1, totalCents: 1, invoiceNumber: "INV-2", postingState: "CREATED", reconciled: false, mismatch: true },
      { claimNumber: "C03", status: "APPROVED", subtotalCents: 1, totalCents: 1, invoiceNumber: null, postingState: null, reconciled: false, mismatch: false },
    ]);
    expect(t).toMatch(/C01 Approved · Posted as INV-1, not reconciled yet/);
    expect(t).toMatch(/C02 Approved · Posted as INV-2, amount mismatch recorded/);
    expect(t).toMatch(/C03 Approved · Not posted to Cin7 yet/);
  });
});
