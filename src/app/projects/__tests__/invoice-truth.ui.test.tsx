// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectWorkspace } from "../[id]/ProjectWorkspace";
import { claimCin7Status } from "@/lib/projects/claim-cin7-status";
import type { ProjectView } from "@/lib/projects/project-view";

// UX-006g1: the Claims card and posting panel must not present the RECORDED cin7_status snapshot as the current Cin7 status. The REAL workspace; only server actions are stubbed.
// Fixture shape (not the real data): five reconciled invoices, four recorded DRAFT and one recorded AUTHORISED, all actually AUTHORISED in Cin7; one cancelled claim with no posting.

const h = vi.hoisted(() => {
  const responses: Record<string, unknown> = {};
  const verify = vi.fn();
  const stub = () => new Proxy({}, { get: (_t, name: string) => (name === "then" ? undefined : name === "__esModule" ? true : name === "verifyInvoiceStatusesAction" ? verify : () => Promise.resolve(responses[name] ?? { ok: false, error: "not stubbed" })), has: () => true });
  return { responses, stub, verify };
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
const N = [34, 35, 36, 37, 38];
const rec = (n: number) => (n === 38 ? "AUTHORISED" : "DRAFT");
const rows = N.map((n) => ({ id: `po-${n}`, claim_id: `c${n}`, posting_state: "RECONCILED", cin7_invoice_number: `INV-000${n}`, cin7_task_id: null, cin7_status: rec(n), completed_at: "2026-11-01T07:50:00Z", reconciled_at: n === 38 ? "2026-11-01T19:00:00Z" : "2026-11-01T08:00:00Z" }));
const claim = (id: string, n: string, status: string, row: (typeof rows)[number] | null) => ({
  id, claim_number: n, claim_date: "2026-11-01", supersedes_claim_id: null, total_cents: 11_500_00, subtotal_cents: 10_000_00, tax_cents: 1_500_00, claim_seq: 1,
  status, reserves: status !== "CANCELLED_BEFORE_WRITE", cin7Status: claimCin7Status(row), approval: null,
});
const view = (): ProjectView => ({
  project: { id: "p1", project_reference: "PRJ-X", name: "Commercial", customer_name: "Spark", status: "ACTIVE", billing_scope: "PROJECT", parent_project_id: null, originating_quote_ref: "NQ-Q-1", tax_rate_bps: 1500, original_contract_cents: 50_000_00 },
  commercial: { originalContractCents: 50_000_00, approvedVariationsCents: 0, revisedContractCents: 50_000_00, earnedCents: 50_000_00, committedCents: 50_000_00, claimableCents: 0, remainingCents: 0, approvedCompletionBps: 10000, scheduleBalanced: true, uncertainClaimBlocking: false },
  stages: [{ id: "s1", name: "Deposit", stageValueCents: 50_000_00, valueCents: 50_000_00, claimableCents: 0, remainingCents: 0, reportedBps: 0, approvedBps: 0, committedBps: 0, history: [] }],
  claims: [...rows.map((r) => claim(r.claim_id, `PRJ-X-C${r.claim_id.slice(1)}`, "APPROVED", r)), claim("cx", "PRJ-X-CX", "CANCELLED_BEFORE_WRITE", null)],
  allocations: [], variations: [], openingCommitments: [], openingCommitmentsLocked: true, cin7Representation: [],
} as unknown as ProjectView);
const verification = (current: (n: number) => string = () => "AUTHORISED") => ({ ok: true, data: {
  verifiedAt: "2026-11-03T09:00:00.000Z", saleId: "s", saleNumber: "SO-00027",
  invoices: N.map((n) => ({ postingId: `po-${n}`, claimId: `c${n}`, invoiceNumber: `INV-000${n}`, recordedStatus: rec(n), currentStatus: current(n), outcome: current(n) === rec(n) ? "SAME" : "CHANGED" })),
  unaccounted: [], unresolvedPostings: 0 } });

beforeEach(() => {
  for (const k of Object.keys(h.responses)) delete h.responses[k];
  h.verify.mockReset();
  Object.assign(h.responses, {
    getProjectAction: { ok: true, data: view(), viewer: { canApprove: true, newquip: true } },
    getCommercialBootAction: { ok: true, data: {
      creation: { gates, creation: null, linked: true, scopeItems: [], saleLines: [], blockers: [], excluded: [] },
      posting: { gates, link: { id: "l", cin7_sale_number: "SO-00027", cin7_sale_id: "s", link_status: "LINKED", created_at: "2026-10-28T00:00:00Z", last_reconciled_at: null }, linkOrigin: "AUTOMATIC", postings: rows },
    } },
  });
});
afterEach(() => cleanup());

async function open() {
  render(<ProjectWorkspace id="p1" />);
  fireEvent.click(await screen.findByRole("button", { name: /Commercial \/ Claims/ }));
  await screen.findByTestId("commercial-summary");
  await screen.findByText("Invoices in Cin7");
}
const blocks = () => N.map((n) => Array.from(document.querySelectorAll(`[data-testid="invoice-auth-c${n}"]`)) as HTMLElement[]);

describe("invoice status truth on the Claims card and posting panel", () => {
  it("opening the project never reads Cin7, and before verification nothing reads as a current status", async () => {
    await open();
    expect(h.verify).not.toHaveBeenCalled();
    for (const [i, pair] of blocks().entries()) {
      expect(pair.length).toBe(2); // the Claims card and the posting panel
      for (const b of pair) {
        expect(b.getAttribute("data-auth-state")).toBe("NOT_VERIFIED");
        expect(b.querySelector("[data-tone='success']")).toBeNull(); // never 'Authorised' styling without a verification
        expect(b.textContent).not.toMatch(/in Cin7 - verified/);
        expect(b.textContent).toContain("Payment: not known to Toolbox");
        expect(b.textContent).toMatch(/Posted as INV-000\d+ · Reconciled \d+ Nov 2026/);
        expect(b.textContent).toMatch(i === 4 ? /Recorded: authorised at 1 Nov 2026, 21:00 SAST \(not verified\)/ : /Not currently verified - last recorded: DRAFT at 1 Nov 2026, 10:00 SAST/);
      }
    }
    const article = screen.getAllByText(/PRJ-X-C34/).map((e) => e.closest("article")).find(Boolean)!;
    expect(within(article).getByText(/Recorded as draft - verify the invoice status in Cin7/)).toBeTruthy();
    expect(article.textContent).not.toMatch(/Draft invoice created|Invoice authorised/);
  });

  it("after a verification returning AUTHORISED for all five, each reads 'Authorised in Cin7 - verified' and the older DRAFT is historical", async () => {
    h.verify.mockResolvedValue(verification());
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Verify invoice statuses" }));
    await waitFor(() => expect(blocks()[0][0].getAttribute("data-auth-state")).toBe("VERIFIED"));
    expect(h.verify).toHaveBeenCalledTimes(1);
    for (const [i, pair] of blocks().entries()) {
      for (const b of pair) {
        expect(b.getAttribute("data-auth-state")).toBe("VERIFIED");
        expect(b.querySelector("[data-part='authorisation']")!.textContent).toBe("Authorised in Cin7 - verified 3 Nov 2026, 11:00 SAST");
        const hist = b.querySelector("[data-part='recorded-historical']");
        if (i < 4) expect(hist!.textContent).toMatch(/^Earlier record \(superseded\): draft at /);
        else expect(hist).toBeNull(); // recorded AUTHORISED equals the verified status
      }
    }
    const article = screen.getAllByText(/PRJ-X-C34/).map((e) => e.closest("article")).find(Boolean)!;
    expect(within(article).getByText(/Invoice authorised in Cin7 \(verified\)/)).toBeTruthy();
  });

  it("a failed verification keeps the recorded evidence and claims no success", async () => {
    h.verify.mockResolvedValue({ ok: false, error: "Cin7 timed out" });
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Verify invoice statuses" }));
    await waitFor(() => expect(blocks()[0][0].getAttribute("data-auth-state")).toBe("VERIFY_FAILED"));
    for (const pair of blocks()) for (const b of pair) {
      expect(b.textContent).toMatch(/Could not verify - Cin7 read failed; last recorded: (DRAFT|AUTHORISED) at /);
      expect(b.querySelector("[data-tone='success']")).toBeNull();
    }
  });

  it("a thrown (lost) response is a failed read too", async () => {
    h.verify.mockRejectedValue(new Error("Failed to fetch"));
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Verify invoice statuses" }));
    await waitFor(() => expect(blocks()[0][0].getAttribute("data-auth-state")).toBe("VERIFY_FAILED"));
  });

  it("a partial result: verified where listed, a problem outcome where not found, unverified elsewhere", async () => {
    const v = verification() as { ok: boolean; data: { invoices: Array<Record<string, unknown>> } };
    v.data.invoices[0] = { ...v.data.invoices[0], currentStatus: null, outcome: "NOT_IN_SALE" };
    v.data.invoices.pop(); // INV-38 not listed by the read
    h.verify.mockResolvedValue(v);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Verify invoice statuses" }));
    await waitFor(() => expect(blocks()[0][0].getAttribute("data-auth-state")).toBe("NOT_IN_SALE"));
    expect(blocks()[0][0].textContent).toContain("Not found on the Sale");
    expect(blocks()[1][0].getAttribute("data-auth-state")).toBe("VERIFIED");
    expect(blocks()[4][0].getAttribute("data-auth-state")).toBe("NOT_VERIFIED");
  });
});

describe("InvoiceStatusSection stays read-only", () => {
  const src = (f: string) => readFileSync(join(__dirname, "..", "[id]", f), "utf8");
  it("imports only the verify action; never a posting, reconcile or authorise action", () => {
    for (const f of ["InvoiceStatusSection.tsx", "ClaimInvoiceStatus.tsx", "invoice-verification-context.tsx"]) {
      const s = src(f);
      const names = [...s.matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]*)"/g)].filter((m) => /actions|store/.test(m[2])).flatMap((m) => m[1].split(",").map((x) => x.trim()));
      expect(names.filter((n) => n !== "verifyInvoiceStatusesAction"), f).toEqual([]);
      expect(s, f).not.toMatch(/postClaimToCin7Action|reconcileClaimPostingAction|authori[sz]e\w*Action/);
    }
  });
  it("the pure model imports no action, store or React", () => {
    const s = readFileSync(join(__dirname, "../../../lib/projects/invoice-authorisation.ts"), "utf8");
    expect(s).not.toMatch(/from "(\.\.\/)?(\.\/)?[^"]*(actions|store)"/);
    expect(s).not.toMatch(/from "react"/);
  });
});
