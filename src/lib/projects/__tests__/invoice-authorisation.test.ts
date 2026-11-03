import { describe, expect, it } from "vitest";
import { claimCin7Status } from "../claim-cin7-status";
import { invoiceAuthorisation, postingsSignature, viewPostingsSignature, PAYMENT_TEXT, type VerifiedRef } from "../invoice-authorisation";
import { claimNextStep } from "../claim-next-step";
import type { VerifiedInvoice } from "../invoice-verification";

// UX-006g1. Synthetic fixtures shaped like the owner's project (4 recorded DRAFT + 1 recorded AUTHORISED; all really AUTHORISED); never keyed on real numbers.
const posted = (n: number, status: string | null, over: Record<string, unknown> = {}) => claimCin7Status({
  claim_id: `c${n}`, posting_state: "RECONCILED", cin7_invoice_number: `INV-${n}`, cin7_status: status, completed_at: "2026-11-01T07:50:00Z", reconciled_at: "2026-11-01T08:00:00Z", ...over,
} as never);
const vi_ = (n: number, recorded: string | null, current: string | null, outcome: VerifiedInvoice["outcome"]): VerifiedInvoice => ({ postingId: `p${n}`, claimId: `c${n}`, invoiceNumber: `INV-${n}`, recordedStatus: recorded, currentStatus: current, outcome });
const ref = (invoice: VerifiedInvoice | undefined): VerifiedRef => ({ verifiedAt: "2026-11-03T09:00:00Z", invoice });
const T_REC = "1 Nov 2026, 10:00 SAST"; // reconciled_at 08:00Z in SAST
const T_VER = "3 Nov 2026, 11:00 SAST";

describe("invoiceAuthorisation: concept B", () => {
  it("unverified recorded DRAFT: 'Not currently verified', timestamped, warning, never success", () => {
    const a = invoiceAuthorisation(posted(1, "DRAFT"));
    expect(a.state).toBe("NOT_VERIFIED");
    expect(a.text).toBe(`Not currently verified - last recorded: DRAFT at ${T_REC}`);
    expect(a.tone).toBe("warning");
    expect(a.chip).not.toMatch(/^Authorised/);
    expect(a.verifiedStatus).toBeNull();
    expect(a.recorded).toMatchObject({ status: "DRAFT", historical: false });
  });
  it("snapshot-only AUTHORISED reads as a record, not a verified status", () => {
    const a = invoiceAuthorisation(posted(5, "AUTHORISED"));
    expect(a.state).toBe("NOT_VERIFIED");
    expect(a.text).toBe(`Recorded: authorised at ${T_REC} (not verified)`);
    expect(a.tone).not.toBe("success");
    expect(a.chip).toBe("Authorised recorded (not verified)");
  });
  it("recorded-at falls back to completed_at when never reconciled", () => {
    const a = invoiceAuthorisation(posted(2, "DRAFT", { posting_state: "CREATED", reconciled_at: null }));
    expect(a.text).toBe("Not currently verified - last recorded: DRAFT at 1 Nov 2026, 09:50 SAST");
    expect(a.posting.text).toBe("Posted as INV-2 · not yet reconciled");
  });
  it("verified AUTHORISED (recorded DRAFT): verified shown prominently, the DRAFT marked historical", () => {
    const a = invoiceAuthorisation(posted(1, "DRAFT"), ref(vi_(1, "DRAFT", "AUTHORISED", "CHANGED")));
    expect(a).toMatchObject({ state: "VERIFIED", tone: "success", verifiedStatus: "AUTHORISED", text: `Authorised in Cin7 - verified ${T_VER}` });
    expect(a.recorded).toMatchObject({ historical: true });
    expect(a.recorded!.text).toBe(`Earlier record (superseded): draft at ${T_REC}`);
  });
  it("verified DRAFT: 'Draft in Cin7 - verified', info tone (not success); matching record is not repeated", () => {
    const a = invoiceAuthorisation(posted(1, "DRAFT"), ref(vi_(1, "DRAFT", "DRAFT", "SAME")));
    expect(a).toMatchObject({ state: "VERIFIED", tone: "info", text: `Draft in Cin7 - verified ${T_VER}`, recorded: null });
  });
  it("verified SAME authorised", () => {
    expect(invoiceAuthorisation(posted(5, "AUTHORISED"), ref(vi_(5, "AUTHORISED", "AUTHORISED", "SAME")))).toMatchObject({ state: "VERIFIED", tone: "success" });
  });
  it("failed read with no verification keeps the recorded evidence and claims no success", () => {
    const a = invoiceAuthorisation(posted(1, "DRAFT"), null, true);
    expect(a).toMatchObject({ state: "VERIFY_FAILED", tone: "warning", chip: "Could not verify" });
    expect(a.text).toBe(`Could not verify - Cin7 read failed; last recorded: DRAFT at ${T_REC}`);
    expect(a.recorded).toMatchObject({ status: "DRAFT" });
    expect(a.verifiedStatus).toBeNull();
  });
  it("a failed re-read keeps an older successful verification, flagged", () => {
    const a = invoiceAuthorisation(posted(1, "DRAFT"), ref(vi_(1, "DRAFT", "AUTHORISED", "CHANGED")), true);
    expect(a.state).toBe("VERIFIED");
    expect(a.readFailed).toBe(true);
  });
  it("stale / absent verification is NOT_VERIFIED", () => {
    expect(invoiceAuthorisation(posted(1, "DRAFT"), null).state).toBe("NOT_VERIFIED");
    expect(invoiceAuthorisation(posted(1, "DRAFT"), ref(undefined)).state).toBe("NOT_VERIFIED"); // the read did not list this posting
  });
  it.each([["NOT_IN_SALE", "Not found on the Sale", null], ["AMBIGUOUS", "More than one invoice with this number", null], ["IDENTITY_MISMATCH", "Different Cin7 invoice", "AUTHORISED"], ["STATUS_UNREADABLE", "Status not given", null]] as const)("%s keeps its wording and is never VERIFIED", (outcome, wording, cur) => {
    const a = invoiceAuthorisation(posted(1, "DRAFT"), ref(vi_(1, "DRAFT", cur, outcome)));
    expect(a.state).toBe(outcome);
    expect(a.text).toContain(wording);
    expect(a.tone).not.toBe("success");
    expect(a.verifiedStatus).toBeNull();
    expect(a.recorded!.historical).toBe(true);
  });
  it("a SAME/CHANGED entry without a current status is not trusted as verified", () => {
    expect(invoiceAuthorisation(posted(1, "DRAFT"), ref(vi_(1, "DRAFT", null, "CHANGED"))).state).toBe("NOT_VERIFIED");
  });
  it("mixed statuses are independent per invoice", () => {
    const sts = [posted(1, "DRAFT"), posted(5, "AUTHORISED")];
    const out = sts.map((s, i) => invoiceAuthorisation(s, ref(vi_(i ? 5 : 1, s.recordedStatus, i ? "AUTHORISED" : "DRAFT", i ? "SAME" : "SAME"))));
    expect(out.map((o) => o.tone)).toEqual(["info", "success"]);
  });
  it("no recorded status", () => {
    expect(invoiceAuthorisation(posted(1, null)).text).toBe("Not currently verified - no status recorded");
  });
});

