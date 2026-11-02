// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectWorkspace } from "../ProjectWorkspace";
import { getProjectAction } from "@/app/projects/actions";
import { getProjectOverviewDataAction } from "@/app/projects/overview-actions";
import { formatCents } from "@/lib/projects/project-view";
import { demoInput, project, stage, view } from "@/lib/projects/__tests__/overview-fixtures";

// The REAL ProjectWorkspace (tabs, banners, the integration point) and the REAL overview; only server actions and the router are replaced. Panels that
// belong to other tabs are never mounted on these tabs, so their action modules are stubbed empty.
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }), useParams: () => ({}) }));
vi.mock("@/app/projects/actions", () => ({ getProjectAction: vi.fn() }));
vi.mock("@/app/projects/overview-actions", () => ({ getProjectOverviewDataAction: vi.fn() }));
vi.mock("@/app/projects/physical-actions", () => ({ getPhysicalStatusAction: vi.fn() }));
vi.mock("@/app/projects/cin7-actions", () => ({ getCommercialBootAction: vi.fn() }));
vi.mock("@/app/projects/profitability-actions", () => ({}));
vi.mock("@/app/projects/procurement-actions", () => ({}));
vi.mock("@/app/projects/variation-billing-actions", () => ({}));
vi.mock("@/app/projects/delivery-actions", () => ({}));
vi.mock("@/app/approvals/actions", () => ({ getDocumentApprovalAction: vi.fn() }));

const projectAction = vi.mocked(getProjectAction);
const overviewAction = vi.mocked(getProjectOverviewDataAction);
// getProjectAction returns the viewer's display permissions together with the project (one round trip).
let viewer = { canApprove: true, newquip: true };
const withProject = (data: ReturnType<typeof baseView>) => projectAction.mockImplementation((async () => ({ ok: true, data, viewer })) as never);
const baseView = () => view({ project: project({ id: "p-base", project_reference: "PRJ-T-0001", original_contract_cents: 100_000 }), stages: [stage("s1", 1, "Deposit", 100_000)] });
const variationView = () => view({ project: project({ id: "p-var", project_reference: "PRJ-T-0001-V001", original_contract_cents: 50_000, billing_scope: "VARIATION", parent_project_id: "p-base", variation_id: "v1" }), stages: [stage("v1", 1, "Variation", 50_000)] });
const demoData = () => { const i = demoInput(); return { ok: true as const, data: { scopes: i.scopes, unbilledApprovedVariations: [], deliveries: i.deliveries, estimates: null, viewer: i.viewer } }; };

beforeEach(() => {
  vi.clearAllMocks();
  viewer = { canApprove: true, newquip: true };
  overviewAction.mockResolvedValue(demoData());
});
afterEach(() => cleanup());

