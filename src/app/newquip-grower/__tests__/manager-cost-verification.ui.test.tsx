// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { canSeeCosts, resolveRoles } from "@/lib/approvals/role-store";
import { createQuote, saveDraft } from "@/lib/newquip-quotes/quote-store";
import { rolesFor } from "@/newquip/quote/roles";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { equivalentInputs } from "@/newquip/pricing/estimator/__tests__/helpers";
import * as pricingActions from "../pricing-actions";

// The independent cost verification is a MANAGER's job (the server's reviewer roles), but the whole Stage 2 workspace sat inside <fieldset disabled={!s2Edit}> (Estimator only), so a genuine
// Manager saw the verify controls and could not operate them. The workspace now sits OUTSIDE that fieldset and every EDITING control in it is gated explicitly. Rendered through the REAL page.

let db: FakeDb;
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn() }));
vi.mock("@/lib/approvals/role-store", () => ({ resolveRoles: vi.fn(), canSeeCosts: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: (globalThis as { __QID?: string }).__QID }),
  useSearchParams: () => new URLSearchParams("stage=2&step=2"),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/newquip-grower/x",
}));

const ORG = "org-nq";
const ME = "u@nq";
const SESSION = { orgId: ORG, userId: "u1", email: ME };
const member = rolesFor("member");
type Role = "REP" | "ESTIMATOR" | "MANAGER";
const asRoles = (...r: Role[]) => vi.mocked(resolveRoles).mockResolvedValue(new Set(r) as never);
const g = globalThis as { __QID?: string };
const SUBMITTED = { state: "ESTIMATOR_REVIEW", row: { customer_confirmed_cents: 1000000000, customer_confirmed_by: "A Customer <a@c.co>", customer_confirmed_at: "2026-11-02T08:00:00Z", handoff_by_email: "rep@nq" } };

