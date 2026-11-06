// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ProjectWorkspace } from "../[id]/ProjectWorkspace";
import type { ProjectView } from "@/lib/projects/project-view";

// D4 F-12: every important DISABLED control says WHY, in visible text wired to the control with aria-describedby (never title-only). The REAL workspace and panels; only server actions are stubbed.

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
const cin7 = (kind: string, label: string, invoiceNumber: string | null = null, reconciled = false) => ({ kind, tone: "neutral", label, invoiceNumber, reconciled, detail: null });
const claim = (id: string, n: string, status: string, total: number, c7: ReturnType<typeof cin7>, over: Record<string, unknown> = {}) => ({
  id, claim_number: n, claim_date: "2026-11-01", supersedes_claim_id: null, total_cents: total, subtotal_cents: Math.round(total / 1.15), tax_cents: total - Math.round(total / 1.15),
  status, reserves: status !== "DRAFT", cin7Status: c7, approval: null, ...over,
});
const CLAIMS = [
  claim("c1", "PRJ-X-C01", "CIN7_CREATED", 115_000_00, cin7("DRAFT_CREATED", "Draft invoice created", "INV-00034", true)),
  claim("c2", "PRJ-X-C02", "CIN7_CREATED", 57_500_00, cin7("AUTHORISED", "Invoice authorised", "INV-00037", true)),
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


/** The visible text the control points at through aria-describedby ("" when it points at nothing, or at something that is not on the page). */
const reasonOf = (el: HTMLElement): string => (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
const btn = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const hang = { then: () => {} }; // an action that never settles: "another action is in progress"

async function openCommercial(opts: { canApprove?: boolean; creation?: Record<string, unknown>; posting?: Record<string, unknown>; claims?: unknown[] } = {}) {
  if (opts.claims) h.responses.getProjectAction = { ok: true, data: { ...view(), claims: opts.claims }, viewer: { canApprove: opts.canApprove ?? true, newquip: true } };
  else h.responses.getProjectAction = { ok: true, data: view(), viewer: { canApprove: opts.canApprove ?? true, newquip: true } };
  const boot = (h.responses.getCommercialBootAction as { data: { creation: Record<string, unknown>; posting: Record<string, unknown> } }).data;
  if (opts.creation) boot.creation = { ...boot.creation, ...opts.creation };
  if (opts.posting) boot.posting = { ...boot.posting, ...opts.posting };
  render(<ProjectWorkspace id="p1" />);
  fireEvent.click(await screen.findByRole("button", { name: /Commercial \/ Claims/ }));
  await screen.findByTestId("commercial-summary");
  await screen.findByText(/Create progress claim/);
}

describe("D4 F-12 claims: why each disabled claim control is disabled", () => {
  it("Preview claim says to tick a stage first; Save as draft claim says to preview first", async () => {
    await openCommercial();
    expect(btn("Preview claim").disabled).toBe(true);
    expect(reasonOf(btn("Preview claim"))).toMatch(/tick at least one billing stage/);
    expect(btn("Save as draft claim").disabled).toBe(true);
    expect(reasonOf(btn("Save as draft claim"))).toMatch(/previewed the claim/);
  });
  it("after a preview the stages are unchanged: 'Preview is up to date' explains itself", async () => {
    h.responses.previewClaimAction = { ok: true, data: { claimNumber: "PRJ-X-C05", taxRateBps: 1500, calc: { subtotalCents: 1, taxCents: 0, totalCents: 1, lines: [] } } };
    await openCommercial();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(reasonOf(btn("Preview claim"))).toBe(""); // enabled: nothing to explain
    fireEvent.click(btn("Preview claim"));
    await waitFor(() => expect(btn("Preview is up to date").disabled).toBe(true));
    await waitFor(() => expect(reasonOf(btn("Preview is up to date"))).toMatch(/preview is up to date.*Change the stages/));
    expect(btn("Save as draft claim").disabled).toBe(false);
    expect(reasonOf(btn("Save as draft claim"))).toBe("");
  });
  it("while another action is in progress, the claim buttons say so", async () => {
    h.responses.submitClaimForApprovalAction = hang;
    await openCommercial();
    const c4 = Array.from(document.querySelectorAll("article")).find((a) => a.textContent!.includes("PRJ-X-C04")) as HTMLElement;
    fireEvent.click(within(c4).getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(within(c4).getByRole("button", { name: "Recalculate" }).hasAttribute("disabled")).toBe(true));
    for (const name of ["Recalculate", "Cancel"]) expect(reasonOf(within(c4).getByRole("button", { name }))).toMatch(/another action is in progress/);
    // the other claim's Approve button is disabled for the same reason, and says so
    const c3 = Array.from(document.querySelectorAll("article")).find((a) => a.textContent!.includes("PRJ-X-C03")) as HTMLElement;
    expect(within(c3).getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(true);
    expect(reasonOf(within(c3).getByRole("button", { name: "Approve" }))).toMatch(/another action is in progress/);
  });
  it("a viewer who cannot approve is told which role is needed, in visible text (no Approve button is offered)", async () => {
    await openCommercial({ canApprove: false });
    const c3 = Array.from(document.querySelectorAll("article")).find((a) => a.textContent!.includes("PRJ-X-C03")) as HTMLElement;
    expect(within(c3).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(c3).getByTestId("claim-waiting").textContent).toMatch(/Awaiting|No approval request was found/);
  });
});

describe("D4 F-12 Cin7 panels: why Create / Post / Verify are disabled", () => {
  const creationBoot = { gates, creation: null, linked: false, scopeItems: [], saleLines: [], blockers: [], excluded: [] };
  it("Create Sales Order names every unmet requirement: writes off, missing fields, confirmation", async () => {
    await openCommercial({ creation: creationBoot });
    const create = btn("Create Sales Order in Cin7");
    expect(create.disabled).toBe(true);
    const why = reasonOf(create);
    expect(why).toMatch(/Cin7 writes are switched off for this organisation/);
    expect(why).toMatch(/Enter the Cin7 location, revenue account/);
    expect(why).toMatch(/Tick the confirmation/);
    expect(why).not.toMatch(/Only a manager/);
  });
  it("a non-manager is told only that a manager is needed (no blockers or other detail)", async () => {
    await openCommercial({ creation: { ...creationBoot, gates: { ...gates, isManager: false }, blockers: ["secret blocker detail"] }, posting: { gates: { ...gates, isManager: false } } });
    const why = reasonOf(btn("Create Sales Order in Cin7"));
    expect(why).toMatch(/Only a manager can create/);
    expect(why).not.toMatch(/blocker|scope item|Tick the confirmation/);
  });
  it("scope blockers are named for a manager", async () => {
    await openCommercial({ creation: { ...creationBoot, blockers: ["b1", "b2"] } });
    expect(reasonOf(btn("Create Sales Order in Cin7"))).toMatch(/2 scope items are not resolved/);
  });
  const approved = claim("c9", "PRJ-X-C09", "APPROVED", 11_500_00, cin7("NOT_SENT", "Not sent to Cin7"));
  it("Prepare and post says writes are off, with a linked Sale", async () => {
    await openCommercial({ claims: [approved] });
    const b = btn("Prepare and post claim to Cin7");
    expect(b.disabled).toBe(true);
    expect(reasonOf(b)).toMatch(/Cin7 writes are switched off for this organisation/);
  });
  it("with no linked Sale, posting says a linked Sales Order is needed first (no hidden button)", async () => {
    await openCommercial({ claims: [approved], posting: { link: null, postings: [] } });
    expect(screen.queryByRole("button", { name: "Prepare and post claim to Cin7" })).toBeNull();
    expect(screen.getAllByTestId("disabled-reason").some((e) => /needs a linked Cin7 Sales Order/.test(e.textContent!))).toBe(true);
  });
  it("Post to Cin7 (the confirm button) says the proposal must be prepared first", async () => {
    gates.writesEnabled = true;
    try {
      h.responses.getInvoiceProposalAction = hang;
      await openCommercial({ claims: [approved], posting: { gates: { ...gates } } });
      fireEvent.click(btn("Prepare and post claim to Cin7"));
      const post = await screen.findByRole("button", { name: "Create a Cin7 invoice for this approved claim" });
      expect(post.hasAttribute("disabled")).toBe(true);
      expect(reasonOf(post)).toMatch(/until the proposed invoice has been prepared/);
    } finally { gates.writesEnabled = false; }
  });
});

describe("D4 F-12 milestone confirmation", () => {
  it("Record confirmation names what is missing, and says evidence is optional", async () => {
    await openCommercial();
    const rec = await screen.findByRole("button", { name: "Record confirmation" });
    expect(rec.hasAttribute("disabled")).toBe(true);
    expect(reasonOf(rec)).toMatch(/choose a milestone and say what was confirmed.*evidence reference is optional/);
    fireEvent.change(screen.getByLabelText("Milestone"), { target: { value: "s1" } });
    expect(reasonOf(rec)).toMatch(/until you say what was confirmed/);
    expect(reasonOf(rec)).not.toMatch(/choose a milestone/);
    fireEvent.change(screen.getByLabelText("What was confirmed"), { target: { value: "Installed" } });
    expect(rec.hasAttribute("disabled")).toBe(false);
    expect(reasonOf(rec)).toBe("");
  });
});
