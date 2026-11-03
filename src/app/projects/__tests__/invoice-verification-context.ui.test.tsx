// @vitest-environment jsdom
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { InvoiceVerificationProvider, useInvoiceVerification, type InvoiceVerificationApi } from "../[id]/invoice-verification-context";
import { ReconCin7Cell } from "../[id]/ClaimInvoiceStatus";
import { claimCin7Status } from "@/lib/projects/claim-cin7-status";
import { viewPostingsSignature } from "@/lib/projects/invoice-authorisation";
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

describe("nested (embedded variation) provider publishes up to the base provider", () => {
  // base workspace: claim cb (own Sale); variation workspace: claim cv (another Sale). Synthetic, not the real data.
  const rv = (claimId: string, invoice: string, over: Partial<InvoiceVerification> = {}): InvoiceVerification => ({ verifiedAt: "2026-11-03T09:00:00Z", saleId: "s2", saleNumber: "SO-2", unaccounted: [], unresolvedPostings: 0,
    invoices: [{ postingId: `p-${claimId}`, claimId, invoiceNumber: invoice, recordedStatus: "DRAFT", currentStatus: "AUTHORISED", outcome: "CHANGED" }], ...over });
  const recV = claimCin7Status({ claim_id: "cv", posting_state: "RECONCILED", cin7_invoice_number: "INV-V", cin7_status: "DRAFT", completed_at: "2026-11-01T07:50:00Z", reconciled_at: "2026-11-01T08:00:00Z" });
  const baseBox: { api?: InvoiceVerificationApi } = {}; const kidBox: { api?: InvoiceVerificationApi } = {};
  function BaseProbe() { const a = useInvoiceVerification(); useEffect(() => { baseBox.api = a; }); return null; }
  function KidProbe() { const a = useInvoiceVerification(); useEffect(() => { kidBox.api = a; }); return null; }
  const sigOf = (c: typeof recV) => ({ cv: viewPostingsSignature([{ id: "cv", cin7Status: c }]) });
  const tree = (kidSig: string, showKid = true, shown = recV, kidSigs: Record<string, string> = sigOf(recV)) => (
    <InvoiceVerificationProvider signature="B" claimIds={["cb"]}>
      <BaseProbe />
      <ReconCin7Cell claimId="cv" cin7Status={shown} label={shown.label} tone="info" />
      {showKid && <InvoiceVerificationProvider signature={kidSig} claimIds={["cv"]} claimSigs={kidSigs}><KidProbe /></InvoiceVerificationProvider>}
    </InvoiceVerificationProvider>
  );
  it("verify inside the variation workspace is visible at base level (recon cell reads verified)", () => {
    const r = render(tree("V"));
    expect(r.container.textContent).toContain("Not currently verified");
    act(() => kidBox.api!.set(rv("cv", "INV-V"), "V"));
    expect(r.container.textContent).toContain("Authorised in Cin7 - verified 3 Nov 2026, 11:00 SAST");
    expect(baseBox.api!.verifiedFor("cv")?.invoice?.currentStatus).toBe("AUTHORISED");
    expect(baseBox.api!.verification).toBeNull(); // the base's own verification is untouched
  });
  it("the variation's failed read is attributed to its own claims only", () => {
    const r = render(tree("V"));
    act(() => kidBox.api!.fail("Cin7 timed out", "V"));
    expect(r.container.textContent).toContain("Could not verify");
    expect(baseBox.api!.errorFor("cb")).toBeNull();
  });
  it("stale: when the variation's postings change, or it unmounts, the base falls back to 'Not currently verified'", () => {
    const r = render(tree("V"));
    act(() => kidBox.api!.set(rv("cv", "INV-V"), "V"));
    r.rerender(tree("V2"));
    expect(r.container.textContent).toContain("Not currently verified");
    r.rerender(tree("V"));
    act(() => kidBox.api!.set(rv("cv", "INV-V"), "V"));
    expect(r.container.textContent).toContain("verified 3 Nov");
  });
  it("verified in the variation, then the workspace unmounts (tab left): the base still reads verified while that claim's posting is unchanged", () => {
    const r = render(tree("V"));
    act(() => kidBox.api!.set(rv("cv", "INV-V"), "V"));
    r.rerender(tree("V", false));
    expect(r.container.textContent).toContain("Authorised in Cin7 - verified 3 Nov 2026, 11:00 SAST");
    expect(baseBox.api!.verifiedFor("cv", sigOf(recV).cv)?.invoice?.currentStatus).toBe("AUTHORISED");
  });
  it("retained entry: ignored when the posting changed (reconcile), when the signature is unknown, or when none is given", () => {
    const r = render(tree("V"));
    act(() => kidBox.api!.set(rv("cv", "INV-V"), "V"));
    r.rerender(tree("V", false));
    const changed = claimCin7Status({ claim_id: "cv", posting_state: "RECONCILED", cin7_invoice_number: "INV-V", cin7_status: "DRAFT", completed_at: "2026-11-01T07:50:00Z", reconciled_at: "2026-11-03T08:00:00Z" });
    r.rerender(tree("V", false, changed));
    expect(r.container.textContent).toContain("Not currently verified");
    expect(baseBox.api!.verifiedFor("cv")).toBeNull(); // no expected signature: fail-safe
    expect(baseBox.api!.verifiedFor("cv", "")).toBeNull(); // unknown scope signature
  });
  it("a mounted child with no/unknown claim signature is not trusted at base level", () => {
    const r = render(tree("V", true, recV, {}));
    act(() => kidBox.api!.set(rv("cv", "INV-V"), "V"));
    expect(r.container.textContent).toContain("Not currently verified");
  });
  it("a newer verification from a re-opened variation workspace wins over the retained one", () => {
    const r = render(tree("V"));
    act(() => kidBox.api!.set(rv("cv", "INV-V"), "V"));
    r.rerender(tree("V", false));
    r.rerender(tree("V"));
    act(() => kidBox.api!.set(rv("cv", "INV-V", { verifiedAt: "2026-11-03T10:00:00Z" }), "V"));
    expect(r.container.textContent).toContain("verified 3 Nov 2026, 12:00 SAST");
  });
  it("a base verification never claims the variation's invoice (different Sale: absent / NOT_IN_SALE is not verified)", () => {
    const r = render(tree("V"));
    act(() => baseBox.api!.set(rv("cb", "INV-B"), "B")); // the base Sale lists only base postings
    expect(r.container.textContent).toContain("Not currently verified");
    act(() => baseBox.api!.set(rv("cb", "INV-B", { invoices: [{ postingId: "p", claimId: "cv", invoiceNumber: "INV-V", recordedStatus: "DRAFT", currentStatus: null, outcome: "NOT_IN_SALE" }] }), "B"));
    expect(r.container.textContent).toContain("Not found on the Sale");
    expect(r.container.textContent).not.toContain("Authorised in Cin7");
  });
  it("a verified entry in the variation wins over an unlisted base read, and a base listing does not hide it", () => {
    const r = render(tree("V"));
    act(() => { kidBox.api!.set(rv("cv", "INV-V"), "V"); baseBox.api!.set(rv("cb", "INV-B"), "B"); });
    expect(r.container.textContent).toContain("Authorised in Cin7 - verified");
  });
});
