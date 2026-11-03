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
import * as actions from "../actions";

// UX-006i1, through the REAL page (Stage 1, the Rep's five-step wizard): initial screen, one customer / one contact, locks with their reasons, the entry step resolved once after the
// customer facts settle, no jump on save / samples / recalculation, the owner-named rows, contextual samples, show-all, and the read-only views of the other roles.
// Only the session and the customer panel's own read are stubbed (the FakeDb has no customer tables).
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
type Role = "REP" | "ESTIMATOR" | "MANAGER";
const g = globalThis as { __QID?: string; __STAGE?: string; __STEP?: string };
const asRoles = (...r: Role[]) => vi.mocked(resolveRoles).mockResolvedValue(new Set(r) as never);

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
  window.history.replaceState(null, "", "/newquip-grower/x");
  try { window.localStorage.clear(); } catch { /* storage unavailable in this runtime */ }
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

/* eslint-disable @typescript-eslint/no-explicit-any */
const base = emptyDraft();
const goodConfig = { ...base.config, rooms: 12, widthM: 14.43, lengthM: 49.5, totalPens: 20, pigsPerRoom: 600, hospitalPens: 2, feederVariant: "STANDARD", penningPigSize: "SMALL", penningRunningMetresPerRoom: 20 } as any;
// A fully prepared, READY quotation (quantities, mappings, manual prices and charges all entered).
const pr = (p: number) => ({ at: "t", by: "x", reason: "Master workbook has no usable price. Temporary POC estimator value only.", unitPriceExVat: p });
const readyDraft: any = { ...base, customerName: "Acme Pigs", siteName: "Farm 1", quoteType: "day_to_day", config: { ...goodConfig, slattedFloorAreaM2: 120, optionalEquipment: { ...base.config.optionalEquipment, controller: true }, quantityOverrides: { led_light: 38, feed_saver_mat: 18 }, quantityOverrideReasons: { led_light: "Test", feed_saver_mat: "Test" }, exclusions: { pvc_door: "Not needed" },
  estimatorQuantities: { feeder: 18, pvc_door: 2, bulk_tank: 1, cone_fans: 4, controller: 2, flex_auger: 1, cup_drinker: 54, manure_plug: 2, pad_cooling: 3, concrete_slat: 1320, control_panel: 2, silo_weighing: 2, emergency_windows: 2 } },
  estimator: { ...base.estimator, confirmedMappings: { feeder: "PNQ082", pvc_door: "NQ2114", bulk_tank: "SYSH-2750-3", controller: "HO05084000", concrete_slat: "NQ1161", feed_saver_mat: "ERT053" }, confirmedPackages: ["cup_drinker", "led_light"], charges: { delivery: 979992, installation: 1200000, concrete_slat_delivery: 250000 }, unitPrices: { flex_auger: 45000 }, priceResolutions: { pvc_door: pr(3000), led_light: pr(881), controller: pr(3000), cup_drinker: pr(548), concrete_slat: pr(203), feed_saver_mat: pr(919) } } };

const customerView = (over: Record<string, unknown> = {}): any => ({ available: true, snapshot: null, snapshotId: null, seq: null, issues: ["Select the customer from Cin7."], currency: null, selectedContactIndex: null, confirmationContact: null, editable: true, lockedReason: null, changeReturnsToRep: false, history: [], ...over });
const contactRow = (name: string, email: string) => ({ name: { state: "present", value: name }, email: { state: "present", value: email } });
const snapshotView = (contact: boolean, over: Record<string, unknown> = {}): any => customerView({ snapshot: { cin7CustomerId: "c-123", name: { state: "present", value: "Acme Pigs (Pty) Ltd" }, tradingName: { state: "present", value: "Acme Pigs" }, billingAddress: null, vatNumber: { state: "missing" }, currency: { state: "missing" }, paymentTerm: { state: "missing" }, contacts: [contactRow("Sean", "s@x.co"), contactRow("Thandi", "t@x.co")], chosenContact: contact ? { name: "Sean", email: "s@x.co", source: "CIN7_CONTACT", phone: null } : null }, snapshotId: "s1", seq: 7, issues: [], selectedContactIndex: contact ? 0 : null, ...over });

