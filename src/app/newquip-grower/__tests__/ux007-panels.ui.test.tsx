// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// UX-007 at the panel level: the send / generate / retry actions name their operation, only the clicked control spins, a double click cannot send twice,
// a thrown (lost) response is reported as unconfirmed with the history re-read, and success wording matches what actually happened.
const send = vi.fn(); const issue = vi.fn(); const delivery = vi.fn(); const docs = vi.fn();
vi.mock("../delivery-actions", () => ({ getQuoteDeliveryAction: (...a: unknown[]) => delivery(...a), sendQuoteToCustomerAction: (...a: unknown[]) => send(...a), retryQuoteSendAction: vi.fn() }));
vi.mock("../document-actions", () => ({ getQuoteDocumentsAction: (...a: unknown[]) => docs(...a), issueQuoteDocumentAction: (...a: unknown[]) => issue(...a) }));
import { DeliveryPanel } from "../[id]/DeliveryPanel";

const view = { available: true, canSend: true, requiresAcceptance: false, accepted: false, status: "APPROVED", statusLabel: "Approved", latestDocumentId: "d1", links: { state: "NONE" }, policy: { production: false, restricted: false, allowlist: [] }, contactEmails: [], defaultTo: "rep@sparkconsulting.co.za", sends: [], responses: [], responseContacts: [], deliveryContact: null, portal: false };
const documents = { available: true, canIssue: true, blockers: [], documents: [{ id: "d1", revision: 1, version: 1, issuedAt: "2026-11-05T08:00:00Z", issuedBy: "rep", byteSize: 2048, contentHash: "abcdef0123456789" }] };
const render_ = () => render(createElement(DeliveryPanel, { quoteId: "q1", contractCents: 100000000, onGate: vi.fn(), section: "quotation" } as never));
const sendButton = () => screen.getByRole("button", { name: /Send quotation to customer/ });

beforeEach(() => { send.mockReset(); issue.mockReset(); delivery.mockReset().mockResolvedValue({ ok: true, data: view }); docs.mockReset().mockResolvedValue({ ok: true, data: documents }); });
afterEach(cleanup);

describe("Customer quotation panel feedback", () => {
  it("shows the page-load state with a descriptive label, not a bare Loading…", async () => {
    delivery.mockReturnValue(new Promise(() => {}));
    render_();
    expect(await screen.findByText("Loading the quotation PDF and send history…")).toBeTruthy();
  });

  it("Sending customer email…: names the operation, spins only the send button, and a double click sends once", async () => {
    let done: (v: unknown) => void = () => {};
    send.mockImplementation(() => new Promise((r) => { done = r; }));
    render_();
    await screen.findByRole("button", { name: /Send quotation to customer/ });
    fireEvent.click(screen.getByLabelText(/I have opened and reviewed the PDF/));
    await act(async () => { fireEvent.click(sendButton()); fireEvent.click(sendButton()); });
    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Sending customer email…")).toBeTruthy();
    expect(sendButton().getAttribute("aria-busy")).toBe("true");
    const other = screen.getByRole("button", { name: /Generate customer quotation PDF|Re-check/ });
    expect(other.getAttribute("aria-busy")).toBeNull(); // the unrelated control does not spin...
    expect((other as HTMLButtonElement).disabled).toBe(true); // ...but it waits, so two operations cannot overlap
    await act(async () => { done({ ok: true, data: { status: "ACCEPTED" } }); });
    expect(await screen.findByText(/Sent: the email provider accepted it \(this is not proof of inbox delivery\)/)).toBeTruthy();
    expect(screen.queryByText("Sending customer email…")).toBeNull();
  });

  it("Generating customer PDF…: labelled while waiting", async () => {
    let done: (v: unknown) => void = () => {};
    issue.mockImplementation(() => new Promise((r) => { done = r; }));
    render_();
    const recheck = await screen.findByRole("button", { name: /Re-check/ });
    await act(async () => { fireEvent.click(recheck); });
    expect(screen.getByText("Generating customer PDF…")).toBeTruthy();
    await act(async () => { done({ ok: true }); });
    await waitFor(() => expect(screen.queryByText("Generating customer PDF…")).toBeNull());
  });

  it("a lost response to the send is NOT shown as sent: it says the email may already have gone, and re-reads the history", async () => {
    send.mockRejectedValue(new Error("network"));
    render_();
    await screen.findByRole("button", { name: /Send quotation to customer/ });
    fireEvent.click(screen.getByLabelText(/I have opened and reviewed the PDF/));
    const before = delivery.mock.calls.length;
    await act(async () => { fireEvent.click(sendButton()); });
    expect(await screen.findByText(/could not confirm whether the email was sent/i)).toBeTruthy();
    expect(screen.queryByText(/Sent: the email provider accepted it/)).toBeNull();
    expect(delivery.mock.calls.length).toBeGreaterThan(before);
  });

  it("a refused send keeps the form (recipients stay) and the control is usable again", async () => {
    send.mockResolvedValue({ ok: false, error: "No recipient is allowed. Nothing was sent." });
    render_();
    await screen.findByRole("button", { name: /Send quotation to customer/ });
    fireEvent.click(screen.getByLabelText(/I have opened and reviewed the PDF/));
    await act(async () => { fireEvent.click(sendButton()); });
    expect(await screen.findByText(/Nothing was sent/)).toBeTruthy();
    expect((sendButton() as HTMLButtonElement).disabled).toBe(false);
  });
});