beforeEach(() => {
  db = new FakeDb();
  vi.clearAllMocks();
  vi.mocked(requireNewquipPocOrg).mockResolvedValue(SESSION as never);
  vi.mocked(requireModuleAccess).mockResolvedValue(SESSION as never);
  vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("not admin"));
  vi.mocked(canSeeCosts).mockResolvedValue(false);
  asRoles("REP");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** `enteredBy`: who entered every supplier cost (the verifier must be someone else). */
async function open(o: { roles: Role[]; commercials: boolean; enteredBy?: string }) {
  asRoles(...o.roles);
  vi.mocked(canSeeCosts).mockResolvedValue(o.commercials);
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  const p = equivalentInputs({}, "unverified");
  if (o.enteredBy) for (const k of Object.keys(p.skus)) p.skus[k] = { ...p.skus[k]!, by: o.enteredBy };
  const d = readyDraft();
  await saveDraft(db as never, ORG, member, id, { ...d, estimator: { ...d.estimator, pricing: p } });
  for (const row of db.rows("newquip_quotes") as Array<Record<string, unknown>>) if (row.id === id) { row.state = SUBMITTED.state; Object.assign(row, SUBMITTED.row); }
  g.__QID = id;
  const { default: Page } = await import("../[id]/page");
  render(createElement(Page));
  return id;
}
const name = (e: Element) => e.getAttribute("aria-label") || ((e as HTMLInputElement).labels?.[0]?.textContent ?? "") || (e.closest("label")?.textContent ?? "") || e.textContent || e.getAttribute("data-testid") || e.tagName;
const enabledControls = (root: ParentNode) => [...root.querySelectorAll("input,select,textarea,button")].filter((e) => !(e as HTMLInputElement).disabled && !e.matches(":disabled"));
// The ONLY controls a verify-only viewer may operate inside the supplier-pricing workspace.
const ALLOWED = (e: Element) => /^Verify .+ cost$/.test(e.getAttribute("aria-label") ?? "") || /^Evidence checked/.test(name(e)) || ["verify-save", "verify-all", "attest-save"].includes(e.getAttribute("data-testid") ?? "") || /^Attest .* forward-cover rate$/.test(e.getAttribute("aria-label") ?? "");

describe("a genuine Manager (no Estimator role) on the REAL Stage 2 page", () => {
  it("can tick a verifiable cost, type evidence and submit the verification - and can edit NOTHING else in the supplier-pricing workspace", async () => {
    await open({ roles: ["MANAGER"], commercials: true, enteredBy: "estimator@example.test" });
    const block = await screen.findByTestId("verify-block", {}, { timeout: 15000 });
    const panel = screen.getByTestId("estimator-pricing-panel");
    expect(block.closest("fieldset[disabled]")).toBeNull(); // not under any disabled fieldset
    const ticks = screen.getAllByLabelText(/^Verify .* cost$/) as HTMLInputElement[];
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.every((t) => !t.disabled && !t.matches(":disabled"))).toBe(true);
    const save = screen.getByTestId("verify-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true); // no costs ticked, no evidence yet
    fireEvent.click(ticks[0]);
    expect(ticks[0].checked).toBe(true); // a disabled checkbox would not toggle
    const ev = screen.getByLabelText("Evidence checked (for example the supplier quote reference)") as HTMLInputElement;
    expect(ev.matches(":disabled")).toBe(false);
    expect(save.disabled).toBe(true); // evidence is still required
    fireEvent.change(ev, { target: { value: "Supplier quote SQ-77" } });
    expect(ev.value).toBe("Supplier quote SQ-77");
    expect(save.disabled).toBe(false);
    const spy = vi.spyOn(pricingActions, "verifyEstimatorCostsAction").mockResolvedValue({ ok: true, data: { seq: 2, verified: 1 } });
    fireEvent.click(save);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const [, items, evidence] = spy.mock.calls[0];
    expect(evidence).toBe("Supplier quote SQ-77");
    expect(items.length).toBe(1);
    // every OTHER control in the workspace is disabled or absent: supplier, currency, cost, source, freight, price overrides, FX, markup, target price, reason, save / switch on-off, add SKU, clear cost
    const stray = enabledControls(panel).filter((e) => !ALLOWED(e)).map(name);
    expect(stray).toEqual([]);
    for (const label of [/ supplier$/, / currency$/, / supplier cost$/, / cost source$/, / freight factor$/, /price override per unit/, /^Project markup/, /^Target (project )?price/, /^Reason for this pricing revision/, /^SKU to add/]) {
      for (const el of screen.queryAllByLabelText(label)) expect((el as HTMLInputElement).disabled || el.matches(":disabled"), String(label)).toBe(true);
    }
    expect(screen.queryByTestId("pricing-save")).toBeNull();
    expect(screen.queryByTestId("pricing-off")).toBeNull();
    expect(screen.queryByTestId("clear-cost")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  }, 60000);

  it("the rest of Stage 2 stays Estimator-only: no enabled editing control outside the verification block anywhere in the costs step", async () => {
    await open({ roles: ["MANAGER"], commercials: true, enteredBy: "estimator@example.test" });
    await screen.findByTestId("verify-block", {}, { timeout: 15000 });
    const costs = document.querySelector('[data-step-panel="costs"]')!;
    // EVERY enabled control in the costs step - buttons included - must be one of the verify / attest controls (verify ticks, evidence input, Verify, Select-all, attest controls)
    const stray = enabledControls(costs).filter((e) => !ALLOWED(e)).map(name);
    expect(stray).toEqual([]);
    expect(screen.queryByRole("button", { name: /Confirm source-backed mappings/ })).toBeNull();
    expect(screen.queryAllByRole("button", { name: /Capture latest costs from Cin7/ }).every((b) => b.matches(":disabled"))).toBe(true); // the Cin7 capture stays Estimator-only (inside the disabled fieldset)
  }, 60000);
});

describe("a verify-only Manager sees the outcome of the verification", () => {
  const tickAndSubmit = async () => {
    await screen.findByTestId("verify-block", {}, { timeout: 15000 });
    fireEvent.click(screen.getAllByLabelText(/^Verify .* cost$/)[0]);
    fireEvent.change(screen.getByLabelText("Evidence checked (for example the supplier quote reference)"), { target: { value: "Supplier quote SQ-77" } });
    fireEvent.click(screen.getByTestId("verify-save"));
  };
  it("success: the confirmation note is shown (and no editing block appears)", async () => {
    await open({ roles: ["MANAGER"], commercials: true, enteredBy: "estimator@example.test" });
    vi.spyOn(pricingActions, "verifyEstimatorCostsAction").mockResolvedValue({ ok: true, data: { seq: 2, verified: 1 } });
    await tickAndSubmit();
    await waitFor(() => expect(screen.getByTestId("pricing-note").textContent).toMatch(/1 supplier cost independently verified. No price changed/));
    expect(screen.queryByTestId("pricing-save")).toBeNull();
  }, 60000);
  it("refused (stale cost, entered by you, already verified ...): the server's reason is shown, not silence", async () => {
    await open({ roles: ["MANAGER"], commercials: true, enteredBy: "estimator@example.test" });
    vi.spyOn(pricingActions, "verifyEstimatorCostsAction").mockResolvedValue({ ok: false, error: "The cost changed since you looked at it.", errors: ["The cost changed since you looked at it."] });
    await tickAndSubmit();
    await waitFor(() => expect(screen.getByTestId("pricing-errors").textContent).toMatch(/The cost changed since you looked at it/));
    expect(screen.queryByTestId("pricing-note")).toBeNull();
  }, 60000);
});

describe("separation of duties", () => {
  it("the person who ENTERED the costs gets no verify tick for them (UI), and the server refuses their verification", async () => {
    const id = await open({ roles: ["MANAGER"], commercials: true, enteredBy: ME });
    await waitFor(() => expect(screen.getByTestId("estimator-pricing-panel")).toBeTruthy(), { timeout: 15000 });
    await waitFor(() => expect(screen.getAllByTestId("pricing-row").length).toBeGreaterThan(0));
    expect(screen.queryAllByLabelText(/^Verify .* cost$/)).toHaveLength(0);
    // use the REAL cost hash the server shows, so the refusal can only come from the independence rule (a wrong hash would fail regardless)
    const bundle = await pricingActions.getEstimatorPricingAction(id);
    expect(bundle.ok).toBe(true);
    const row = bundle.ok ? bundle.data!.view.rows.find((x) => x.costHash) : undefined;
    expect(row).toBeTruthy();
    expect(bundle.ok && bundle.data!.verification.verifiableSkus).not.toContain(row!.sku);
    const r = await pricingActions.verifyEstimatorCostsAction(id, [{ sku: row!.sku, costHash: row!.costHash }], "Supplier quote SQ-1");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/entered|independent|yourself|another/i);
  }, 60000);

  it("a viewer with no reviewer role (Estimator only) sees no verification block and the server refuses to verify", async () => {
    const id = await open({ roles: ["ESTIMATOR"], commercials: true, enteredBy: "estimator@example.test" });
    await waitFor(() => expect(screen.getByTestId("estimator-pricing-panel")).toBeTruthy(), { timeout: 15000 });
    expect(screen.queryByTestId("verify-block")).toBeNull();
    const r = await pricingActions.verifyEstimatorCostsAction(id, [{ sku: "PNQ082", costHash: "x" }], "Supplier quote SQ-1");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/Only .* who can see costs may independently verify/);
  }, 60000);

  it("a Rep sees no supplier-pricing workspace, no verification and no cost; the server refuses", async () => {
    const id = await open({ roles: ["REP"], commercials: false, enteredBy: "estimator@example.test" });
    await screen.findByTestId("step-rail", {}, { timeout: 15000 });
    expect(screen.queryByTestId("estimator-pricing-panel")).toBeNull();
    expect(screen.queryByTestId("verify-block")).toBeNull();
    expect(screen.queryByTestId("disc-supplier-pricing")).toBeNull();
    const r = await pricingActions.verifyEstimatorCostsAction(id, [{ sku: "PNQ082", costHash: "x" }], "Supplier quote SQ-1");
    expect(r.ok).toBe(false);
  }, 60000);
});
