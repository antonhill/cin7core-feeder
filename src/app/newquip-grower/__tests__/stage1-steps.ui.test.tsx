// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { canSeeCosts, resolveRoles } from "@/lib/approvals/role-store";
import { createQuote, saveDraft } from "@/lib/newquip-quotes/quote-store";
import { emptyDraft } from "@/newquip/grower/draft";
import { rolesFor } from "@/newquip/quote/roles";
import * as ca from "../customer-actions";
import * as da from "../delivery-actions";

// UX-006a, rendered through the REAL page (Stage 1): the step rail, Back / Next, ?step=, Show all steps, Next incomplete step, the Review step, and the save-state chip.
// The customer panel's own read is stubbed (the FakeDb has no customer tables) so the lifted facts can be controlled; nothing else is mocked.
let db: FakeDb;
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn() }));
vi.mock("@/lib/approvals/role-store", () => ({ resolveRoles: vi.fn(), canSeeCosts: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
const ORG = "org-nq";
const SESSION = { orgId: ORG, userId: "u1", email: "u@nq" };
const member = rolesFor("member");
const g = globalThis as { __QID?: string; __STAGE?: string; __STEP?: string };
const asRoles = (...r: Array<"REP" | "ESTIMATOR" | "MANAGER">) => vi.mocked(resolveRoles).mockResolvedValue(new Set(r) as never);

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: g.__QID }),
  useSearchParams: () => new URLSearchParams("stage=" + (g.__STAGE ?? "1") + (g.__STEP ? `&step=${g.__STEP}` : "")),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/newquip-grower/x",
}));

beforeEach(() => {
  db = new FakeDb();
  vi.clearAllMocks();
  vi.mocked(requireNewquipPocOrg).mockResolvedValue(SESSION as never);
  vi.mocked(requireModuleAccess).mockResolvedValue(SESSION as never);
  vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("not admin"));
  vi.mocked(canSeeCosts).mockResolvedValue(false);
  asRoles("REP");
  g.__STAGE = undefined; g.__STEP = undefined;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/* eslint-disable @typescript-eslint/no-explicit-any */
const base = emptyDraft();
const goodConfig = { ...base.config, rooms: 12, widthM: 14.43, lengthM: 49.5, totalPens: 20, pigsPerRoom: 600, hospitalPens: 2, feederVariant: "STANDARD", penningPigSize: "SMALL", penningRunningMetresPerRoom: 20 } as any;
const customerView = (over: Record<string, unknown> = {}): any => ({ available: true, snapshot: null, snapshotId: null, seq: null, issues: ["Select the customer from Cin7."], currency: null, selectedContactIndex: null, confirmationContact: null, editable: true, lockedReason: null, changeReturnsToRep: false, history: [], ...over });
const snapshotView = (contact: boolean): any => customerView({ snapshot: { cin7CustomerId: "c1", name: { state: "present", value: "Acme" }, tradingName: { state: "missing" }, billingAddress: null, vatNumber: { state: "missing" }, currency: { state: "missing" }, paymentTerm: { state: "missing" }, contacts: [], chosenContact: contact ? { name: "Sean", email: "s@x.co", source: "CIN7_CONTACT", phone: null } : null }, snapshotId: "s1", seq: 1, issues: [] });

async function open(draftOver: Record<string, unknown> = {}, view: any = customerView(), roles: Array<"REP" | "ESTIMATOR" | "MANAGER"> = ["REP", "ESTIMATOR"], step?: string) {
  asRoles(...roles);
  vi.spyOn(ca, "getQuoteCustomerAction").mockResolvedValue({ ok: true, data: view } as never);
  vi.spyOn(da, "getQuoteDeliveryAction").mockResolvedValue({ ok: false, error: "n/a" } as never);
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, { ...base, customerName: "Acme Pigs", siteName: "Farm 1", config: goodConfig, ...draftOver } as any);
  g.__QID = id; g.__STEP = step;
  const { default: Page } = await import("../[id]/page");
  render(createElement(Page));
  await waitFor(() => expect(screen.getByTestId("step-rail")).toBeTruthy(), { timeout: 5000 });
}
const status = (id: string) => screen.getByTestId(`step-status-${id}`).textContent;
const panel = (id: string) => document.querySelector(`[data-step-panel="${id}"]`)!;