describe("invoiceAuthorisation: concepts A and C", () => {
  it("A: Posted as INV-n · Reconciled <ts>; C: payment is never inferred", () => {
    const a = invoiceAuthorisation(posted(1, "AUTHORISED"), ref(vi_(1, "AUTHORISED", "AUTHORISED", "SAME")));
    expect(a.posting.text).toBe(`Posted as INV-1 · Reconciled ${T_REC}`);
    expect(a.payment).toBe("Payment: not known to Toolbox");
    expect(PAYMENT_TEXT).toBe(a.payment);
  });
  it("reconciliation without authorisation: reconciled and still not verified, no success", () => {
    const a = invoiceAuthorisation(posted(1, "DRAFT"));
    expect(a.posting.text).toMatch(/Reconciled/);
    expect(a.tone).not.toBe("success");
  });
  it("states without an invoice have no authorisation", () => {
    for (const [st, want] of [[null, "NOT_POSTED"], ["PENDING", "POSTING"], ["FAILED_UNCERTAIN", "UNCERTAIN"], ["FAILED_CONFIRMED_NO_WRITE", "FAILED"]] as const) {
      const rec = st ? claimCin7Status({ claim_id: "c", posting_state: st, cin7_invoice_number: null, cin7_status: null, reconciled_at: null }) : claimCin7Status(null);
      expect(rec.kind).toBe(want);
      expect(invoiceAuthorisation(rec, ref(undefined), true).state).toBe("NO_INVOICE");
    }
  });
});