interface Opts { draftOver?: Record<string, unknown>; view?: any; roles?: Role[]; commercials?: boolean; step?: string; stage?: string; row?: Record<string, unknown>; customerDelay?: Promise<void>; waitSettled?: boolean }
async function open(o: Opts = {}) {
  asRoles(...(o.roles ?? ["REP", "ESTIMATOR"]));
  vi.mocked(canSeeCosts).mockResolvedValue(o.commercials ?? false);
  const spy = vi.spyOn(ca, "getQuoteCustomerAction");
  if (o.customerDelay) spy.mockImplementation((async () => { await o.customerDelay; return { ok: true, data: o.view ?? customerView() }; }) as never);
  else spy.mockResolvedValue({ ok: true, data: o.view ?? customerView() } as never);
  vi.spyOn(da, "getQuoteDeliveryAction").mockResolvedValue({ ok: false, error: "n/a" } as never);
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, { ...base, customerName: "Acme Pigs", siteName: "Farm 1", config: goodConfig, ...o.draftOver } as any);
  for (const row of db.rows("newquip_quotes") as Array<Record<string, unknown>>) if (row.id === id && o.row) Object.assign(row, o.row);
  g.__QID = id; g.__STEP = o.step; g.__STAGE = o.stage;
  const { default: Page } = await import("../[id]/page");
  render(createElement(Page));
  await waitFor(() => expect(screen.getByTestId("step-rail")).toBeTruthy(), { timeout: 5000 });
  if (o.waitSettled !== false && !o.customerDelay) await waitFor(() => expect(screen.queryByTestId("stage1-shell")).toBeNull(), { timeout: 5000 });
  return id;
}
const status = (id: string) => screen.getByTestId(`step-status-${id}`).textContent;
const panel = (id: string) => document.querySelector(`[data-step-panel="${id}"]`)!;
const shown = (id: string) => !panel(id).hasAttribute("hidden");
const current = () => document.querySelector('[data-testid="step-rail"] [aria-current="step"]')!.getAttribute("data-step");
const urlStep = () => new URL(window.location.href).searchParams.get("step");

