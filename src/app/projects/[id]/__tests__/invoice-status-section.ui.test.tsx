// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InvoiceStatusSection } from "../InvoiceStatusSection";
import * as c7 from "../../cin7-actions";
import type { PostingRow } from "@/lib/projects/cin7-posting-store";
import type { ProjectView } from "@/lib/projects/project-view";

vi.mock("../../cin7-actions", () => ({ verifyInvoiceStatusesAction: vi.fn() }));

const view = { claims: [{ id: "cl-34", claim_number: "PRJ-X-C02" }, { id: "cl-37", claim_number: "PRJ-X-C05" }] } as unknown as ProjectView;
const posting = (n: string, claim: string, status: string, over: Partial<PostingRow> = {}) => ({ id: `po-${n}`, claim_id: claim, posting_state: "RECONCILED", cin7_invoice_number: n, cin7_task_id: null, cin7_status: status, ...over }) as unknown as PostingRow;
const POSTINGS = [posting("INV-00034", "cl-34", "DRAFT"), posting("INV-00037", "cl-37", "AUTHORISED")];
const result = (over: Record<string, unknown> = {}) => ({ ok: true, data: {
  verifiedAt: "2026-11-02T10:00:00.000Z", saleId: "s", saleNumber: "SO-00027",
  invoices: [
    { postingId: "po-INV-00034", claimId: "cl-34", invoiceNumber: "INV-00034", recordedStatus: "DRAFT", currentStatus: "AUTHORISED", outcome: "CHANGED" },
    { postingId: "po-INV-00037", claimId: "cl-37", invoiceNumber: "INV-00037", recordedStatus: "AUTHORISED", currentStatus: "AUTHORISED", outcome: "SAME" },
  ], unaccounted: [], unresolvedPostings: 0, ...over } });
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