describe("labels and next step never present the snapshot as current", () => {
  it("claimCin7Status labels the snapshot; kinds are unchanged", () => {
    expect(posted(1, "DRAFT")).toMatchObject({ kind: "DRAFT_CREATED", label: "Draft recorded", tone: "info", recordedStatus: "DRAFT", recordedAt: "2026-11-01T08:00:00Z" });
    expect(posted(5, "AUTHORISED")).toMatchObject({ kind: "AUTHORISED", label: "Authorised recorded (not verified)" });
    expect(posted(5, "AUTHORISED").tone).not.toBe("success");
  });
  it("next step does not assert Cin7 state unless verified", () => {
    expect(claimNextStep({ status: "APPROVED", cin7Kind: "DRAFT_CREATED" })).toBe("Recorded as draft - verify the invoice status in Cin7 (use Verify invoice statuses).");
    expect(claimNextStep({ status: "APPROVED", cin7Kind: "AUTHORISED" })).toMatch(/^Recorded as authorised - verify/);
    expect(claimNextStep({ status: "APPROVED", cin7Kind: "DRAFT_CREATED", invoiceAuth: { state: "VERIFIED", verifiedStatus: "AUTHORISED" } })).toMatch(/authorised in Cin7 \(verified\)/);
    expect(claimNextStep({ status: "APPROVED", cin7Kind: "DRAFT_CREATED", invoiceAuth: { state: "VERIFIED", verifiedStatus: "DRAFT" } })).toMatch(/Draft invoice in Cin7 \(verified\)/);
    expect(claimNextStep({ status: "APPROVED", cin7Kind: "DRAFT_CREATED", invoiceAuth: { state: "VERIFY_FAILED", verifiedStatus: null } })).toMatch(/Could not verify/);
    expect(claimNextStep({ status: "APPROVED", cin7Kind: "DRAFT_CREATED", invoiceAuth: { state: "NOT_IN_SALE", verifiedStatus: null } })).toMatch(/could not be confirmed/);
  });
});

describe("postings signature: panel rows and view claims agree", () => {
  // Realistic PostingRow-shaped data: odd status case/whitespace, null timestamps, and states with leftover invoice fields. The verification is stored under the PANEL's signature
  // and compared with the VIEW's, so any disagreement would wrongly hide a fresh verification right after a reconcile.
  const raw = (claim_id: string, posting_state: string, over: Record<string, unknown> = {}) => ({ claim_id, posting_state, cin7_invoice_number: null, cin7_status: null, completed_at: null, reconciled_at: null, ...over });
  const sets = [
    [raw("a", "RECONCILED", { cin7_invoice_number: "INV-1", cin7_status: " draft ", completed_at: "2026-11-01T07:50:00Z", reconciled_at: "2026-11-01T08:00:00Z" }), raw("b", "CREATED", { cin7_invoice_number: " INV-2 ", cin7_status: "Authorised", completed_at: "2026-11-01T09:00:00Z" }), raw("c", "PENDING"), raw("d", "FAILED_UNCERTAIN", { cin7_invoice_number: "INV-9" }), raw("e", "FAILED_CONFIRMED_NO_WRITE", { cin7_invoice_number: "INV-8", cin7_status: "DRAFT" })],
    [raw("a", "RECONCILED", { cin7_invoice_number: "INV-1", cin7_status: null, reconciled_at: "2026-11-01T08:00:00Z" })],
    [],
  ];
  it.each(sets.map((s, i) => [i, s] as const))("set %i: equal signatures from the same data, whatever the order", (_i, rows) => {
    const claims = [...rows].reverse().map((r) => ({ id: r.claim_id, cin7Status: claimCin7Status(r as never) }));
    expect(viewPostingsSignature(claims)).toBe(postingsSignature(rows as never));
  });
  it("and both change together on a reconcile", () => {
    const before = sets[0].map((r) => (r.claim_id === "b" ? { ...r, posting_state: "RECONCILED", reconciled_at: "2026-11-03T08:00:00Z" } : r));
    const claims = before.map((r) => ({ id: r.claim_id, cin7Status: claimCin7Status(r as never) }));
    expect(viewPostingsSignature(claims)).toBe(postingsSignature(before as never));
    expect(postingsSignature(before as never)).not.toBe(postingsSignature(sets[0] as never));
  });
});

describe("postings signature", () => {
  const rows = [
    { claim_id: "b", posting_state: "RECONCILED", cin7_status: "Draft", cin7_invoice_number: "INV-2", completed_at: "t1", reconciled_at: "t2" },
    { claim_id: "a", posting_state: "PENDING", cin7_status: null, cin7_invoice_number: null, completed_at: null, reconciled_at: null },
  ];
  it("is order independent, case/whitespace tolerant on status, and changes on a reconcile or a new invoice", () => {
    const s = postingsSignature(rows);
    expect(postingsSignature([...rows].reverse())).toBe(s);
    expect(postingsSignature([{ ...rows[0], cin7_status: " DRAFT " }, rows[1]])).toBe(s);
    expect(postingsSignature([{ ...rows[0], reconciled_at: "t3" }, rows[1]])).not.toBe(s);
    expect(postingsSignature([{ ...rows[0], cin7_status: "AUTHORISED" }, rows[1]])).not.toBe(s);
    expect(postingsSignature([...rows, { ...rows[0], claim_id: "c" }])).not.toBe(s);
  });
  it("the view-derived signature equals the posting-row signature for the same postings", () => {
    const claims = [
      { id: "b", cin7Status: claimCin7Status(rows[0]) },
      { id: "a", cin7Status: claimCin7Status(rows[1] as never) },
      { id: "z", cin7Status: claimCin7Status(null) }, // a claim with no posting is not part of it
    ];
    expect(viewPostingsSignature(claims)).toBe(postingsSignature(rows));
  });
});