describe("initial screen of a fresh Rep draft", () => {
  it("five steps in an ordered list; the entry is step 1; steps 2-5 are LOCKED with a visible reason that names the Rep; their content stays mounted but hidden", async () => {
    await open();
    const rail = screen.getByRole("navigation", { name: "Configuration steps" });
    expect(rail.querySelectorAll("ol > li").length).toBe(5);
    expect(current()).toBe("customer");
    expect(shown("customer")).toBe(true);
    for (const id of ["site", "equipment", "review", "submit"]) {
      expect(status(id), id).toBe("Locked");
      expect(document.querySelector(`[data-step="${id}"]`)!.getAttribute("aria-disabled")).toBe("true");
      expect(shown(id), id).toBe(false);
    }
    expect(screen.getByTestId("step-blocked-site").textContent).toBe("Rep: choose the Cin7 customer and the quotation contact in step 1 (Customer & contact) first.");
    expect(screen.getByLabelText(/^Length/)).toBeTruthy(); // locked content is still mounted
    expect(document.body.textContent).not.toMatch(/Estimated cost|Internal margins|GP \(managers\)/);
  }, 30000);

  it("there is NO free-text Customer field when Cin7 lookup is available (the Cin7 customer is the only identity); the global 'Load Demo Defaults' button is gone", async () => {
    await open({ view: snapshotView(true) });
    expect(screen.queryByRole("textbox", { name: /^Customer\b/, hidden: true })).toBeNull();
    expect(screen.queryByRole("button", { name: /Load Demo Defaults/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /whole demonstration quote/ })).toBeNull(); // not Preview
    expect(screen.queryByTestId("preview-tools")).toBeNull();
    expect(screen.getByTestId("customer-title").textContent).toBe("Acme Pigs"); // the trading name, prominently
  }, 30000);

  it("the typed-name fallback appears ONLY when Cin7 customer lookup is unavailable", async () => {
    await open({ view: customerView({ available: false }) });
    expect(screen.getByLabelText(/^Customer\b/)).toBeTruthy();
    expect(status("site")).not.toBe("Locked"); // the typed name satisfies step 1 there (as before)
  }, 30000);

  it("ONE contact chooser: Cin7 contacts and the quotation-only contact in step 1; no contact link or chooser anywhere else; technical IDs only inside Details", async () => {
    await open({ view: snapshotView(true), step: "2" });
    expect(screen.getAllByRole("group", { name: "Quotation contact", hidden: true }).length).toBe(1);
    expect(screen.queryByRole("link", { name: /Choose the contact in step 1/ })).toBeNull();
    expect(screen.getByTestId("send-to-line").textContent).toBe("Quotation will be sent to s@x.co");
    const details = screen.getByTestId("customer-details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("c-123"); // the Cin7 id and snapshot number are in Details only
    const outside = (document.querySelector('[data-step-panel="customer"]')!.textContent ?? "").replace(details.textContent ?? "", "");
    expect(outside).not.toContain("c-123");
    expect(screen.getByRole("button", { name: /Quotation-only contact/, hidden: true })).toBeTruthy();
  }, 30000);
});

describe("locks unlock only when the earlier steps are complete (and say why)", () => {
  it("a snapshot without a chosen contact keeps step 2 locked; choosing the contact unlocks it; Back to a permitted step is always available", async () => {
    const view = snapshotView(false);
    await open({ view });
    expect(status("site")).toBe("Locked");
    const choose = vi.spyOn(ca, "chooseQuoteContactAction").mockResolvedValue({ ok: true, data: snapshotView(true) } as never);
    fireEvent.click(screen.getByRole("button", { name: /Sean/ }));
    await waitFor(() => expect(choose).toHaveBeenCalled());
    await waitFor(() => expect(status("site")).not.toBe("Locked"), { timeout: 5000 });
    expect(current()).toBe("customer"); // choosing the contact does not move the viewer
    const next = screen.getByRole("button", { name: "Next: Site & measurements" }) as HTMLButtonElement;
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    expect(current()).toBe("site");
    expect(urlStep()).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(current()).toBe("customer");
  }, 30000);

  it("Next is DISABLED with the blocker in plain text when the next step is locked, and never submits anything", async () => {
    const submitSpy = vi.spyOn(actions, "sendGrowerQuoteToEstimatorAction");
    await open({ view: snapshotView(true), draftOver: { siteName: "" }, step: "2" });
    expect(current()).toBe("site");
    const next = screen.getByRole("button", { name: "Next: Equipment & options" }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    expect(screen.getByTestId("next-blocked").textContent).toContain("step 2 (Site & measurements)");
    expect(next.getAttribute("aria-describedby")).toBe("next-why");
    fireEvent.change(screen.getByLabelText(/^Site \/ project name/), { target: { value: "Farm 1" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Next: Equipment & options" }) as HTMLButtonElement).disabled).toBe(false));
    expect(submitSpy).not.toHaveBeenCalled();
  }, 30000);

  it("the Estimator-owned mapping is shown as a read-only row naming the owner, with no chooser, and does NOT lock the Rep's own steps", async () => {
    await open({ view: snapshotView(true), draftOver: { config: { ...readyDraft.config }, estimator: { ...readyDraft.estimator, confirmedMappings: {}, priceResolutions: {} } }, step: "3" });
    expect(current()).toBe("equipment");
    expect(document.querySelector('[data-testid^="mapping-chooser-"]')).toBeNull();
    const rows = screen.getAllByTestId(/^owner-row-/);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].textContent).toMatch(/^Estimator mapping needed: /);
    expect(status("review")).not.toBe("Locked"); // Estimator-owned work does not block the Rep from reviewing
    expect(status("submit")).toBe("Locked");
    expect(screen.getByTestId("step-blocked-submit").textContent).toMatch(/^Estimator: mapping needed/);
  }, 30000);

  it("Review lists the missing information WITH its owner (Rep items link to the step; Estimator items are text only)", async () => {
    await open({ view: snapshotView(true), draftOver: { config: { ...readyDraft.config }, estimator: { ...readyDraft.estimator, confirmedMappings: {}, priceResolutions: {} } }, step: "4" });
    const issues = screen.getByTestId("stage1-review-issues");
    const tags = within(issues).getAllByTestId("owner-tag").map((t) => t.textContent);
    expect(tags).toContain("Estimator");
    expect(within(issues).getAllByText(/Estimator mapping needed/).length).toBeGreaterThan(0);
    expect(within(issues).getAllByText(/Waiting on the Estimator/).length).toBeGreaterThan(0);
    expect(within(issues).queryByRole("button", { name: /Estimator mapping/ })).toBeNull();
    expect(within(screen.getByTestId("stage1-review-chips")).getAllByRole("listitem").length).toBe(3);
  }, 30000);
});

describe("the entry step is resolved ONCE, after the customer facts settle", () => {
  it("while the customer details are loading a small shell shows and the rail is not usable; there is no post-load jump", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await open({ view: snapshotView(true), draftOver: { siteName: "" }, customerDelay: gate });
    expect(screen.getByTestId("stage1-shell").textContent).toContain("Preparing your quotation steps");
    expect(screen.getByTestId("step-rail").closest("[hidden]")).not.toBeNull(); // not interactive meanwhile
    expect(shown("customer")).toBe(true); // (mounted, so the customer panel can load)
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 50)); });
    await waitFor(() => expect(screen.queryByTestId("stage1-shell")).toBeNull());
    expect(current()).toBe("site"); // the first incomplete step: customer is complete, site name missing
    expect(shown("site")).toBe(true);
    expect(screen.getByTestId("step-rail").closest("[hidden]")).toBeNull();
  }, 30000);

  it("once resolved it is latched: when the facts change later (a contact is chosen) the viewer is NOT moved", async () => {
    await open({ view: snapshotView(false) });
    expect(current()).toBe("customer");
    vi.spyOn(ca, "chooseQuoteContactAction").mockResolvedValue({ ok: true, data: snapshotView(true) } as never);
    fireEvent.click(screen.getByRole("button", { name: /Thandi/ }));
    await waitFor(() => expect(status("site")).not.toBe("Locked"), { timeout: 5000 });
    expect(current()).toBe("customer");
  }, 30000);

  it("an explicit ?step= wins only if permitted: a locked request is clamped to where the viewer may be, and the address bar follows", async () => {
    await open({ view: customerView(), step: "4" }); // fresh draft: step 4 (Review) is locked
    expect(current()).toBe("customer");
    await waitFor(() => expect(urlStep()).toBe("1"));
    cleanup();
    await open({ view: snapshotView(true), draftOver: { siteName: "" }, step: "1" });
    expect(current()).toBe("customer"); // permitted earlier step wins over the entry (site)
    cleanup();
    await open({ view: snapshotView(true), step: "9" }); // invalid -> parse falls back to 1, still permitted
    expect(current()).toBe("customer");
  }, 60000);

  it("a RETURNED quotation (Rep draft, revision 2) shows the banner with the approval-history disclosure and opens at the first incomplete step", async () => {
    await open({ view: snapshotView(true), draftOver: { siteName: "" }, row: { revision: 2 } });
    const banner = screen.getByTestId("returned-banner");
    expect(banner.textContent).toContain("Returned to the Rep (revision 2)");
    expect(banner.textContent).toContain("Returned by the Estimator/Manager - see Approval history");
    expect(within(banner).getByText("Show the return reason (Approval history)")).toBeTruthy();
    expect(current()).toBe("site");
    cleanup();
    await open({ view: snapshotView(true) });
    expect(screen.queryByTestId("returned-banner")).toBeNull(); // revision 1: no banner
  }, 60000);
});

