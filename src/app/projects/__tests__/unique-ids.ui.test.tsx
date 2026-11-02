// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ProjectWorkspace } from "../[id]/ProjectWorkspace";
import type { ProjectView } from "@/lib/projects/project-view";

// Unique ids when several workspaces are mounted at once. (Harness copied from d4f-disabled-reasons.) Original note: every important DISABLED control says WHY, in visible text wired to the control with aria-describedby (never title-only). The REAL workspace and panels; only server actions are stubbed.

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



describe("duplicate DOM ids across mounted workspaces", () => {
  it("two mounted workspaces never share an id, and each aria-describedby resolves inside its own subtree", async () => {
    const { container: a } = render(<div data-testid="ws-a"><ProjectWorkspace id="p1" /></div>);
    const { container: b } = render(<div data-testid="ws-b"><ProjectWorkspace id="p1" /></div>);
    for (const c of [a, b]) {
      fireEvent.click(await within(c).findByRole("button", { name: /Commercial \/ Claims/ }));
      await within(c).findByText(/Create progress claim/);
    }
    const ids = Array.from(document.querySelectorAll("[id]")).map((e) => e.id).filter((id) => /reason|busy/.test(id));
    expect(ids.length).toBeGreaterThan(2);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates anywhere in the document
    let described = 0;
    for (const c of [a, b]) {
      for (const el of Array.from(c.querySelectorAll("[aria-describedby]"))) {
        for (const id of (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)) {
          described++;
          expect(c.querySelector(`[id="${id}"]`), `describedby ${id} must resolve inside its own workspace`).not.toBeNull();
        }
      }
    }
    expect(described).toBeGreaterThan(0);
  });
  it("claim buttons point at a busy reason only while it is rendered", async () => {
    render(<ProjectWorkspace id="p1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Commercial \/ Claims/ }));
    await screen.findByText(/Create progress claim/);
    for (const el of Array.from(document.querySelectorAll("[aria-describedby]"))) {
      for (const id of (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)) expect(document.getElementById(id), `dangling ${id}`).not.toBeNull();
    }
  });
});
