import { describe, expect, it } from "vitest";
import { claimCin7Status } from "../claim-cin7-status";
import { claimActionPlan } from "../claim-actions";

const row = (o: Partial<Parameters<typeof claimCin7Status>[0] & object>) => ({ claim_id: "c", posting_state: "RECONCILED", cin7_invoice_number: "INV-00032", cin7_status: "DRAFT", reconciled_at: "2026-11-01T08:00:00Z", ...o });

describe("claim Cin7 status (UAT-022: PRJ-NQ-Q-0016-C01 showed 'Not sent' despite INV-00032)", () => {
  it("the real posting for C01 (RECONCILED, INV-00032, DRAFT) reads as a reconciled draft invoice", () => {
    const s = claimCin7Status(row({}));
    expect(s).toMatchObject({ kind: "DRAFT_CREATED", label: "Draft invoice created", invoiceNumber: "INV-00032", reconciled: true });
  });
  it("only a claim with NO posting row is 'Not posted'", () => {
    expect(claimCin7Status(null).kind).toBe("NOT_POSTED");
    expect(claimCin7Status(undefined).kind).toBe("NOT_POSTED");
    for (const st of ["PENDING", "CREATED", "RECONCILED", "FAILED_CONFIRMED_NO_WRITE", "FAILED_UNCERTAIN", "SOMETHING_NEW"]) expect(claimCin7Status(row({ posting_state: st })).kind).not.toBe("NOT_POSTED");
  });
  it("distinguishes draft, authorised, failed, uncertain and in-progress", () => {
    expect(claimCin7Status(row({ cin7_status: "AUTHORISED" })).kind).toBe("AUTHORISED");
    expect(claimCin7Status(row({ posting_state: "CREATED", reconciled_at: null })).reconciled).toBe(false);
    expect(claimCin7Status(row({ posting_state: "FAILED_CONFIRMED_NO_WRITE", cin7_invoice_number: null })).kind).toBe("FAILED");
    expect(claimCin7Status(row({ posting_state: "FAILED_UNCERTAIN" })).kind).toBe("UNCERTAIN");
    expect(claimCin7Status(row({ posting_state: "PENDING", cin7_invoice_number: null })).kind).toBe("POSTING");
  });
  it("a failed-no-write posting never shows an invoice number", () => {
    expect(claimCin7Status(row({ posting_state: "FAILED_CONFIRMED_NO_WRITE", cin7_invoice_number: "INV-9" })).invoiceNumber).toBeNull();
  });
});

describe("claim action plan (UAT-016/017)", () => {
  const approval = { requestId: "r1", stageRole: "MANAGER" };
  it("a submitted claim offers no Recalculate and no Submit, to anyone", () => {
    for (const t of ["admin", "member", "none"] as const) {
      const p = claimActionPlan({ status: "READY_FOR_APPROVAL", approval }, t);
      expect(p.recalculate).toBe(false);
      expect(p.submit).toBe(false);
    }
  });
  it("a submitted claim links to Approvals and names the real stage, not 'owner/admin'", () => {
    const p = claimActionPlan({ status: "READY_FOR_APPROVAL", approval }, "member");
    expect(p.openInApprovals).toBe(true);
    expect(p.approveHere).toBe(false);
    expect(p.waitingText).toMatch(/manager/);
    expect(p.waitingText).not.toMatch(/owner\/admin/);
    expect(p.cancelLabel).toBe("Withdraw claim");
  });
  it("only the admin tier gets the direct Approve button; a read-only viewer gets no write action", () => {
    expect(claimActionPlan({ status: "READY_FOR_APPROVAL", approval }, "admin").approveHere).toBe(true);
    const none = claimActionPlan({ status: "READY_FOR_APPROVAL", approval }, "none");
    expect(none.cancel).toBe(false);
    expect(none.approveHere).toBe(false);
  });
  it("a draft offers Submit, Recalculate and Cancel; an approved claim offers nothing", () => {
    expect(claimActionPlan({ status: "DRAFT", approval: null }, "member")).toMatchObject({ submit: true, recalculate: true, cancel: true, openInApprovals: false });
    expect(claimActionPlan({ status: "APPROVED", approval: null }, "admin")).toMatchObject({ submit: false, recalculate: false, cancel: false, approveHere: false });
  });
  it("a submitted claim with no approval request says so rather than pointing at a missing link", () => {
    const p = claimActionPlan({ status: "READY_FOR_APPROVAL", approval: null }, "member");
    expect(p.openInApprovals).toBe(false);
    expect(p.waitingText).toMatch(/No approval request/);
  });
});