describe("nothing resets or jumps", () => {
  const FORBIDDEN = () => Object.keys(actions).filter((k) => typeof (actions as Record<string, unknown>)[k] === "function" && !["previewGrowerDraftAction", "getGrowerQuoteAction"].includes(k));

  it("Save draft keeps the step, and the live recalculation of an edit does too", async () => {
    await open({ view: snapshotView(true), step: "2" });
    await act(async () => { fireEvent.change(screen.getByLabelText(/^Total pens/), { target: { value: "21" } }); });
    expect(current()).toBe("site");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(screen.getByText("All changes saved")).toBeTruthy(), { timeout: 8000 });
    expect(current()).toBe("site");
  }, 30000);

  it("'Load sample measurements' (step 2) fills the room measurements only, keeps the step, warns before replacing entered values, and calls no action but the preview", async () => {
    await open({ view: snapshotView(true), step: "2", draftOver: { config: { ...goodConfig, lengthM: 0, widthM: 0, rooms: 1, totalPens: 0, hospitalPens: 0, pigsPerRoom: 0 } } });
    const forbidden = FORBIDDEN().map((k) => vi.spyOn(actions as never, k as never));
    const preview = vi.spyOn(actions, "previewGrowerDraftAction");
    expect(screen.getByText(/fills length, width, number of rooms/)).toBeTruthy(); // says what it populates
    fireEvent.click(screen.getByRole("button", { name: "Load sample measurements" })); // nothing entered: no confirmation needed
    expect(screen.queryByTestId("sample-confirm")).toBeNull();
    expect((screen.getByLabelText(/^Length/) as HTMLInputElement).value).toBe("49.5");
    expect((screen.getByLabelText(/^Site \/ project name/) as HTMLInputElement).value).toBe("Farm 1"); // site untouched
    expect(current()).toBe("site");
    await waitFor(() => expect(preview).toHaveBeenCalled(), { timeout: 5000 });
    await act(async () => { fireEvent.change(screen.getByLabelText(/^Length/), { target: { value: "60" } }); });
    fireEvent.click(screen.getByRole("button", { name: "Load sample measurements" })); // now values would be replaced
    expect(screen.getByTestId("sample-confirm").textContent).toContain("replaces the room measurements you have already entered");
    expect((screen.getByLabelText(/^Length/) as HTMLInputElement).value).toBe("60"); // not replaced yet
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect((screen.getByLabelText(/^Length/) as HTMLInputElement).value).toBe("60");
    fireEvent.click(screen.getByRole("button", { name: "Load sample measurements" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace values" }));
    expect((screen.getByLabelText(/^Length/) as HTMLInputElement).value).toBe("49.5");
    expect(current()).toBe("site");
    for (const f of forbidden) expect(f).not.toHaveBeenCalled(); // no save / submit / sign-off / approve / project
  }, 60000);

  it("'Load recommended configuration' (step 3) fills the equipment part only, keeps the step, and re-validates through the preview alone", async () => {
    await open({ view: snapshotView(true), step: "3" });
    const forbidden = FORBIDDEN().map((k) => vi.spyOn(actions as never, k as never));
    const preview = vi.spyOn(actions, "previewGrowerDraftAction");
    expect(screen.getByText(/fills the system selections, optional equipment, per-room quantities and quantity overrides/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Penning pig size"), { target: { value: "LARGE" } }); // an entry the recommendation would replace
    fireEvent.click(screen.getByRole("button", { name: "Load recommended configuration" }));
    expect(screen.getByTestId("sample-confirm")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace values" }));
    expect(current()).toBe("equipment");
    expect((screen.getByLabelText(/^Length/) as HTMLInputElement).value).toBe("49.5"); // measurements untouched
    await waitFor(() => expect(preview).toHaveBeenCalled(), { timeout: 5000 });
    expect(screen.getByTestId("sample-note").textContent).toContain("Recommended configuration loaded");
    for (const f of forbidden) expect(f).not.toHaveBeenCalled();
  }, 60000);

  it("the whole-quote loader exists ONLY in the collapsed Preview utility, loads without moving the step, and is absent in Production", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    await open({ view: snapshotView(true), step: "2" });
    const tools = screen.getByTestId("preview-tools") as HTMLDetailsElement;
    expect(tools.open).toBe(false);
    expect(tools.textContent).toContain("Testing utility (Preview only)");
    expect(tools.textContent).toMatch(/never submits, approves, signs off, creates a Project or writes to Cin7/);
    cleanup();
    vi.stubEnv("VERCEL_ENV", "production");
    await open({ view: snapshotView(true), step: "2" });
    expect(screen.queryByTestId("preview-tools")).toBeNull();
    expect(screen.queryByRole("button", { name: /whole demonstration quote/, hidden: true })).toBeNull();
    cleanup();
    vi.stubEnv("VERCEL_ENV", "");
    await open({ view: snapshotView(true), step: "2" });
    expect(screen.queryByTestId("preview-tools")).toBeNull(); // unknown environment: never
  }, 60000);
});

describe("server-derived previewTools flag", () => {
  it("getGrowerQuoteAction reports previewTools true on Preview only; false in Production, unset, or anything else", async () => {
    asRoles("REP");
    const { id } = await createQuote(db as never, ORG, "rep@nq");
    for (const [env, want] of [["preview", true], ["production", false], ["development", false], ["", false]] as const) {
      vi.stubEnv("VERCEL_ENV", env);
      const r = await actions.getGrowerQuoteAction(id);
      expect(r.data?.viewer.previewTools, env).toBe(want);
    }
  }, 30000);
});

describe("Submit to Estimator (step 5) and the moved Rep panels", () => {
  it("the default confirmer is the Stage 1 contact, shown read-only; 'someone else confirmed' stays but collapsed; the side effects are stated; the quote stays unsent until clicked", async () => {
    const send = vi.spyOn(actions, "sendGrowerQuoteToEstimatorAction");
    await open({ view: snapshotView(true), draftOver: readyDraft, step: "5" });
    const sub = panel("submit") as HTMLElement;
    await waitFor(() => expect(within(sub).getByTestId("confirmed-by-line")).toBeTruthy(), { timeout: 5000 });
    expect(within(sub).getByTestId("confirmed-by-line").textContent).toContain("Customer price confirmed by Sean <s@x.co>");
    expect((within(sub).getByTestId("alt-confirmer") as HTMLDetailsElement).open).toBe(false);
    expect(within(sub).getByText("Someone else confirmed the price")).toBeTruthy();
    expect(within(sub).getByTestId("submit-effects").textContent).toMatch(/records the customer.s price confirmation above, notifies the Estimator and moves the quotation to Estimator review. Any unsaved edits are saved first/);
    expect(within(sub).getByRole("button", { name: "Submit to Estimator" })).toBeTruthy();
    expect(send).not.toHaveBeenCalled();
  }, 30000);

  it("Quantities, Charges & assumptions and Exclusions are Stage 1 sub-sections of step 3; in Stage 2 (Rep draft) the same inputs are read-only, so nothing is entered twice, while the Estimator's mapping chooser stays", async () => {
    await open({ view: snapshotView(true), draftOver: readyDraft, step: "3" });
    const eq = panel("equipment") as HTMLElement;
    for (const t of ["Equipment selections", "Optional equipment", "Charges & assumptions", "Exclusions"]) expect(within(eq).getByText(t)).toBeTruthy();
    expect(within(eq).getByText(/^Quantities \(per room/)).toBeTruthy();
    expect(within(eq).getByTestId("optional-state-controller").textContent).toBe("✓ Included");
    expect(within(eq).getByTestId("optional-state-silo_weighing").textContent).toBe("Not included");
    expect(within(eq).getByRole("table", { name: "Quantities per room" })).toBeTruthy();
    cleanup();
    await open({ view: snapshotView(true), draftOver: readyDraft, stage: "2", roles: ["REP", "ESTIMATOR"], commercials: true });
    const charges = panel("charges") as HTMLElement;
    expect(within(charges).getByLabelText(/^Delivery/).matches(":disabled")).toBe(true);
    expect(within(charges).getAllByRole("checkbox", { hidden: true }).every((c) => c.matches(":disabled"))).toBe(true);
    expect(within(panel("lines") as HTMLElement).getByTestId("rep-owned-note")).toBeTruthy();
    expect(document.querySelector('[data-testid^="mapping-chooser-"]')).toBeTruthy(); // Estimator-owned mapping stays in Stage 2
  }, 60000);
});

describe("customer replacement states what it invalidates BEFORE confirming", () => {
  it("replacing the customer shows the contact / sign-off / revision consequences and a Cancel, and nothing is called until confirmed", async () => {
    await open({ view: snapshotView(true, { changeReturnsToRep: true }), step: "1" });
    const select = vi.spyOn(ca, "selectQuoteCustomerAction");
    vi.spyOn(ca, "searchQuoteCustomersForQuoteAction").mockResolvedValue({ ok: true, data: [{ name: "Other Farms Ltd", tradingName: "Other Farms", contactName: "Z", email: "z@o.co", currency: "ZAR" }] } as never);
    fireEvent.click(screen.getByRole("button", { name: "Change customer" }));
    fireEvent.change(screen.getByLabelText(/Search by name/), { target: { value: "Other" } });
    fireEvent.click(screen.getByRole("button", { name: "Search Cin7 customers" }));
    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    const effects = (await screen.findByTestId("replace-warning-effects")).textContent ?? "";
    expect(screen.getByTestId("replace-warning-title").textContent).toBe("Replace Acme Pigs (Pty) Ltd with Other Farms Ltd?");
    expect(effects).toMatch(/quotation contact and delivery email .* are dropped/);
    expect(effects).toMatch(/price confirmation and any Estimator sign-off are withdrawn/);
    expect(effects).toMatch(/returns to the Rep as a new revision/);
    expect(effects).toMatch(/measurements, equipment, quantities and prices you entered are kept/);
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("replace-warning-effects")).toBeNull();
  }, 30000);
});

describe("show all steps, persistence and roles", () => {
  it("Show all steps is remembered; a LOCKED step shows its heading and reason (never its fields); permitted steps show", async () => {
    const data: Record<string, string> = {};
    vi.stubGlobal("localStorage", { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } });
    await open({ view: snapshotView(true), draftOver: { siteName: "" } });
    fireEvent.click(screen.getByLabelText("Show all steps"));
    expect(data["nq-builder-show-all"]).toBe("1");
    for (const id of ["customer", "site"]) expect(shown(id), id).toBe(true);
    for (const id of ["equipment", "review", "submit"]) {
      expect(shown(id), id).toBe(true); // the section shows heading + reason only
      expect(screen.getByTestId(`panel-blocked-${id}`).textContent).toMatch(/^Locked\./);
    }
    const eq = panel("equipment") as HTMLElement;
    expect(eq.querySelector("[hidden][inert]")).not.toBeNull(); // the fields sit in a hidden, inert wrapper
    cleanup();
    await open({ view: snapshotView(true), draftOver: { siteName: "" } });
    await waitFor(() => expect((screen.getByLabelText("Show all steps") as HTMLInputElement).checked).toBe(true));
  }, 30000);

  it("renders correctly (guided) when storage throws", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    await open({ view: snapshotView(true) });
    expect(shown("site")).toBe(false);
    fireEvent.click(screen.getByLabelText("Show all steps"));
    expect(shown("site")).toBe(true);
  }, 30000);

  it("the save-state chip is one live region: 'All changes saved', then 'Unsaved changes' after an edit", async () => {
    await open({ view: snapshotView(true), step: "2" });
    const chip = screen.getByTestId("save-state");
    expect(chip.getAttribute("aria-live")).toBe("polite");
    expect(chip.textContent).toContain("All changes saved");
    await act(async () => { fireEvent.change(screen.getByLabelText(/^Length/), { target: { value: "50" } }); });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  }, 30000);

  it("if the customer details cannot be read, the wizard still opens (step 1 Needs attention) instead of waiting forever", async () => {
    asRoles("REP", "ESTIMATOR");
    await open({ waitSettled: false });
    cleanup();
    vi.spyOn(ca, "getQuoteCustomerAction").mockResolvedValue({ ok: false, error: "boom" } as never);
    const { default: Page } = await import("../[id]/page");
    render(createElement(Page));
    await waitFor(() => expect(status("customer")).toBe("Needs attention"), { timeout: 5000 });
    expect(screen.queryByTestId("stage1-shell")).toBeNull();
    expect(within(screen.getByTestId("step-rail")).getByText("Could not read the Cin7 customer details")).toBeTruthy();
  }, 30000);

  it("Estimator, Manager and an Administrator observer inspect Stage 1 READ-ONLY: every step opens (no locks), fields are disabled, and no cost leaks to a Rep", async () => {
    for (const [roles, commercials] of [[["ESTIMATOR"], true], [["MANAGER"], true], [[], true]] as Array<[Role[], boolean]>) {
      await open({ view: snapshotView(true), roles, commercials, draftOver: { siteName: "" } });
      expect(current()).toBe("review"); // a reader opens at the summary
      expect((screen.getByTestId("stage1-layout") as HTMLFieldSetElement).disabled, JSON.stringify(roles)).toBe(true);
      for (const id of ["customer", "site", "equipment", "review", "submit"]) expect(status(id), id).not.toBe("Locked");
      expect(screen.queryByRole("button", { name: "Load sample measurements", hidden: true })).toBeNull();
      expect(screen.queryByRole("button", { name: /^Edit /, hidden: true })).toBeNull(); // no Edit links for a reader
      expect((await screen.findByRole("button", { name: "Submit to Estimator", hidden: true })).hasAttribute("disabled")).toBe(true);
      cleanup();
    }
    await open({ view: snapshotView(true), roles: ["REP"], commercials: false });
    expect(document.body.textContent).not.toMatch(/Estimated cost|Internal margins|GP \(managers\)|Cin7 latest cost/);
  }, 90000);

  it("after submission Stage 1 is read-only with the submitted summary for everyone, nothing is locked, and the next owner is the Estimator", async () => {
    await open({ view: snapshotView(true), draftOver: readyDraft, row: { state: "ESTIMATOR_REVIEW", customer_confirmed_cents: 1000000000, customer_confirmed_by: "Sean", handoff_by_email: "rep@nq" }, roles: ["REP", "ESTIMATOR"] });
    expect(current()).toBe("submit");
    expect(screen.getByTestId("rep-complete").textContent).toContain("Rep preparation complete - next: Estimator");
    expect((screen.getByTestId("stage1-layout") as HTMLFieldSetElement).disabled).toBe(true);
    for (const id of ["customer", "site", "equipment", "review", "submit"]) expect(status(id)).not.toBe("Locked");
    expect(screen.queryByRole("button", { name: "Submit to Estimator" })).toBeNull();
  }, 30000);
});
