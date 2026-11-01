// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ProjectWorkspace } from "../[id]/ProjectWorkspace";
import * as actions from "../actions";
import * as c7 from "../cin7-actions";
import { POST_CONFIRMATION_TEXT } from "@/lib/projects/cin7-posting";
import type { ProjectView } from "@/lib/projects/project-view";

// Review findings P1 / P2a on the REAL Project workspace with the REAL Cin7 Sale-creation and Cin7 posting panels (only unrelated panels are stubbed).
// A lost response to a Cin7 write must NEVER leave a live "do it again" control: a Sale / invoice may already exist. The panel re-reads its record,
// keeps the control blocked until that read succeeds, and shows what the read found.

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/ApprovalHistory", () => ({ ApprovalHistory: () => null }));
vi.mock("../actions", () => ({
  getProjectAction: vi.fn(), getViewerPermissionsAction: vi.fn(), approveClaimAction: vi.fn(), submitClaimForApprovalAction: vi.fn(), cancelDraftClaimAction: vi.fn(),
  createClaimDraftAction: vi.fn(), previewClaimAction: vi.fn(), recalculateStaleDraftAction: vi.fn(), recordProgressAction: vi.fn(),
}));
vi.mock("../cin7-actions", () => ({
  getCin7ReferenceOptionsAction: vi.fn(), createCin7SaleAction: vi.fn(), getPackageMappingAction: vi.fn(), getCin7SaleCreationStatusAction: vi.fn(),
  reconcileCin7SaleCreationAction: vi.fn(), resolveScopeItemAction: vi.fn(), runP0ChecklistAction: vi.fn(),
  getCin7PostingStatusAction: vi.fn(), recoverLinkCin7SaleAction: vi.fn(), getInvoiceProposalAction: vi.fn(), postClaimToCin7Action: vi.fn(), reconcileClaimPostingAction: vi.fn(),
}));
vi.mock("../[id]/VariationProductPicker", () => ({ VariationProductPicker: () => null }));
for (const n of ["OpeningCommitmentsPanel", "VariationsPanel", "DeliveryAllocationPanel", "PhysicalPanel", "ProcurementPanel", "ProfitabilityPanel"]) vi.doMock(`../[id]/${n}`, () => ({ [n]: () => null }));

const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const claim = (status: string) => ({
  id: "c1", claim_number: "PRJ-X-C01", claim_date: "2026-11-01", supersedes_claim_id: null, total_cents: 115_000, subtotal_cents: 100_000, tax_cents: 15_000, status, reserves: true,
  cin7: null, cin7Status: { kind: "NOT_SENT", tone: "neutral", label: "Not sent", invoiceNumber: null, reconciled: false, detail: null }, approval: null,
});
const view = (claims: unknown[]): ProjectView => ({
  project: { id: "p1", project_reference: "PRJ-X", name: "Uncertain", customer_name: "Spark", status: "ACTIVE", billing_scope: "PROJECT", parent_project_id: null, originating_quote_ref: "NQ-Q-1", tax_rate_bps: 1500, original_contract_cents: 100_000 },
  commercial: { originalContractCents: 100_000, approvedVariationsCents: 0, revisedContractCents: 100_000, earnedCents: 0, committedCents: 0, claimableCents: 0, remainingCents: 100_000, approvedCompletionBps: 0, scheduleBalanced: true, uncertainClaimBlocking: false },
  stages: [{ id: "s1", name: "Variation", stageValueCents: 100_000, valueCents: 100_000, claimableCents: 0, remainingCents: 0, reportedBps: 0, approvedBps: 0, committedBps: 0, history: [] }],
  claims, allocations: [], variations: [], openingCommitments: [], openingCommitmentsLocked: true, cin7Representation: [],
} as unknown as ProjectView);

