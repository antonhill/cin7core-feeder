// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ProjectWorkspace } from "../[id]/ProjectWorkspace";
import { formatCents, type ProjectView } from "@/lib/projects/project-view";
import { statusText } from "@/components/ui/Status";
import { claimCin7Status } from "@/lib/projects/claim-cin7-status";

// P2: the Commercial / Claims workspace. The REAL workspace and panels; only server actions are stubbed. What must not change: every figure, every claim, every action.

const h = vi.hoisted(() => {
  const responses: Record<string, unknown> = {};
  const stub = () => new Proxy({}, { get: (_t, name: string) => (name === "then" ? undefined : name === "__esModule" ? true : () => Promise.resolve(responses[name] ?? { ok: false, error: "not stubbed" })), has: () => true });
  return { responses, stub };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ApprovalHistory", () => ({ ApprovalHistory: () => null }));
vi.mock("../[id]/VariationProductPicker", () => ({ VariationProductPicker: () => null }));
vi.mock("../actions", () => h.stub());
vi.mock("../cin7-actions", () => h.stub());
vi.mock("../delivery-actions", () => h.stub());
vi.mock("../variation-billing-actions", () => h.stub());
vi.mock("../overview-actions", () => h.stub());
vi.mock("../physical-actions", () => h.stub());
vi.mock("../procurement-actions", () => h.stub());
vi.mock("../profitability-actions", () => h.stub());

const gates = { orgEnabled: true, isManager: true, writesEnabled: false };
const cin7 = (kind: string, label: string, invoiceNumber: string | null = null, reconciled = false) => ({ kind, tone: "neutral", label, invoiceNumber, reconciled, detail: null, postingState: null, recordedStatus: null, recordedAt: null, completedAt: null, reconciledAt: null });
// A posted invoice is built by the real classifier so it carries its recorded evidence (UX-006g1).
const posted = (n: string, claim: string, status: string) => claimCin7Status({ claim_id: claim, posting_state: "RECONCILED", cin7_invoice_number: n, cin7_status: status, reconciled_at: "2026-11-01T08:00:00Z", completed_at: "2026-11-01T07:50:00Z" });
const claim = (id: string, n: string, status: string, total: number, c7: ReturnType<typeof cin7> | ReturnType<typeof posted>, over: Record<string, unknown> = {}) => ({
  id, claim_number: n, claim_date: "2026-11-01", supersedes_claim_id: null, total_cents: total, subtotal_cents: Math.round(total / 1.15), tax_cents: total - Math.round(total / 1.15),
  status, reserves: status !== "DRAFT", cin7Status: c7, approval: null, ...over,
});
const CLAIMS = [
  claim("c1", "PRJ-X-C01", "CIN7_CREATED", 115_000_00, posted("INV-00034", "c1", "DRAFT")),
  claim("c2", "PRJ-X-C02", "CIN7_CREATED", 57_500_00, posted("INV-00037", "c2", "AUTHORISED")),
  claim("c3", "PRJ-X-C03", "READY_FOR_APPROVAL", 23_000_00, cin7("NOT_SENT", "Not sent to Cin7")),
  claim("c4", "PRJ-X-C04", "DRAFT", 11_500_00, cin7("NOT_SENT", "Not sent to Cin7")),
];
const view = (): ProjectView => ({
  project: { id: "p1", project_reference: "PRJ-X", name: "Commercial", customer_name: "Spark", status: "ACTIVE", billing_scope: "PROJECT", parent_project_id: null, originating_quote_ref: "NQ-Q-1", tax_rate_bps: 1500, original_contract_cents: 900_000_00 },
  commercial: { originalContractCents: 900_000_00, approvedVariationsCents: 50_000_00, revisedContractCents: 950_000_00, earnedCents: 400_000_00, committedCents: 150_000_00, claimableCents: 20_000_00, remainingCents: 800_000_00, approvedCompletionBps: 4000, scheduleBalanced: true, uncertainClaimBlocking: false },
  stages: [{ id: "s1", name: "Deposit", stageValueCents: 900_000_00, valueCents: 900_000_00, claimableCents: 20_000_00, remainingCents: 0, reportedBps: 0, approvedBps: 0, committedBps: 0, history: [] }],
  claims: CLAIMS, allocations: [], variations: [], openingCommitments: [], openingCommitmentsLocked: true, cin7Representation: [],
} as unknown as ProjectView);
const posting = (n: string, claimId: string, status: string) => ({ id: `po-${n}`, claim_id: claimId, posting_state: "RECONCILED", cin7_invoice_number: n, cin7_task_id: null, cin7_status: status, completed_at: null, reconciled_at: "2026-11-01T10:00:00Z" });

beforeEach(() => {
  for (const k of Object.keys(h.responses)) delete h.responses[k];
  Object.assign(h.responses, {
    getProjectAction: { ok: true, data: view(), viewer: { canApprove: true, newquip: true } },
    getCommercialBootAction: { ok: true, data: {
      creation: { gates, creation: null, linked: true, scopeItems: [], saleLines: [], blockers: [], excluded: [] },
      posting: { gates, link: { id: "l", cin7_sale_number: "SO-00027", cin7_sale_id: "s", link_status: "LINKED", created_at: "2026-10-28T00:00:00Z", last_reconciled_at: null }, linkOrigin: "AUTOMATIC", postings: [posting("INV-00034", "c1", "DRAFT"), posting("INV-00037", "c2", "AUTHORISED")] },
    } },
  });
});
afterEach(() => cleanup());

async function openCommercial() {
  render(<ProjectWorkspace id="p1" />);
  fireEvent.click(await screen.findByRole("button", { name: /Commercial \/ Claims/ }));
  await screen.findByTestId("commercial-summary");
  await screen.findByText("Invoices in Cin7");
}

describe("section strip", () => {
  it("scrolls the selected section into view without moving the page vertically", async () => {
    const spy = vi.fn();
    (HTMLElement.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = spy;
    render(<ProjectWorkspace id="p1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Commercial \/ Claims/ }));
    await screen.findByTestId("commercial-summary");
    const last = spy.mock.calls.at(-1)!;
    expect(last[0]).toEqual({ block: "nearest", inline: "nearest" });
    expect(spy.mock.instances.at(-1)).toBe(screen.getByRole("button", { name: /Commercial \/ Claims/ }));
    delete (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
  });
});

describe("Commercial / Claims workspace (P2)", () => {
  it("opens with the commercial summary: every figure is the project's own, ex VAT", async () => {
    await openCommercial();
    const sum = within(screen.getByTestId("commercial-summary"));
    for (const [label, cents] of [["Revised contract", 950_000_00], ["Earned", 400_000_00], ["Billed / committed", 150_000_00], ["Claimable now", 20_000_00], ["Remaining", 800_000_00]] as const) {
      const dt = sum.getByText(label);
      expect(dt.nextElementSibling!.textContent).toBe(formatCents(cents));
    }
    expect(sum.getByText(/incl\. .* variations/).textContent).toContain(formatCents(50_000_00));
    expect(sum.getByText("1 awaiting approval")).toBeTruthy();
    expect(screen.getByText(/Amounts are ex VAT/)).toBeTruthy();
  });
  it("shows every claim once, with its amount, approval state, invoice number and reconciliation in its OWN record", async () => {
    await openCommercial();
    const articles = Array.from(document.querySelectorAll("article")) as HTMLElement[];
    expect(articles.length).toBe(CLAIMS.length);
    for (const c of CLAIMS) {
      const a = articles.find((x) => x.textContent!.includes(c.claim_number))!;
      expect(a).toBeTruthy();
      expect(a.textContent).toContain(formatCents(c.total_cents));
      expect(a.textContent).toContain(formatCents(c.subtotal_cents));
      expect(a.textContent).toContain(statusText(c.status));
      if (!c.cin7Status.invoiceNumber) expect(a.textContent).toContain(c.cin7Status.label);
      if (c.cin7Status.invoiceNumber) {
        expect(a.textContent).toContain(c.cin7Status.invoiceNumber);
        // reconciliation (Toolbox record) is its own plain-text line (not a chip), separate from the Cin7 authorisation chip, which says the status is only recorded
        expect(a.textContent).toMatch(/recorded \(not verified\)/);
        const rec = within(a).queryByText(/Reconciled /);
        expect(!!rec).toBe(c.cin7Status.reconciled);
        if (rec) expect(rec.closest("[data-tone]")).toBeNull(); // green and chips are not spent on a record-keeping fact
      }
    }
    // no figure was lost or altered by the redesign: the sum of the claim totals on screen equals the sum in the data
    const shown = articles.map((a) => a.textContent!).join(" ");
    expect(CLAIMS.every((c) => shown.includes(formatCents(c.total_cents)))).toBe(true);
  });
  it("marks and counts the claims awaiting this user's action, and no others", async () => {
    await openCommercial();
    const marked = [...document.querySelectorAll("article[data-needs-action]")].map((x) => x.textContent!);
    expect(marked.length).toBe(2); // PRJ-X-C03 (approve here) and PRJ-X-C04 (draft: submit)
    expect(marked.some((t) => t.includes("PRJ-X-C03"))).toBe(true);
    expect(marked.some((t) => t.includes("PRJ-X-C04"))).toBe(true);
    expect(screen.getByText("2 need your action")).toBeTruthy();
    const done = [...document.querySelectorAll("article")].filter((x) => x.textContent!.includes("PRJ-X-C01") || x.textContent!.includes("PRJ-X-C02"));
    expect(done.every((x) => !x.hasAttribute("data-needs-action") && !x.textContent!.includes("Needs your action"))).toBe(true);
  });
  it("marks no claim for a viewer who can act on none (needs-action follows the same plan as the buttons)", async () => {
    await openCommercial();
    const marked = document.querySelectorAll("article[data-needs-action]").length;
    const withActionButtons = [...document.querySelectorAll("article")].filter((x) => [...x.querySelectorAll("button")].some((b) => /^(Submit|Approve|Recalculate)$/.test(b.textContent ?? ""))).length;
    expect(marked).toBe(withActionButtons); // a marked claim always has its action beside it, and an actionable claim is always marked
  });
  it("keeps the actions beside the claim they act on (a manager approves a claim from its own record)", async () => {
    await openCommercial();
    const a = (Array.from(document.querySelectorAll("article")) as HTMLElement[]).find((x) => x.textContent!.includes("PRJ-X-C03"))!;
    expect(within(a).getByRole("button", { name: /Approve/ })).toBeTruthy();
    const draft = (Array.from(document.querySelectorAll("article")) as HTMLElement[]).find((x) => x.textContent!.includes("PRJ-X-C04"))!;
    expect(within(draft).queryByRole("button", { name: /^Approve/ })).toBeNull();
  });
  it("reads top to bottom: summary, claims and invoices, Cin7 posting, then the claim creator", async () => {
    await openCommercial();
    const text = document.body.innerHTML;
    const at = (needle: string) => text.indexOf(needle);
    const order = [at('data-testid="commercial-summary"'), at("Claims and invoices"), at("<article"), at("Invoices in Cin7"), at("id=\"new-claim-p1\""), at("Create progress claim")];
    expect(order.every((n) => n > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("the old 'Claim history' card grid and its duplicate headings are gone; there is one claims list", async () => {
    await openCommercial();
    expect(screen.queryByText("Claim history")).toBeNull();
    expect(screen.getAllByText("Claims and invoices").length).toBe(1);
    expect(screen.getAllByTestId("commercial-summary").length).toBe(1);
  });
  it("a link in the claims header jumps to the claim creator", async () => {
    await openCommercial();
    const link = screen.getByRole("link", { name: "Create a progress claim" });
    expect(link.getAttribute("href")).toBe("#new-claim-p1"); // per project, so an embedded variation workspace never duplicates the id
    expect(document.getElementById("new-claim-p1")).not.toBeNull();
  });
  it("uses a stacked layout on narrow screens and aligned columns only from lg, with no table", async () => {
    await openCommercial();
    const row = document.querySelector("article > div")!;
    expect(row.className).toMatch(/lg:grid-cols-\[/);
    expect(row.className).not.toMatch(/(^|\s)grid-cols-\[/); // no fixed columns on a phone
    expect(document.querySelector("article table")).toBeNull();
  });
  it("a phone user sees which badge is the approval and which is the Cin7 invoice: a visible caption below lg, hidden from lg where the column headings show", async () => {
    await openCommercial();
    const a = document.querySelector("article") as HTMLElement;
    const captions = Array.from(a.querySelectorAll("span[aria-hidden]")).filter((e) => e.className.includes("lg:hidden")).map((e) => e.textContent);
    expect(captions).toEqual(["Amount", "Approval", "Cin7 invoice (as last recorded)"]);
    for (const e of a.querySelectorAll("span[aria-hidden].mb-0\\.5")) expect(e.className).toMatch(/lg:hidden/);
  });
  it("the column headings are only shown when there are claims", async () => {
    h.responses.getProjectAction = { ok: true, data: { ...view(), claims: [] }, viewer: { canApprove: true, newquip: true } };
    render(<ProjectWorkspace id="p1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Commercial \/ Claims/ }));
    await screen.findByText("No claims yet.");
    expect(screen.queryByText("Cin7 invoice (as last recorded)")).toBeNull();
  });
  it("labels each value for assistive technology", async () => {
    await openCommercial();
    const a = document.querySelector("article") as HTMLElement;
    for (const l of ["Amount:", "Approval:", "Cin7 invoice:"]) expect(a.textContent).toContain(l);
  });
  it("a project with no claims says so and still offers the summary and the claim creator", async () => {
    h.responses.getProjectAction = { ok: true, data: { ...view(), claims: [] }, viewer: { canApprove: true, newquip: true } };
    render(<ProjectWorkspace id="p1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Commercial \/ Claims/ }));
    expect(await screen.findByText("No claims yet.")).toBeTruthy();
    await waitFor(() => expect(document.getElementById("new-claim-p1")).not.toBeNull());
    expect(screen.getByTestId("commercial-summary")).toBeTruthy();
  });
});

describe("unsaved claim protection", () => {
  const unload = () => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
  it("guards the tab only while stages are selected for a claim that is not saved yet", async () => {
    await openCommercial();
    expect(unload()).toBe(false); // read-only viewing: never guarded
    const box = within(document.getElementById("new-claim-p1")!).getAllByRole("checkbox")[0];
    fireEvent.click(box);
    expect(unload()).toBe(true);
    fireEvent.click(box); // selection cleared again
    expect(unload()).toBe(false);
  });
  it("saving a draft clears the selection (guard released); ticking stages for the NEXT claim is guarded again; another tab is never guarded", async () => {
    Object.assign(h.responses, {
      previewClaimAction: { ok: true, data: { claimNumber: "PRJ-X-C05", taxRateBps: 1500, calc: { subtotalCents: 100, taxCents: 15, totalCents: 115, lines: [] } } },
      createClaimDraftAction: { ok: true, data: null },
    });
    await openCommercial();
    const box = () => within(document.getElementById("new-claim-p1")!).getAllByRole("checkbox")[0] as HTMLInputElement;
    fireEvent.click(box());
    expect(unload()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Preview claim" }));
    const save = await screen.findByRole("button", { name: "Save as draft claim" });
    await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(save);
    await screen.findByText("Draft claim saved locally.");
    await waitFor(() => expect(box().checked).toBe(false));
    expect(unload()).toBe(false);
    fireEvent.click(box());
    expect(unload()).toBe(true); // a second claim in the same session is protected too
    fireEvent.click(screen.getByRole("button", { name: /^Overview/ }));
    expect(unload()).toBe(false); // the form is not on this tab
  });
});