beforeEach(() => { vi.mocked(c7.verifyInvoiceStatusesAction).mockResolvedValue(result() as never); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const mount = (over: { isManager?: boolean; postings?: PostingRow[] } = {}) => render(<InvoiceStatusSection view={view} postings={over.postings ?? POSTINGS} projectId="p1" isManager={over.isManager ?? true} />);

describe("Invoices in Cin7 (UAT-028)", () => {
  it("opening the page shows the RECORDED statuses, labelled as recorded, and reads nothing from Cin7", () => {
    mount();
    expect(screen.getByText("PRJ-X-C02")).toBeTruthy();
    expect(screen.getByText("Draft")).toBeTruthy();              // INV-00034 as recorded
    expect(screen.getAllByText("Authorised").length).toBe(1);    // INV-00037 as recorded
    expect(screen.getAllByText("Not verified").length).toBe(2);  // nothing claims to be current
    expect(screen.getByText(/It is not live/)).toBeTruthy();
    expect(c7.verifyInvoiceStatusesAction).not.toHaveBeenCalled();
    expect(screen.queryByTestId("verified-at")).toBeNull();
  });
  it("Verify shows progress, then the current Cin7 status beside the recorded one with a timestamp", async () => {
    const d = deferred<unknown>();
    vi.mocked(c7.verifyInvoiceStatusesAction).mockReturnValue(d.promise as never);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Verify invoice statuses" }));
    expect(await screen.findByText(/Reading the Sales Order from Cin7/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Verify invoice statuses/ }) as HTMLButtonElement).disabled).toBe(true);
    const vb = screen.getByRole("button", { name: /Verify invoice statuses/ });
    expect(document.getElementById(vb.getAttribute("aria-describedby")!)!.textContent).toMatch(/disabled while the Cin7 read is in progress/); // D4 F-12
    await act(async () => d.resolve(result()));
    const now34 = await screen.findByTestId("now-INV-00034");
    expect(now34.textContent).toContain("Authorised");
    expect(now34.textContent).toContain("Changed in Cin7");
    expect(screen.getByTestId("now-INV-00037").textContent).toContain("Matches");
    expect(screen.getByTestId("verified-at").textContent).toMatch(/SO-00027.*at /);
    expect(await screen.findByText(/1 invoice differs from what was recorded\./)).toBeTruthy();
    expect(screen.queryByText(/See the notices below/)).toBeNull();
    // the RECORDED column still says what it recorded: verification never rewrites it
    expect(screen.getByText("Draft")).toBeTruthy();
  });
  it("a double click reads Cin7 once", async () => {
    mount();
    const b = screen.getByRole("button", { name: "Verify invoice statuses" });
    act(() => { fireEvent.click(b); fireEvent.click(b); });
    await screen.findByTestId("verified-at");
    expect(c7.verifyInvoiceStatusesAction).toHaveBeenCalledTimes(1);
  });
  it("a failure is shown beside the button, nothing is shown as verified, and the recorded statuses stay", async () => {
    vi.mocked(c7.verifyInvoiceStatusesAction).mockResolvedValue({ ok: false, error: "Cin7 timed out" } as never);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Verify invoice statuses" }));
    expect(await screen.findByText(/Cin7 timed out/)).toBeTruthy();
    expect(screen.getAllByText("Not verified").length).toBe(2);
    expect(screen.queryByTestId("verified-at")).toBeNull();
    expect(screen.getByText("Draft")).toBeTruthy();
  });
  it("a thrown (lost) response is a failure too, never a result", async () => {
    vi.mocked(c7.verifyInvoiceStatusesAction).mockRejectedValue(new Error("Failed to fetch"));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Verify invoice statuses" }));
    await waitFor(() => expect(document.querySelector('[data-testid="action-feedback"][data-kind="error"]')).not.toBeNull());
    expect(screen.queryByTestId("verified-at")).toBeNull();
  });
  it("an invoice that is not on the Sale is shown plainly, with no current status", async () => {
    vi.mocked(c7.verifyInvoiceStatusesAction).mockResolvedValue(result({ invoices: [{ postingId: "po-INV-00034", claimId: "cl-34", invoiceNumber: "INV-00034", recordedStatus: "DRAFT", currentStatus: null, outcome: "NOT_IN_SALE" }] }) as never);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Verify invoice statuses" }));
    // the cell exists ("Not verified") before the result lands, so wait for the text itself, not for the element
    await waitFor(() => expect(screen.getByTestId("now-INV-00034").textContent).toContain("Not found on the Sale"));
    expect(screen.getByTestId("now-INV-00034").textContent).toContain("Not read");
  });
  it("invoices Toolbox did not create are listed for information", async () => {
    vi.mocked(c7.verifyInvoiceStatusesAction).mockResolvedValue(result({ unaccounted: [{ invoiceNumber: "INV-00099", status: "AUTHORISED" }] }) as never);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Verify invoice statuses" }));
    expect(await screen.findByText(/not matched to a recorded posting \(INV-00099\)/)).toBeTruthy();
    expect(screen.getByText(/raised by hand in Cin7/)).toBeTruthy();
    expect(screen.queryByText(/did not create/)).toBeNull(); // provenance is never claimed
  });
  it("when a posting is still unresolved, an unmatched invoice is NOT described as foreign: the owner is told to reconcile, not to post again", async () => {
    vi.mocked(c7.verifyInvoiceStatusesAction).mockResolvedValue(result({ unaccounted: [{ invoiceNumber: "INV-00099", status: "DRAFT" }], unresolvedPostings: 1 }) as never);
    mount({ postings: [...POSTINGS, posting("", "cl-34", "DRAFT", { posting_state: "FAILED_UNCERTAIN", cin7_invoice_number: null } as never)] });
    fireEvent.click(screen.getByRole("button", { name: "Verify invoice statuses" }));
    expect(await screen.findByText(/one of these may be its invoice: reconcile that claim, do not post it again/)).toBeTruthy();
    expect(screen.getByText(/See the notices below\./)).toBeTruthy(); // the success line never reads as an all-clear when there is a notice
    expect(screen.queryByText(/raised by hand/)).toBeNull();
  });
  it("an unresolved posting is flagged even before anything is verified, and the section shows with no checkable invoice at all", () => {
    mount({ postings: [posting("", "cl-34", "DRAFT", { posting_state: "PENDING", cin7_invoice_number: null } as never)] });
    expect(screen.getByText(/still unresolved \(pending or outcome uncertain\)/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Verify invoice statuses" })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
  it("a verification is no longer shown as current once the postings change (a reconcile, a new invoice)", async () => {
    const { rerender } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Verify invoice statuses" }));
    await screen.findByTestId("verified-at");
    rerender(<InvoiceStatusSection view={view} postings={[posting("INV-00034", "cl-34", "AUTHORISED"), POSTINGS[1]]} projectId="p1" isManager />);
    expect(screen.queryByTestId("verified-at")).toBeNull();
    expect(screen.getAllByText("Not verified").length).toBe(2);
    expect(screen.getByTestId("verified-stale").textContent).toMatch(/Verify again/);
  });
  it("two invoices with the same number are shown as such, not as 'not found'", async () => {
    vi.mocked(c7.verifyInvoiceStatusesAction).mockResolvedValue(result({ invoices: [{ postingId: "po-INV-00034", claimId: "cl-34", invoiceNumber: "INV-00034", recordedStatus: "DRAFT", currentStatus: null, outcome: "AMBIGUOUS" }] }) as never);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Verify invoice statuses" }));
    expect((await screen.findByTestId("now-INV-00034")).textContent).toContain("More than one invoice with this number");
  });
  it("the table headers are column headers", () => { mount(); expect(screen.getAllByRole("columnheader").length).toBe(4); });
  it("a non-manager sees the recorded statuses but no Verify action", () => {
    mount({ isManager: false });
    expect(screen.queryByRole("button", { name: /Verify invoice statuses/ })).toBeNull();
    expect(screen.getByText(/owner or admin can verify/)).toBeTruthy();
  });
  it("nothing is shown when no invoice has been posted", () => {
    const { container } = mount({ postings: [posting("INV-1", "cl-34", "DRAFT", { posting_state: "FAILED_CONFIRMED_NO_WRITE" } as never), posting("", "cl-34", "DRAFT", { cin7_invoice_number: null } as never)] });
    expect(container.textContent).toBe("");
  });
});