const gates = { orgEnabled: true, isManager: true, writesEnabled: true };
const creationRow = (state = "CREATED") => ({ id: "cr1", creation_state: state, cin7_sale_number: "SO-00030", last_error_message: null, last_error_code: null });
const saleStatus = (creation: unknown = null) => ({ ok: true, data: { gates, creation, linked: false, scopeItems: [], saleLines: [], blockers: [], excluded: [] } });
const posting = (state: string) => ({ id: "po1", claim_id: "c1", posting_state: state, cin7_invoice_number: "INV-00040", cin7_status: "DRAFT", completed_at: null, last_error_message: null, last_error_code: null });
const postStatus = (postings: unknown[] = []) => ({ ok: true, data: { gates, link: { id: "l1", cin7_sale_number: "SO-00030", cin7_sale_id: "sale-1" }, linkOrigin: "AUTOMATIC", postings } });
const prepared = { ok: true, data: { claimNumber: "PRJ-X-C01", saleNumber: "SO-00030", scopeBlockers: [], preparedAt: "2026-11-01T10:00:00Z", proposal: { charges: [{ stageName: "Variation", amountCents: 100_000, taxCents: 15_000 }], totalCents: 115_000, lines: [], notes: [] } } };

async function openClaimsTab() {
  render(<ProjectWorkspace id="p1" />);
  fireEvent.click(await screen.findByRole("button", { name: /Commercial \/ Claims/ }));
}
const btn = (name: RegExp | string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const feedback = (kind: string) => document.querySelector(`[data-testid="action-feedback"][data-kind="${kind}"]`) as HTMLElement | null;

beforeEach(() => {
  vi.mocked(actions.getViewerPermissionsAction).mockResolvedValue({ ok: true, data: { canApprove: true, newquip: false } } as never);
  vi.mocked(c7.getCin7ReferenceOptionsAction).mockResolvedValue({ ok: false, error: "n/a" } as never);
  vi.mocked(c7.getCin7PostingStatusAction).mockResolvedValue({ ok: false, error: "n/a" } as never);
  vi.mocked(c7.getCin7SaleCreationStatusAction).mockResolvedValue({ ok: false, error: "n/a" } as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("P1: Cin7 Sale creation after a lost response", () => {
  beforeEach(() => {
    vi.mocked(actions.getProjectAction).mockResolvedValue({ ok: true, data: view([]) } as never);
    vi.mocked(c7.getCin7SaleCreationStatusAction).mockResolvedValue(saleStatus() as never);
  });
  async function readyToCreate() {
    await openClaimsTab();
    await screen.findByText("Create the Cin7 Sales Order");
    fireEvent.change(screen.getByLabelText("Cin7 location"), { target: { value: "MSTR" } });
    fireEvent.change(screen.getByLabelText("Revenue account code"), { target: { value: "200" } });
    fireEvent.click(screen.getByLabelText(/I confirm I want to create one Cin7 Sales Order/));
    await waitFor(() => expect(btn("Create Sales Order in Cin7").disabled).toBe(false));
  }

  it("Create is NOT clickable until the record has been re-read, and a second click never reaches the action", async () => {
    await readyToCreate();
    vi.mocked(c7.createCin7SaleAction).mockRejectedValue(new Error("Failed to fetch"));
    const reread = deferred<unknown>();
    vi.mocked(c7.getCin7SaleCreationStatusAction).mockReturnValue(reread.promise as never);
    fireEvent.click(btn("Create Sales Order in Cin7"));
    await waitFor(() => expect(c7.createCin7SaleAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(c7.getCin7SaleCreationStatusAction).toHaveBeenCalled()); // the re-read has started and is unresolved
    expect(btn("Create Sales Order in Cin7").disabled).toBe(true);
    expect(screen.getByText(/Create stays disabled until the record has been re-read/)).toBeTruthy();
    fireEvent.click(btn("Create Sales Order in Cin7")); // a blind retry
    expect(c7.createCin7SaleAction).toHaveBeenCalledTimes(1);
    await act(async () => reread.resolve(saleStatus(creationRow("CREATED"))));
  });

  it("when the re-read finds the creation record the panel shows it and offers Reconcile, not Create; no 'try again'", async () => {
    await readyToCreate();
    vi.mocked(c7.createCin7SaleAction).mockRejectedValue(new Error("Failed to fetch"));
    vi.mocked(c7.getCin7SaleCreationStatusAction).mockResolvedValue(saleStatus(creationRow("CREATED")) as never);
    fireEvent.click(btn("Create Sales Order in Cin7"));
    expect(await screen.findByText(/Cin7 SO-00030/)).toBeTruthy();
    expect(btn(/Reconcile with Cin7/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create Sales Order in Cin7" })).toBeNull();
    const ok = await waitFor(() => { const e = feedback("success"); expect(e).not.toBeNull(); return e!; });
    expect(ok.textContent).toMatch(/recorded/i);
    expect(ok.textContent).not.toMatch(/try again/i);
  });

  it("when the re-read FAILS, Create stays disabled, the confirmation is cleared, and nothing claims the page was refreshed", async () => {
    await readyToCreate();
    vi.mocked(c7.createCin7SaleAction).mockRejectedValue(new Error("Failed to fetch"));
    vi.mocked(c7.getCin7SaleCreationStatusAction).mockResolvedValue({ ok: false, error: "offline" } as never);
    fireEvent.click(btn("Create Sales Order in Cin7"));
    const alert = await waitFor(() => { const e = feedback("error"); expect(e).not.toBeNull(); return e!; });
    expect(alert.textContent).toMatch(/could not refresh the status/i);
    expect(alert.textContent).not.toMatch(/has been refreshed|try again/i);
    expect(btn("Create Sales Order in Cin7").disabled).toBe(true);
    expect((screen.getByLabelText(/I confirm I want to create one Cin7 Sales Order/) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/could not be re-read\. Reload the page/)).toBeTruthy();
    // The user cannot simply re-tick the confirmation and go again: with the state unknown, Create stays blocked.
    fireEvent.click(screen.getByLabelText(/I confirm I want to create one Cin7 Sales Order/));
    await act(async () => undefined);
    expect((screen.getByLabelText(/I confirm I want to create one Cin7 Sales Order/) as HTMLInputElement).checked).toBe(true);
    expect(btn("Create Sales Order in Cin7").disabled).toBe(true);
    fireEvent.click(btn("Create Sales Order in Cin7"));
    expect(c7.createCin7SaleAction).toHaveBeenCalledTimes(1);
  });

  it("when the re-read shows NO record, the message is evidence-based and never says to try again; a fresh confirmation is required", async () => {
    await readyToCreate();
    vi.mocked(c7.createCin7SaleAction).mockRejectedValue(new Error("Failed to fetch"));
    fireEvent.click(btn("Create Sales Order in Cin7")); // the re-read (default mock) returns "no creation"
    const alert = await waitFor(() => { const e = feedback("error"); expect(e).not.toBeNull(); return e!; });
    expect(alert.textContent).toMatch(/No record of this action was found/);
    expect(alert.textContent).toMatch(/Check Cin7/);
    expect(alert.textContent).not.toMatch(/try again/i);
    await waitFor(() => expect(btn("Create Sales Order in Cin7").disabled).toBe(true)); // un-ticked: needs a deliberate new confirmation
  });
});

describe("P2a: Cin7 posting after a lost response", () => {
  beforeEach(() => {
    vi.mocked(actions.getProjectAction).mockResolvedValue({ ok: true, data: view([claim("APPROVED")]) } as never);
    vi.mocked(c7.getCin7PostingStatusAction).mockResolvedValue(postStatus() as never);
    vi.mocked(c7.getInvoiceProposalAction).mockResolvedValue(prepared as never);
  });
  async function dialogOpen() {
    await openClaimsTab();
    fireEvent.click(await screen.findByRole("button", { name: /Prepare and post/ }));
    await screen.findByText(/Proposed invoice — review, then confirm/);
    await waitFor(() => expect(btn(POST_CONFIRMATION_TEXT).disabled).toBe(false));
  }
  const dialogUp = () => screen.queryByText(/Proposed invoice — review, then confirm/) !== null;

  it("Post is blocked ('checking the current Cin7 status') until the posting state was re-read; a second click never reaches the action", async () => {
    await dialogOpen();
    vi.mocked(c7.postClaimToCin7Action).mockRejectedValue(new Error("Failed to fetch"));
    const reread = deferred<unknown>();
    vi.mocked(c7.getCin7PostingStatusAction).mockReturnValue(reread.promise as never);
    fireEvent.click(btn(POST_CONFIRMATION_TEXT));
    await waitFor(() => expect(c7.postClaimToCin7Action).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(btn(POST_CONFIRMATION_TEXT).disabled).toBe(true));
    expect(screen.getByText(/Checking the current Cin7 status\. Posting stays disabled/)).toBeTruthy();
    fireEvent.click(btn(POST_CONFIRMATION_TEXT));
    expect(c7.postClaimToCin7Action).toHaveBeenCalledTimes(1);
    await act(async () => reread.resolve(postStatus([posting("PENDING")])));
  });

  it("if the re-read shows a posting exists, the dialog closes and the claim shows it (never 'recorded' for a pending / uncertain posting)", async () => {
    await dialogOpen();
    vi.mocked(c7.postClaimToCin7Action).mockRejectedValue(new Error("Failed to fetch"));
    vi.mocked(c7.getCin7PostingStatusAction).mockResolvedValue(postStatus([posting("FAILED_UNCERTAIN")]) as never);
    fireEvent.click(btn(POST_CONFIRMATION_TEXT));
    await waitFor(() => expect(dialogUp()).toBe(false));
    expect(await screen.findByText("OUTCOME UNCERTAIN")).toBeTruthy();
    const alert = await waitFor(() => { const e = feedback("error"); expect(e).not.toBeNull(); return e!; });
    expect(alert.textContent).toMatch(/latest status is shown on this page/i);
    expect(alert.textContent).not.toMatch(/try again|recorded/i);
  });

  it("a re-read showing the invoice was CREATED reports it as recorded", async () => {
    await dialogOpen();
    vi.mocked(c7.postClaimToCin7Action).mockRejectedValue(new Error("Failed to fetch"));
    vi.mocked(c7.getCin7PostingStatusAction).mockResolvedValue(postStatus([posting("CREATED")]) as never);
    fireEvent.click(btn(POST_CONFIRMATION_TEXT));
    const ok = await waitFor(() => { const e = feedback("success"); expect(e).not.toBeNull(); return e!; });
    expect(ok.textContent).toMatch(/invoice request was recorded/i);
    expect(dialogUp()).toBe(false);
  });

  it("if the re-read FAILS the dialog stays but Post stays blocked, with honest wording", async () => {
    await dialogOpen();
    vi.mocked(c7.postClaimToCin7Action).mockRejectedValue(new Error("Failed to fetch"));
    vi.mocked(c7.getCin7PostingStatusAction).mockResolvedValue({ ok: false, error: "offline" } as never);
    fireEvent.click(btn(POST_CONFIRMATION_TEXT));
    const alert = await waitFor(() => { const e = feedback("error"); expect(e).not.toBeNull(); return e!; });
    expect(alert.textContent).toMatch(/could not refresh the status/i);
    expect(alert.textContent).not.toMatch(/has been refreshed|try again/i);
    expect(dialogUp()).toBe(true);
    expect(btn(POST_CONFIRMATION_TEXT).disabled).toBe(true);
    expect(screen.getByText(/could not be re-read\. Reload the page/)).toBeTruthy();
  });

  it("if the re-read shows NO posting, the evidence-based Cin7 wording is used (no 'try again')", async () => {
    await dialogOpen();
    vi.mocked(c7.postClaimToCin7Action).mockRejectedValue(new Error("Failed to fetch"));
    fireEvent.click(btn(POST_CONFIRMATION_TEXT));
    const alert = await waitFor(() => { const e = feedback("error"); expect(e).not.toBeNull(); return e!; });
    expect(alert.textContent).toMatch(/No record of this action was found/);
    expect(alert.textContent).not.toMatch(/try again/i);
  });

  it("a normal refusal (server says no) leaves the dialog and its selections in place", async () => {
    await dialogOpen();
    vi.mocked(c7.postClaimToCin7Action).mockResolvedValue({ ok: false, error: "Cin7 writes are disabled." } as never);
    fireEvent.click(btn(POST_CONFIRMATION_TEXT));
    const alert = await waitFor(() => { const e = feedback("error"); expect(e).not.toBeNull(); return e!; });
    expect(alert.textContent).toMatch(/writes are disabled/);
    expect(dialogUp()).toBe(true);
    expect(within(document.body).getByRole("button", { name: POST_CONFIRMATION_TEXT })).toBeTruthy();
  });
});
