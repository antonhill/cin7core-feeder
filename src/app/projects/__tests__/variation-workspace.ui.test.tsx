// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ProjectWorkspace } from "../[id]/ProjectWorkspace";
import { formatCents, type ProjectView } from "@/lib/projects/project-view";

// P3: the Variations tab. The REAL workspace and panels; only server actions are stubbed. Each variation is ONE record: approval and value, billing position, Cin7 Sale and
// invoices, reconciliation and the next action, with the schedule, products and history as secondary details.

const h = vi.hoisted(() => {
  const responses: Record<string, unknown> = {};
  const stub = () => new Proxy({}, { get: (_t, name: string) => (name === "then" ? undefined : name === "__esModule" ? true : (...a: unknown[]) => { const r = responses[name]; return Promise.resolve(typeof r === "function" ? (r as (...x: unknown[]) => unknown)(...a) : r ?? { ok: false, error: "not stubbed" }); }), has: () => true });
  return { responses, stub };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ApprovalHistory", () => ({ ApprovalHistory: () => null }));
vi.mock("../[id]/VariationProductPicker", () => ({ VariationProductPicker: () => <div>product picker</div> }));
vi.mock("../actions", () => h.stub());
vi.mock("../cin7-actions", () => h.stub());
vi.mock("../delivery-actions", () => h.stub());
vi.mock("../variation-billing-actions", () => h.stub());
vi.mock("../overview-actions", () => h.stub());
vi.mock("../physical-actions", () => h.stub());
vi.mock("../procurement-actions", () => h.stub());
vi.mock("../profitability-actions", () => h.stub());

const gates = { orgEnabled: true, isManager: true, writesEnabled: false };
const project = (over: Record<string, unknown> = {}) => ({ id: "p1", project_reference: "PRJ-X", name: "Variations", customer_name: "Spark", status: "ACTIVE", billing_scope: "PROJECT", parent_project_id: null, originating_quote_ref: "NQ-Q-1", tax_rate_bps: 1500, original_contract_cents: 900_000_00, ...over });
const view = (variations: unknown[], over: Record<string, unknown> = {}): ProjectView => ({
  project: project(over),
  commercial: { originalContractCents: 900_000_00, approvedVariationsCents: 500_000_00, revisedContractCents: 1_400_000_00, earnedCents: 0, committedCents: 0, claimableCents: 0, remainingCents: 0, approvedCompletionBps: 0, scheduleBalanced: true, uncertainClaimBlocking: false },
  stages: [], claims: [], allocations: [], variations, openingCommitments: [], openingCommitmentsLocked: true, cin7Representation: [{ saleRef: "PLACEHOLDER-1", label: "Original", state: "NOT SENT", valueCents: 1 }],
} as unknown as ProjectView);
const variation = (id: string, code: string, status: string, over: Record<string, unknown> = {}) => ({ id, code, title: `${code} title`, description: `${code} scope`, status, amount_cents: 500_000_00, raised_by_email: "est@x.co.za", priced_by_email: null, decided_by_email: status === "DRAFT" ? null : "boss@x.co.za", decision_reason: status === "REJECTED" ? "too dear" : null, ...over });
const money = (n: number) => formatCents(n);
const scope = (projectId: string, code: string) => ({ projectId, scope: "VARIATION", variationCode: code, contractCents: 500_000_00, earnedCents: 100_000_00, committedCents: 500_000_00, claimableCents: 25_000_00, remainingCents: 375_000_00 });
const billing = (billed: Record<string, string>) => ({ ok: true, data: {
  consolidated: { scopes: [{ projectId: "p1", scope: "BASE", variationCode: null, contractCents: 900_000_00, earnedCents: 0, committedCents: 0, claimableCents: 0, remainingCents: 900_000_00 }, ...Object.entries(billed).map(([vid, pid]) => scope(pid, vid.toUpperCase()))], totals: { contractCents: 1, earnedCents: 1, committedCents: 1, claimableCents: 1, remainingCents: 1 }, unbilledApprovedVariations: [], closureBlockers: [] },
  schedules: Object.fromEntries(["v1", "v2", "v3"].map((k) => [k, [{ name: "Variation", bps: 10_000 }]])), billingProjectByVariation: billed } });
const posting = { ok: true, data: { gates, link: { id: "l", cin7_sale_number: "SO-00028", cin7_sale_id: "s", link_status: "LINKED", created_at: "2026-11-01T00:00:00Z", last_reconciled_at: null }, linkOrigin: "AUTOMATIC", postings: [{ id: "po1", claim_id: "c1", posting_state: "RECONCILED", cin7_invoice_number: "INV-00038", cin7_task_id: null, cin7_status: "DRAFT", completed_at: null, reconciled_at: "2026-11-01T10:00:00Z" }] } };
const commercialBoot = { ok: true, data: { creation: { gates, creation: null, linked: true, scopeItems: [], saleLines: [], blockers: [], excluded: [] }, posting: posting.data } };

function setup(variations: unknown[], billed: Record<string, string>, viewer = { canApprove: true, newquip: true }) {
  const vp = (id: string) => view([], { id, billing_scope: "VARIATION", parent_project_id: "p1", project_reference: `PRJ-X-${id}` });
  h.responses.getProjectAction = (id: string) => ({ ok: true, data: id === "p1" ? view(variations) : vp(id), viewer });
  h.responses.getVariationBillingAction = billing(billed);
  h.responses.getCommercialBootAction = commercialBoot;
  h.responses.getCin7PostingStatusAction = posting;
}
beforeEach(() => { for (const k of Object.keys(h.responses)) delete h.responses[k]; });
afterEach(() => cleanup());
async function openVariations() { render(<ProjectWorkspace id="p1" />); fireEvent.click(await screen.findByRole("button", { name: /^Variations/ })); }
const record = async (code: string) => (await screen.findByText(new RegExp(`^${code} – `))).closest("[class*='p-6']") as HTMLElement;

describe("Variation workspace (P3)", () => {
  it("a billed variation is ONE record: approval, value, billing position, Cin7 Sale and invoices - with nothing to expand to find the invoice", async () => {
    setup([variation("v1", "V001", "APPROVED")], { v1: "vp1" });
    await openVariations();
    const rec = await record("V001");
    expect(await within(rec).findByText("Invoices in Cin7")).toBeTruthy();         // the invoice list is already there
    expect(within(rec).getByText("INV-00038")).toBeTruthy();
    expect(rec.textContent).toContain("SO-00028");                                 // the linked Sale
    expect(rec.textContent).toContain("APPROVED");
    expect(rec.textContent).toContain(money(500_000_00));                          // approved value
    const pos = within(rec).getByLabelText("V001 billing position (ex VAT)");
    expect(pos.textContent).toContain(money(100_000_00));                          // earned
    expect(pos.textContent).toContain(money(25_000_00));                           // claimable
    expect(pos.textContent).toContain(money(375_000_00));                          // remaining
    // the invoice is not inside a closed <details>
    expect(within(rec).getByText("INV-00038").closest("details")).toBeNull();
  });
  it("the billing schedule, products and history are secondary: collapsed, and not where the invoice is", async () => {
    setup([variation("v1", "V001", "APPROVED")], { v1: "vp1" });
    await openVariations();
    const rec = await record("V001");
    const secondary = within(rec).getByText(/Billing schedule and history/).closest("details") as HTMLDetailsElement;
    expect(secondary.open).toBe(false);
    expect(secondary.textContent).toMatch(/Percentages are applied/);
  });
  it("a DRAFT variation shows its decision controls INSIDE its own record, and a member only sees that a manager must approve", async () => {
    setup([variation("v1", "V001", "DRAFT")], {});
    await openVariations();
    const rec = await record("V001");
    expect(await within(rec).findByRole("button", { name: /^Approve/ })).toBeTruthy();
    expect(within(rec).getByRole("button", { name: /Submit/ })).toBeTruthy();
    expect(rec.textContent).toContain("Counts for nothing until a manager approves it.");
    cleanup();
    setup([variation("v1", "V001", "DRAFT")], {}, { canApprove: false, newquip: true });
    await openVariations();
    const member = await record("V001");
    expect(await within(member).findByText("Manager approval required")).toBeTruthy();
    expect(within(member).queryByRole("button", { name: /^Approve/ })).toBeNull();
  });
  it("a decided variation says who decided and why, and a rejected one is listed apart", async () => {
    setup([variation("v1", "V001", "APPROVED"), variation("v2", "V002", "REJECTED")], {});
    await openVariations();
    expect((await screen.findAllByText(/boss@x\.co\.za · approved/)).length).toBeGreaterThan(0);
    const rej = screen.getByLabelText("Rejected variations");
    expect(rej.textContent).toContain("V002");
    expect(rej.textContent).toContain("too dear");
    expect(screen.queryByText(/^V002 – /)).toBeNull();
  });
  it("an approved variation whose billing has not started says so and offers Start variation billing where it can be seen", async () => {
    setup([variation("v1", "V001", "APPROVED")], {});
    await openVariations();
    const rec = await record("V001");
    expect(await within(rec).findByText("Billing has not started for this variation.")).toBeTruthy();
    expect(within(rec).getByRole("button", { name: "Start variation billing" }).closest("details")).toBeNull();
  });
  it("the first billed variation is open, a second opens on request; the contract position by scope appears ONCE", async () => {
    setup([variation("v1", "V001", "APPROVED"), variation("v2", "V002", "APPROVED")], { v1: "vp1", v2: "vp2" });
    await openVariations();
    await within(await record("V001")).findByText("Invoices in Cin7");
    expect(within(await record("V002")).queryByText("Invoices in Cin7")).toBeNull();
    const open = within(await record("V002")).getByRole("button", { name: "Open billing workspace" });
    expect(open.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(open);
    expect(await within(await record("V002")).findByText("Invoices in Cin7")).toBeTruthy();
    expect(screen.getAllByText("Consolidated billing (base + variations)").length).toBe(1);
  });
  it("the duplicated summaries are folded away: the consolidated report and the Cin7 planning placeholder are collapsed and honestly labelled", async () => {
    setup([variation("v1", "V001", "APPROVED")], { v1: "vp1" });
    await openVariations();
    await screen.findByText("Invoices in Cin7");
    const planning = screen.getByText(/Cin7 planning view \(placeholder references, nothing is sent\)/).closest("details") as HTMLDetailsElement;
    const report = screen.getByText(/Consolidated report: invoices by scope/).closest("details") as HTMLDetailsElement;
    expect(planning.open).toBe(false);
    expect(report.open).toBe(false);
    expect(screen.queryByText(/NOT SENT TO CIN7/)).toBeNull(); // the old shouting panel title is gone
  });
  it("Raise a variation is collapsed once variations exist and open when there are none", async () => {
    setup([variation("v1", "V001", "APPROVED")], { v1: "vp1" });
    await openVariations();
    await screen.findByText("Invoices in Cin7");
    expect((screen.getByText("Raise a variation").closest("details") as HTMLDetailsElement).open).toBe(false);
    cleanup();
    setup([], {});
    await openVariations();
    expect(await screen.findByText("No variations yet.")).toBeTruthy();
    expect((screen.getByText("Raise a variation").closest("details") as HTMLDetailsElement).open).toBe(true);
  });
  it("the contract summary shows the project's own figures", async () => {
    setup([variation("v1", "V001", "APPROVED")], { v1: "vp1" });
    await openVariations();
    const sum = within(screen.getByLabelText("Variations and the contract value (ex VAT)"));
    for (const [label, n] of [["Original contract value", 900_000_00], ["Approved variations", 500_000_00], ["Revised contract value", 1_400_000_00]] as const) expect(sum.getByText(label).nextElementSibling!.textContent).toBe(money(n));
  });
});