describe("ProjectWorkspace integration of the executive overview", () => {
  it("renders on a base NewQuip project's Overview tab", async () => {
    withProject(baseView());
    render(<ProjectWorkspace id="p-base" />);
    expect(await screen.findByTestId("overview")).toBeTruthy();
    expect(overviewAction).toHaveBeenCalledWith("p-base");
  });

  it("an admin opening a VARIATION billing-scope page sees NO overview and NO error banner (the overview is for the original project)", async () => {
    withProject(variationView());
    // what the real action says for a variation scope
    overviewAction.mockResolvedValue({ ok: false, error: "Load the BASE project; this is a variation billing project." });
    render(<ProjectWorkspace id="p-var" />);
    expect(await screen.findByText(/internal billing scope of a variation/)).toBeTruthy(); // the workspace itself rendered
    expect(screen.queryByTestId("overview")).toBeNull();
    expect(screen.queryByTestId("overview-error")).toBeNull();
    expect(screen.queryByText(/Load the BASE project/)).toBeNull();
    expect(overviewAction).not.toHaveBeenCalled();
  });

  it("is shown ONLY on the Overview tab: leaving it removes it and does not refetch; returning shows it again", async () => {
    withProject(baseView());
    render(<ProjectWorkspace id="p-base" />);
    await screen.findByTestId("overview");
    const calls = overviewAction.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /^Stages/ }));
    expect(screen.queryByTestId("overview")).toBeNull();
    expect(overviewAction).toHaveBeenCalledTimes(calls);
    fireEvent.click(screen.getByRole("button", { name: /^Overview/ }));
    expect(await screen.findByTestId("overview")).toBeTruthy();
  });

  it("not shown for a non-NewQuip organisation", async () => {
    viewer = { canApprove: true, newquip: false };
    withProject(baseView());
    render(<ProjectWorkspace id="p-base" />);
    expect((await screen.findAllByText(/Revised contract value/)).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("overview")).toBeNull();
    expect(overviewAction).not.toHaveBeenCalled();
  });

  it("the summary groups the contract and billing figures, each label beside ITS OWN amount, and states earned / completion", async () => {
    const v = baseView();
    // distinct, recognisable values so that swapping any two labels is detectable
    v.commercial = { ...v.commercial, originalContractCents: 1_111_100, approvedVariationsCents: 2_222_200, revisedContractCents: 3_333_300, committedCents: 4_444_400, claimableCents: 5_555_500, remainingCents: 6_666_600, earnedCents: 7_777_700, approvedCompletionBps: 4321 };
    withProject(v);
    render(<ProjectWorkspace id="p-base" />);
    const hero = await screen.findByRole("region", { name: "Project and financial summary" });
    const amountOf = (scope: HTMLElement, label: string) => within(scope).getByText(label).nextElementSibling!.textContent;
    const contract = within(hero).getByRole("heading", { name: "Contract (ex VAT)" }).parentElement!;
    const billing = within(hero).getByRole("heading", { name: "Billing on this project's own claims (ex VAT)" }).parentElement!;
    expect(amountOf(contract, "Original contract")).toBe(formatCents(1_111_100));
    expect(amountOf(contract, "Approved variations")).toBe(formatCents(2_222_200));
    expect(amountOf(contract, "Revised contract value")).toBe(formatCents(3_333_300));
    expect(amountOf(billing, "Invoiced / committed")).toBe(formatCents(4_444_400));
    expect(amountOf(billing, "Claimable now")).toBe(formatCents(5_555_500));
    expect(amountOf(billing, "Remaining to bill / commit")).toBe(formatCents(6_666_600));
    expect(within(billing).getByText("Contract value − invoiced / committed (not − earned)")).toBeTruthy();
    expect(within(hero).getByText(/Approved completion 43\.21%/).textContent).toContain(`Earned to date ${formatCents(7_777_700)}`);
  });

  it("the hero figure groups are one column on a phone and three from the sm breakpoint (values never overlap at 390px)", async () => {
    withProject(baseView());
    render(<ProjectWorkspace id="p-base" />);
    const hero = await screen.findByRole("region", { name: "Project and financial summary" });
    for (const h of ["Contract (ex VAT)", "Billing on this project's own claims (ex VAT)"]) {
      const dl = within(hero).getByRole("heading", { name: h }).parentElement!.querySelector("dl")!;
      expect(dl.className).toContain("grid-cols-1");
      expect(dl.className).toContain("sm:grid-cols-3");
      expect(dl.className).not.toMatch(/(^|\s)grid-cols-3/);
    }
  });

  // D4 F-11: the contract figures are stated ONCE on the Overview. The hero owns Original / Approved variations / Revised; the executive summary owns cost, margin and billing across
  // the original project and its variations, and says so in words.
  const distinct = () => { const v = baseView(); v.commercial = { ...v.commercial, originalContractCents: 1_111_100, approvedVariationsCents: 2_222_200, revisedContractCents: 3_333_300, committedCents: 4_444_400, claimableCents: 5_555_500, remainingCents: 6_666_600, earnedCents: 7_777_700, approvedCompletionBps: 4321 }; return v; };
  const occurrences = (root: HTMLElement, text: string) => (root.textContent!.match(new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;

  it("D4 F-11: each hero billing amount appears once (the bar's key no longer repeats them)", async () => {
    withProject(distinct());
    render(<ProjectWorkspace id="p-base" />);
    const hero = await screen.findByRole("region", { name: "Project and financial summary" });
    for (const cents of [1_111_100, 2_222_200, 3_333_300, 4_444_400, 5_555_500, 6_666_600]) expect(occurrences(hero, formatCents(cents))).toBe(1);
    expect(occurrences(hero, formatCents(7_777_700))).toBe(1); // earned, in the one-line footnote
    expect(hero.textContent).not.toMatch(/Claimable = earned/); // the definitions are not recited a second time beside the figures
  });

  it("D4 F-11: on the Overview the contract labels exist once, the summary shows cost/margin and billing only, and its billing scope is stated in words", async () => {
    withProject(distinct());
    const { container } = render(<ProjectWorkspace id="p-base" />);
    await screen.findByTestId("overview");
    const dts = (label: string) => Array.from(container.querySelectorAll("dt")).filter((d) => d.textContent!.trim() === label).length;
    expect(dts("Original contract")).toBe(1);
    expect(dts("Approved variations")).toBe(1);
    expect(dts("Revised contract value")).toBe(1);
    for (const id of ["original", "variations", "revised"]) expect(screen.queryByTestId(`kpi-${id}`)).toBeNull();
    for (const id of ["billed", "remaining", "outstanding"]) expect(screen.getByTestId(`kpi-${id}`)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Billing: original contract and variations" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Billing on this project's own claims (ex VAT)" })).toBeTruthy(); // the two scopes are told apart in their titles
    expect(screen.getByText(/in the project summary above/)).toBeTruthy();
    expect(screen.getByTestId("kpi-cost")).toBeTruthy(); // admin: cost and margin still shown (gating unchanged)
  });

  it("D4 F-11: a viewer who cannot see cost still gets the contract and billing figures once, and no cost or margin", async () => {
    const i = demoInput();
    overviewAction.mockResolvedValue({ ok: true, data: { scopes: i.scopes, unbilledApprovedVariations: [], deliveries: i.deliveries, estimates: null, viewer: { isAdmin: false } } });
    viewer = { canApprove: false, newquip: true };
    withProject(distinct());
    render(<ProjectWorkspace id="p-base" />);
    await screen.findByTestId("overview");
    expect(screen.queryByTestId("kpi-cost")).toBeNull();
    expect(screen.queryByTestId("kpi-gp")).toBeNull();
    expect(screen.getByTestId("kpi-billed")).toBeTruthy();
    expect(screen.getByTestId("cost-hidden")).toBeTruthy();
  });
});