describe("UX-006a Stage 1 step rail", () => {
  it("five steps in an ordered list, step 1 current; other steps stay MOUNTED but hidden and inert", async () => {
    await open();
    const rail = screen.getByRole("navigation", { name: "Configuration steps" });
    expect(rail.querySelectorAll("ol > li").length).toBe(5);
    expect(rail.querySelector('[aria-current="step"]')!.textContent).toContain("Select customer");
    expect(panel("customer").hasAttribute("hidden")).toBe(false);
    for (const id of ["site", "room", "equipment", "review"]) { expect(panel(id).hasAttribute("hidden")).toBe(true); expect(panel(id).hasAttribute("inert")).toBe(true); }
    expect(screen.getByLabelText(/^Length/)).toBeTruthy(); // mounted although hidden
  }, 30000);

  it("a typed customer name without a Cin7 snapshot is Needs attention with the handoff note", async () => {
    await open();
    await waitFor(() => expect(status("customer")).toBe("Needs attention"));
    expect(within(screen.getByTestId("step-rail")).getByText("Needed before sending to the Estimator")).toBeTruthy();
  }, 30000);

  it("snapshot plus contact makes step 1 Complete; a snapshot without a contact stays Needs attention", async () => {
    await open({}, snapshotView(true));
    await waitFor(() => expect(status("customer")).toBe("Complete"));
    cleanup();
    await open({}, snapshotView(false));
    await waitFor(() => expect(status("customer")).toBe("Needs attention"));
  }, 30000);

  it("visiting a step never completes it: a missing site name stays Not complete after opening step 2", async () => {
    await open({ siteName: "" });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(status("site")).toBe("Not complete");
    expect(screen.getByRole("navigation", { name: "Configuration steps" }).querySelector('[aria-current="step"]')!.textContent).toContain("Contact & site name");
  }, 30000);

  it("Next and Back move through the steps, update ?step=, and focus the new step heading", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(new URL(window.location.href).searchParams.get("step")).toBe("2");
    expect(panel("site").hasAttribute("hidden")).toBe(false);
    expect(panel("customer").hasAttribute("hidden")).toBe(true);
    expect(document.activeElement?.textContent).toBe("Step 2 · Contact & site name");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(new URL(window.location.href).searchParams.get("step")).toBe("1");
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull(); // first step has no Back
  }, 30000);

  it("?step= is validated: an out-of-range or invalid value falls back to step 1; a valid one opens that step", async () => {
    await open({}, customerView(), ["REP"], "9");
    expect(panel("customer").hasAttribute("hidden")).toBe(false);
    cleanup();
    await open({}, customerView(), ["REP"], "4");
    expect(panel("equipment").hasAttribute("hidden")).toBe(false);
    expect(panel("customer").hasAttribute("hidden")).toBe(true);
    expect(screen.queryByRole("button", { name: "Next" })).toBeTruthy();
  }, 30000);

  it("Next incomplete step jumps to the first step not complete", async () => {
    await open({ siteName: "" }, snapshotView(true));
    await waitFor(() => expect(status("customer")).toBe("Complete"));
    fireEvent.click(screen.getByRole("button", { name: "Next incomplete step" }));
    expect(panel("site").hasAttribute("hidden")).toBe(false);
  }, 30000);

  it("Show all steps reveals every step, is remembered, and is restored on the next visit; guided is the default", async () => {
    const data: Record<string, string> = {};
    vi.stubGlobal("localStorage", { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } });
    await open();
    expect(panel("room").hasAttribute("hidden")).toBe(true);
    fireEvent.click(screen.getByLabelText("Show all steps"));
    for (const id of ["customer", "site", "room", "equipment", "review"]) expect(panel(id).hasAttribute("hidden")).toBe(false);
    expect(data["nq-builder-show-all"]).toBe("1");
    cleanup();
    await open();
    await waitFor(() => expect(panel("room").hasAttribute("hidden")).toBe(false));
    expect((screen.getByLabelText("Show all steps") as HTMLInputElement).checked).toBe(true);
  }, 30000);

  it("renders correctly (guided) when storage throws", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    await open();
    expect(panel("room").hasAttribute("hidden")).toBe(true);
    fireEvent.click(screen.getByLabelText("Show all steps"));
    expect(panel("room").hasAttribute("hidden")).toBe(false);
  }, 30000);

  it("the Review step is read-only, lists Stage 1 reasons with a link back to the step that fixes them, and Continue just opens Stage 2", async () => {
    await open({ siteName: "", config: { ...goodConfig, lengthM: 0 } }, snapshotView(true), ["MANAGER"], "5");
    const issues = screen.getByTestId("stage1-review-issues");
    expect(within(issues).getByText("Site / project name is required.")).toBeTruthy();
    expect(within(issues).getByText(/Length must be greater than zero/)).toBeTruthy();
    fireEvent.click(within(issues).getByRole("button", { name: /Go to step 2: Contact & site name/ }));
    expect(panel("site").hasAttribute("hidden")).toBe(false);
    for (let n = 0; n < 3; n++) fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const go = screen.getByRole("button", { name: "Continue to Stage 2" }) as HTMLButtonElement;
    expect(go.disabled).toBe(false); // a Manager (who cannot edit) can still navigate
    fireEvent.click(go);
    await waitFor(() => expect(screen.getByText("Estimator review and handoff")).toBeTruthy());
    expect(new URL(window.location.href).searchParams.get("stage")).toBe("2");
  }, 30000);

  it("a viewer who cannot edit still navigates the rail, and the Stage 1 fields stay disabled", async () => {
    await open({}, customerView({ editable: false }), ["MANAGER"]);
    fireEvent.click(screen.getByRole("button", { name: /Room measurements/ }));
    expect(panel("room").hasAttribute("hidden")).toBe(false);
    expect(screen.getByLabelText(/^Length/).matches(":disabled")).toBe(true);
  }, 30000);

  it("the save-state chip is one live region: 'All changes saved', then 'Unsaved changes' after an edit", async () => {
    await open();
    const chip = screen.getByTestId("save-state");
    expect(chip.getAttribute("aria-live")).toBe("polite");
    expect(chip.textContent).toContain("All changes saved");
    fireEvent.click(screen.getByRole("button", { name: /Room measurements/ }));
    await act(async () => { fireEvent.change(screen.getByLabelText(/^Length/), { target: { value: "50" } }); });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  }, 30000);

  it("if the customer details cannot be read, step 1 says so (Needs attention) instead of 'Reading…' forever", async () => {
    await open();
    cleanup();
    asRoles("REP", "ESTIMATOR");
    vi.spyOn(ca, "getQuoteCustomerAction").mockResolvedValue({ ok: false, error: "boom" } as never);
    const { default: Page } = await import("../[id]/page");
    render(createElement(Page));
    await waitFor(() => expect(status("customer")).toBe("Needs attention"), { timeout: 5000 });
    expect(within(screen.getByTestId("step-rail")).getByText("Could not read the Cin7 customer details")).toBeTruthy();
    expect(within(screen.getByTestId("step-rail")).queryByText(/Reading the Cin7/)).toBeNull();
  }, 30000);

  it("a viewer who cannot edit sees no 'All changes saved' chip, and the step-2 'Choose the contact' link still navigates", async () => {
    await open({}, customerView({ editable: false }), ["MANAGER"], "2");
    expect(screen.getByTestId("save-state").textContent).toBe("");
    const link = screen.getByRole("link", { name: "Choose the contact in step 1" });
    expect(link.closest("fieldset")!.disabled).toBe(true); // inside the disabled fieldset, yet a link stays usable
    fireEvent.click(link);
    expect(panel("customer").hasAttribute("hidden")).toBe(false);
  }, 30000);

  it("a blank Room is Not complete with a human-readable review reason; Show all lays Room inputs and Selections in one shared grid", async () => {
    await open({ config: { ...goodConfig, lengthM: 0 } }, snapshotView(true), ["REP"], "5");
    expect(status("room")).toBe("Not complete");
    expect(within(screen.getByTestId("stage1-review-issues")).getByText("Length must be greater than zero.")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Show all steps"));
    expect(panel("room").className).toBe("contents");
    expect(panel("equipment").className).toBe("contents");
    expect(panel("room").querySelector("section")!.className).toContain("order-3");
  }, 30000);

  it("with a DIRTY draft the step-2 'Choose the contact' link changes step with no leave-page confirm; a real link still prompts", async () => {
    await open({}, snapshotView(true), ["REP", "ESTIMATOR"], "2");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.change(screen.getByLabelText(/^Site \/ project name/), { target: { value: "Changed farm" } });
    await waitFor(() => expect(screen.getByText("Unsaved changes")).toBeTruthy());
    fireEvent.click(screen.getByRole("link", { name: "Choose the contact in step 1" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(panel("customer").hasAttribute("hidden")).toBe(false);
    const real = document.querySelector('a[href="/newquip-grower"]') as HTMLAnchorElement; // the header's real link
    fireEvent.click(real);
    expect(confirm).toHaveBeenCalledTimes(1); // the guard is not weakened for real links
  }, 30000);

  it("show-all ordering is xl-only: no un-prefixed order-* class, so below xl each heading stays right before its own panel", async () => {
    await open({}, snapshotView(true), ["REP"], "1");
    fireEvent.click(screen.getByLabelText("Show all steps"));
    const orders = [...document.querySelectorAll('[data-step-panel="room"], [data-step-panel="equipment"]')].flatMap((e) => [...e.querySelectorAll("h2, section")]).flatMap((e) => e.className.split(/\s+/).filter((c) => /(^|:)order-/.test(c)));
    expect(orders.length).toBeGreaterThanOrEqual(5);
    for (const c of orders) expect(c).toMatch(/^xl:order-\d$/);
    // source order = h3, Room, h4, Selections, Ventilation, i.e. heading then its own panel
    const seq = [...document.querySelectorAll('[data-step-panel="room"], [data-step-panel="equipment"]')].flatMap((e) => [...e.children]).map((e) => e.tagName + ":" + (e.textContent ?? "").slice(0, 8));
    expect(seq[0].startsWith("H2")).toBe(true);
    expect(seq[1].startsWith("SECTION")).toBe(true);
    expect(seq[2].startsWith("H2")).toBe(true);
  }, 30000);
});
