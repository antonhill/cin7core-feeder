// @vitest-environment jsdom
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { InvoiceVerificationProvider, useInvoiceVerification, type InvoiceVerificationApi } from "../[id]/invoice-verification-context";
import { ReconCin7Cell } from "../[id]/ClaimInvoiceStatus";
import { claimCin7Status } from "@/lib/projects/claim-cin7-status";
import type { InvoiceVerification } from "@/lib/projects/invoice-verification";

// UX-006g1: the in-memory sharing of the manual Verify result.
const result: InvoiceVerification = { verifiedAt: "2026-11-03T09:00:00Z", saleId: "s", saleNumber: "SO-1", unaccounted: [], unresolvedPostings: 0,
  invoices: [{ postingId: "p1", claimId: "c1", invoiceNumber: "INV-1", recordedStatus: "DRAFT", currentStatus: "AUTHORISED", outcome: "CHANGED" }] };
const box: { api?: InvoiceVerificationApi } = {};
const api = new Proxy({} as InvoiceVerificationApi, { get: (_t, k) => (box.api as never)[k] });
function Probe() { const a = useInvoiceVerification(); useEffect(() => { box.api = a; }); return null; }
const mount = (sig: string) => render(<InvoiceVerificationProvider signature={sig}><Probe /></InvoiceVerificationProvider>);
afterEach(cleanup);

describe("InvoiceVerificationProvider", () => {
  it("starts empty: mounting reads nothing and verifies nothing", () => {
    mount("A");
    expect(api.verification).toBeNull();
    expect(api.stale).toBe(false);
    expect(api.error).toBeNull();
    expect(api.verifiedFor("c1")).toBeNull();
  });
  it("set exposes the verification per claim while the postings signature is unchanged", () => {
    mount("A");
    act(() => api.set(result, "A"));
    expect(api.verification).toBe(result);
    expect(api.verifiedFor("c1")).toEqual({ verifiedAt: result.verifiedAt, invoice: result.invoices[0] });
    expect(api.verifiedFor("other")).toEqual({ verifiedAt: result.verifiedAt, invoice: undefined });
  });
  it("is cleared (hidden as stale) when the postings signature changes, and a verification of the OLD postings is never applied to the new ones", () => {
    const r = mount("A");
    act(() => api.set(result, "A"));
    r.rerender(<InvoiceVerificationProvider signature="B"><Probe /></InvoiceVerificationProvider>);
    expect(api.verification).toBeNull();
    expect(api.stale).toBe(true);
    expect(api.verifiedFor("c1")).toBeNull();
    r.rerender(<InvoiceVerificationProvider signature="A"><Probe /></InvoiceVerificationProvider>);
    act(() => api.set(result, "A"));
    expect(api.verification).toBe(result);
  });
  it("a read that started against old postings (signature mismatch) is not shown", () => {
    mount("B");
    act(() => api.set(result, "A"));
    expect(api.verification).toBeNull();
    expect(api.stale).toBe(true);
  });
  it("fail records the error; a later success clears it; clear resets everything", () => {
    mount("A");
    act(() => api.fail("Cin7 timed out", "A"));
    expect(api.error).toBe("Cin7 timed out");
    act(() => api.set(result, "A"));
    expect(api.error).toBeNull();
    act(() => api.fail("again", "A"));
    expect(api.verification).toBe(result); // an older verification survives a failed re-read
    act(() => api.clear());
    expect(api.verification).toBeNull();
    expect(api.error).toBeNull();
  });
  it("without a provider nothing is verified and writes are no-ops", () => {
    render(<Probe />);
    expect(api.verification).toBeNull();
    expect(() => act(() => api.set(result, "A"))).not.toThrow();
    expect(api.verification).toBeNull();
  });
});

describe("Overview reconciliation cell", () => {
  const recorded = claimCin7Status({ claim_id: "c1", posting_state: "RECONCILED", cin7_invoice_number: "INV-1", cin7_status: "DRAFT", completed_at: "2026-11-01T07:50:00Z", reconciled_at: "2026-11-01T08:00:00Z" });
  const cell = <ReconCin7Cell claimId="c1" cin7Status={recorded} label={recorded.label} tone="info" />;
  it("shows the recorded snapshot as not verified, then the verified status with the record marked superseded", () => {
    const a = api;
    const r = render(<InvoiceVerificationProvider signature="A"><Probe />{cell}</InvoiceVerificationProvider>);
    expect(r.container.textContent).toContain("Not currently verified - last recorded: DRAFT");
    act(() => a.set(result, "A"));
    expect(r.container.textContent).toContain("Authorised in Cin7 - verified 3 Nov 2026, 11:00 SAST");
    expect(r.container.textContent).toContain("Earlier record (superseded)");
  });
});
