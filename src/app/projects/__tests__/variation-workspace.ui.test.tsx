// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ProjectWorkspace } from "../[id]/ProjectWorkspace";
import { formatCents, type ProjectView } from "@/lib/projects/project-view";

// P3: the Variations tab. The REAL workspace and panels; only server actions are stubbed. Each variation is ONE record: approval and value, billing position, Cin7 Sale and
// invoices, reconciliation and the next action, with the schedule, products and history as secondary details.

const h = vi.hoisted(() => {
  const responses: Record<string, unknown> = {};
  const calls: Array<[string, unknown[]]> = [];
  const stub = () => new Proxy({}, { get: (_t, name: string) => (name === "then" ? undefined : name === "__esModule" ? true : (...a: unknown[]) => { calls.push([name, a]); const r = responses[name]; return Promise.resolve(typeof r === "function" ? (r as (...x: unknown[]) => unknown)(...a) : r ?? { ok: false, error: "not stubbed" }); }), has: () => true });
  return { responses, calls, stub };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ApprovalHistory", () => ({ ApprovalHistory: ({ docId }: { docId: string }) => <span data-testid={`history-${docId}`} /> }));
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
const billing = (billed: Record<string, string>, sales: Record<string, string | null> = {}, lookupFailed = false) => ({ ok: true, data: {
  consolidated: { scopes: [{ projectId: "p1", scope: "BASE", variationCode: null, contractCents: 900_000_00, earnedCents: 0, committedCents: 0, claimableCents: 0, remainingCents: 900_000_00 }, ...Object.entries(billed).map(([vid, pid]) => scope(pid, vid.toUpperCase()))], totals: { contractCents: 1, earnedCents: 1, committedCents: 1, claimableCents: 1, remainingCents: 1 }, unbilledApprovedVariations: [], closureBlockers: [] },
  schedules: Object.fromEntries(["v1", "v2", "v3"].map((k) => [k, [{ name: "Variation", bps: 10_000 }]])), billingProjectByVariation: billed, saleNumberByVariation: sales, saleLookupFailed: lookupFailed } });
const posting = { ok: true, data: { gates, link: { id: "l", cin7_sale_number: "SO-00028", cin7_sale_id: "s", link_status: "LINKED", created_at: "2026-11-01T00:00:00Z", last_reconciled_at: null }, linkOrigin: "AUTOMATIC", postings: [{ id: "po1", claim_id: "c1", posting_state: "RECONCILED", cin7_invoice_number: "INV-00038", cin7_task_id: null, cin7_status: "DRAFT", completed_at: null, reconciled_at: "2026-11-01T10:00:00Z" }] } };
const commercialBoot = { ok: true, data: { creation: { gates, creation: null, linked: true, scopeItems: [], saleLines: [], blockers: [], excluded: [] }, posting: posting.data } };

function setup(variations: unknown[], billed: Record<string, string>, viewer = { canApprove: true, newquip: true }, sales: Record<string, string | null> = {}, lookupFailed = false) {
  const vp = (id: string) => view([], { id, billing_scope: "VARIATION", parent_project_id: "p1", project_reference: `PRJ-X-${id}` });
  h.responses.getProjectAction = (id: string) => ({ ok: true, data: id === "p1" ? view(variations) : vp(id), viewer });
  h.responses.getVariationBillingAction = billing(billed, sales, lookupFailed);
  h.responses.getCommercialBootAction = commercialBoot;
  h.responses.getCin7PostingStatusAction = posting;
}
beforeEach(() => { for (const k of Object.keys(h.responses)) delete h.responses[k]; h.calls.length = 0; });
const called = (name: string) => h.calls.filter(([n]) => n === name);
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
    expect(rec.textContent).toContain("Approved");
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
    const secondary = within(rec).getByText("Billing schedule").closest("details") as HTMLDetailsElement;
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
  it("D4 F-09: a DRAFT or REJECTED variation's value is labelled Proposed, never Approved; an APPROVED one keeps Approved (same amount)", async () => {
    setup([variation("v1", "V001", "DRAFT"), variation("v2", "V002", "APPROVED"), variation("v3", "V003", "REJECTED")], { v2: "vp1" });
    await openVariations();
    const draft = await record("V001");
    expect(draft.textContent).toContain("Proposed value (ex VAT)");
    expect(draft.textContent).not.toContain("Approved value");
    expect(draft.textContent).toContain(money(500_000_00));
    const approved = await record("V002");
    expect(approved.textContent).toContain("Approved value (ex VAT)");
    expect(approved.textContent).not.toContain("Proposed value");
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

  // ---- review fixes: the approval path must not depend on the billing read ----
  it("when the billing read FAILS the variation records and their decision controls are still there, with the failure shown inline and a way to retry", async () => {
    setup([variation("v1", "V001", "DRAFT")], {});
    h.responses.getVariationBillingAction = { ok: false, error: "db down" };
    await openVariations();
    const rec = await record("V001");
    expect(await within(rec).findByRole("button", { name: /^Approve/ })).toBeTruthy();
    expect(within(rec).getByRole("button", { name: /Submit/ })).toBeTruthy();
    expect(within(rec).getByText(/billing figures for this variation could not be loaded \(db down\)/)).toBeTruthy();
    const before = called("getVariationBillingAction").length;
    fireEvent.click(within(rec).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(called("getVariationBillingAction").length).toBe(before + 1));
  });
  it("while the billing read is still loading the decision controls are already there", async () => {
    setup([variation("v1", "V001", "DRAFT")], {});
    h.responses.getVariationBillingAction = () => new Promise(() => undefined);
    await openVariations();
    const rec = await record("V001");
    expect(within(rec).getByRole("button", { name: /^Approve/ })).toBeTruthy();
    expect(within(rec).getByText("Loading the billing position…")).toBeTruthy();
  });
  it("the decision controls call the right actions with the right ids, and Reject / Re-price need their input first", async () => {
    setup([variation("v1", "V001", "DRAFT")], {});
    h.responses.approveVariationAction = { ok: true }; h.responses.submitVariationForApprovalAction = { ok: true }; h.responses.rejectVariationAction = { ok: true }; h.responses.repriceVariationAction = { ok: true };
    await openVariations();
    const rec = await record("V001");
    const reject = within(rec).getByRole("button", { name: /Reject/ }) as HTMLButtonElement;
    const reprice = within(rec).getByRole("button", { name: /Re-price/ }) as HTMLButtonElement;
    expect(reject.disabled).toBe(true); expect(reprice.disabled).toBe(true);
    fireEvent.change(within(rec).getByLabelText("Reject reason"), { target: { value: "too dear" } });
    fireEvent.change(within(rec).getByLabelText("Re-price (R)"), { target: { value: "450000" } });
    expect(reject.disabled).toBe(false); expect(reprice.disabled).toBe(false);
    fireEvent.click(reprice);
    await waitFor(() => expect(called("repriceVariationAction")[0]?.[1]).toEqual(["p1", "v1", "450000"]));
    // each action re-reads and re-renders the record while its buttons are disabled: take a fresh, ENABLED button for every step
    const enabled = (name: RegExp) => waitFor(() => { const r = screen.getByText(/^V001 – /).closest("[class*='p-6']") as HTMLElement; const b = within(r).getByRole("button", { name }) as HTMLButtonElement; expect(b.disabled).toBe(false); return b; });
    fireEvent.click(await enabled(/Submit/));
    await waitFor(() => expect(called("submitVariationForApprovalAction")[0]?.[1]).toEqual(["p1", "v1"]));
    fireEvent.click(await enabled(/^Approve/));
    await waitFor(() => expect(called("approveVariationAction")[0]?.[1]).toEqual(["p1", "v1"]));
    fireEvent.click(await enabled(/Reject/));
    await waitFor(() => expect(called("rejectVariationAction")[0]?.[1]).toEqual(["p1", "v1", "too dear"]));
  });
  it("hiding a billing workspace keeps it mounted (an action in flight in it is not lost) and showing it again reads nothing", async () => {
    setup([variation("v1", "V001", "APPROVED"), variation("v2", "V002", "APPROVED")], { v1: "vp1", v2: "vp2" });
    await openVariations();
    const rec2 = await record("V002");
    fireEvent.click(within(rec2).getByRole("button", { name: "Open billing workspace" }));
    await within(rec2).findByText("Invoices in Cin7");
    const reads = called("getProjectAction").length;
    fireEvent.click(within(rec2).getByRole("button", { name: "Hide billing workspace" }));
    const ws = document.getElementById("ws-v2") as HTMLElement;
    expect(ws.className).toMatch(/hidden/);
    expect(within(ws).getByText("Invoices in Cin7")).toBeTruthy(); // still mounted
    fireEvent.click(within(rec2).getByRole("button", { name: "Open billing workspace" }));
    expect(document.getElementById("ws-v2")!.className).not.toMatch(/hidden/);
    expect(called("getProjectAction").length).toBe(reads);
  });
  it("a legacy approved variation (no schedule) opens its schedule and says where to look", async () => {
    setup([variation("v1", "V001", "APPROVED")], {});
    h.responses.getVariationBillingAction = { ok: true, data: { ...billing({}).data, schedules: {}, billingProjectByVariation: {} } };
    await openVariations();
    const rec = await record("V001");
    expect(await within(rec).findByText(/approved before billing schedules existed/)).toBeTruthy();
    expect((within(rec).getByText("Billing schedule").closest("details") as HTMLDetailsElement).open).toBe(true);
  });
  it("with no variations the billing panel stays out of the way: no read, no duplicate message", async () => {
    setup([], {});
    await openVariations();
    expect(await screen.findByText("No variations yet.")).toBeTruthy();
    expect(screen.queryByText("No variations to bill.")).toBeNull();
    expect(called("getVariationBillingAction")).toEqual([]);
  });
  it("the billing position says whose figures they are, in words a person can see", async () => {
    setup([variation("v1", "V001", "APPROVED")], { v1: "vp1" });
    await openVariations();
    expect(await screen.findByText("Billing position of this variation only, ex VAT")).toBeTruthy();
  });
  it("a rejected variation keeps its approval history for audit", async () => {
    setup([variation("v1", "V001", "APPROVED"), variation("v2", "V002", "REJECTED")], {});
    await openVariations();
    const rej = await screen.findByLabelText("Rejected variations");
    expect(within(rej).getByTestId("history-v2")).toBeTruthy();
  });
  it("if a later refresh of the billing figures fails, the figures already shown say they may be out of date and can be retried", async () => {
    setup([variation("v1", "V001", "DRAFT")], {});
    let reads = 0;
    h.responses.getVariationBillingAction = () => (reads++ === 0 ? billing({}) : { ok: false, error: "db down" });
    h.responses.saveVariationScheduleAction = { ok: true };
    await openVariations();
    const rec = await record("V001");
    const details = (await within(rec).findByText("Billing schedule")).closest("details") as HTMLDetailsElement;
    details.open = true;
    expect(screen.queryByText(/could not be refreshed/)).toBeNull();
    fireEvent.click(within(rec).getByRole("button", { name: "Save schedule" })); // a successful change refetches the billing figures; that read fails
    expect(await screen.findByText(/could not be refreshed \(db down\)/)).toBeTruthy();
    expect(within(rec).queryByText("Loading the billing position…")).toBeNull(); // the record is still there
    expect(await within(rec).findByRole("button", { name: /^Approve/ })).toBeTruthy();
  });

  describe("D3-A: scope and Cin7 Sale identification", () => {
    it("shows the stored Cin7 Sale number on the variation record, with the Variation scope tag, without opening the workspace", async () => {
      setup([variation("v1", "V001", "APPROVED")], { v1: "vp1" }, undefined, { v1: "SO-00028" });
      await openVariations();
      const rec = await record("V001");
      await waitFor(() => expect(within(rec).getByText("SO-00028")).toBeTruthy());
      expect(within(rec).getByText("Variation").closest("[data-tone]")?.getAttribute("data-tone")).toBe("primary");
    });
    it("puts each variation's own number on its own record", async () => {
      setup([variation("v1", "V001", "APPROVED"), variation("v2", "V002", "APPROVED")], { v1: "vp1", v2: "vp2" }, undefined, { v1: "SO-00111", v2: "SO-00222" });
      await openVariations();
      const r1 = await record("V001"); const r2 = await record("V002");
      await waitFor(() => expect(r1.textContent).toContain("SO-00111"));
      await waitFor(() => expect(r2.textContent).toContain("SO-00222"));
      expect(r1.textContent).not.toContain("SO-00222");
      expect(r2.textContent).not.toContain("SO-00111");
    });
    it("says so plainly when billing started but no Sale is linked, and when billing has not started: no number is invented", async () => {
      setup([variation("v1", "V001", "APPROVED"), variation("v2", "V002", "APPROVED")], { v1: "vp1" });
      await openVariations();
      const r1 = await record("V001");
      await waitFor(() => expect(within(r1).getByText("not created yet")).toBeTruthy());
      const r2 = await record("V002");
      expect(within(r2).getByText("billing not started")).toBeTruthy();
      expect(within(r1).getByText("not created yet").parentElement!.textContent).not.toMatch(/SO-\d/);
    });
    it("a failed Sale lookup says the number is unavailable, never 'not created yet'", async () => {
      setup([variation("v1", "V001", "APPROVED")], { v1: "vp1" }, undefined, {}, true);
      await openVariations();
      const rec = await record("V001");
      await waitFor(() => expect(within(rec).getByText(/number unavailable/)).toBeTruthy());
      expect(within(rec).queryByText("not created yet")).toBeNull();
    });
    it("a link with no stored number says so, and does not claim there is no Sale", async () => {
      setup([variation("v1", "V001", "APPROVED")], { v1: "vp1" }, undefined, { v1: null });
      await openVariations();
      const rec = await record("V001");
      await waitFor(() => expect(within(rec).getByText("linked, number not recorded")).toBeTruthy());
      expect(within(rec).queryByText("not created yet")).toBeNull();
    });
    it("shows no Sale line for a variation that is not approved", async () => {
      setup([variation("v3", "V003", "DRAFT")], {});
      await openVariations();
      const rec = await record("V003");
      await waitFor(() => expect(rec.textContent).toContain("Counts for nothing"));
      expect(rec.textContent).not.toContain("Cin7 Sale:");
    });
  });
});
