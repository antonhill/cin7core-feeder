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
import * as aa from "@/app/approvals/actions";

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

interface Opts { draftOver?: Record<string, unknown>; view?: any; roles?: Role[]; commercials?: boolean; step?: string; stage?: string; row?: Record<string, unknown>; customerDelay?: Promise<void>; waitSettled?: boolean; deliveryOk?: boolean }
async function open(o: Opts = {}) {
  asRoles(...(o.roles ?? ["REP", "ESTIMATOR"]));
  vi.mocked(canSeeCosts).mockResolvedValue(o.commercials ?? false);
  const spy = vi.spyOn(ca, "getQuoteCustomerAction");
  if (o.customerDelay) spy.mockImplementation((async () => { await o.customerDelay; return { ok: true, data: o.view ?? customerView() }; }) as never);
  else spy.mockResolvedValue({ ok: true, data: o.view ?? customerView() } as never);
  vi.spyOn(da, "getQuoteDeliveryAction").mockResolvedValue((o.deliveryOk ? { ok: true, data: { available: false } } : { ok: false, error: "n/a" }) as never);
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, { ...base, customerName: "Acme Pigs", siteName: "Farm 1", config: goodConfig, ...o.draftOver } as any);
  for (const row of db.rows("newquip_quotes") as Array<Record<string, unknown>>) if (row.id === id && o.row) Object.assign(row, o.row);
  g.__QID = id; g.__STEP = o.step; g.__STAGE = o.stage;
  const { default: Page } = await import("../[id]/page");
  render(createElement(Page));
  await waitFor(() => expect(screen.getByTestId(o.stage === "6" ? "stage-nav" : "step-rail")).toBeTruthy(), { timeout: 5000 });
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
    expect(screen.getByTestId("step-blocked-site").textContent).toBe("Rep: choose the Cin7 customer in step 1 (Customer & contact) first.");
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
    expect(next.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("next-blocked").textContent).toContain("step 2 (Site & measurements)");
    expect(next.getAttribute("aria-describedby")).toBe("next-why");
    // Trying to go on is the signal: the step's problems now show at the fields (D3), and the viewer has not moved.
    expect(screen.queryAllByTestId("field-error").length).toBe(0);
    fireEvent.click(next);
    expect(current()).toBe("site");
    expect(within(screen.getByLabelText(/^Site \/ project name/).closest("label")!).getByTestId("field-error").textContent).toBe("Site / project name is required.");
    fireEvent.change(screen.getByLabelText(/^Site \/ project name/), { target: { value: "Farm 1" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Next: Equipment & options" }).getAttribute("aria-disabled")).toBeNull());
    expect(submitSpy).not.toHaveBeenCalled();
  }, 30000);

  it("the Estimator-owned mapping is shown as a read-only row naming the owner, with no chooser, and does NOT lock the Rep's own steps", async () => {
    await open({ view: snapshotView(true), draftOver: { config: { ...readyDraft.config }, estimator: { ...readyDraft.estimator, confirmedMappings: {}, priceResolutions: {} } }, step: "3" });
    expect(current()).toBe("equipment");
    expect(document.querySelector('[data-testid^="mapping-chooser-"]')).toBeNull();
    const rows = screen.getAllByTestId(/^owner-row-/);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].textContent).toMatch(/^Estimator product choice needed: /);
    expect(status("review")).not.toBe("Locked"); // Estimator-owned work does not block the Rep from reviewing
    expect(status("submit")).not.toBe("Locked"); // S1a: the Rep submits with the Estimator's items open
  }, 30000);

  it("Review lists the missing information WITH its owner (Rep items link to the step; Estimator items are text only)", async () => {
    await open({ view: snapshotView(true), draftOver: { config: { ...readyDraft.config }, estimator: { ...readyDraft.estimator, confirmedMappings: {}, priceResolutions: {} } }, step: "4" });
    const issues = screen.getByTestId("stage1-review-issues");
    const tags = within(issues).getAllByTestId("owner-tag").map((t) => t.textContent);
    expect(tags).toContain("Estimator");
    // Estimator-owned items are GROUPED (one row, owner named once) with an expandable list, and there is nothing for the Rep to click.
    expect(within(issues).getAllByTestId("est-mappings-group").length).toBe(1);
    expect(within(issues).getByTestId("est-mappings-group").textContent).toMatch(/Awaiting the Estimator: \d+ product choices?, \d+ prices?\./);
    expect(within(issues).getAllByText(/They do not stop you submitting/).length).toBe(1);
    expect(within(issues).queryByRole("button", { name: /Estimator mapping|Go to step/ })).toBeNull();
    expect(screen.getByTestId("review-next").textContent).toMatch(/^Everything you can do is complete - submit to the Estimator \(step 5\)\. \d+ items? will be resolved by the Estimator afterwards\./);
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

  it("ROUND 4 (#176 behaviour, re-asserted after #185): a garbage, zero or negative ?step= falls back to the entry step, exactly like an out-of-range one", async () => {
    for (const bad of ["abc", "0", "-3", "1.5"]) {
      await open({ view: snapshotView(true), step: bad });
      expect(current(), `?step=${bad}`).toBe("customer");
      cleanup();
    }
  }, 90000);

  it("ROUND 4: with unsaved edits there is still ONE contact chooser (step 1) and no 'Choose the contact' leave-page link anywhere, so no leave-page confirm can be raised by it", async () => {
    await open({ view: snapshotView(true), step: "2" });
    fireEvent.change(screen.getByLabelText(/^Site \/ project name/), { target: { value: "Changed (unsaved)" } });
    await waitFor(() => expect(screen.getByTestId("save-state").textContent).toContain("Unsaved"));
    expect(screen.queryByRole("link", { name: /Choose the contact/ })).toBeNull();
    expect(screen.getAllByRole("group", { name: "Quotation contact", hidden: true }).length).toBe(1);
  }, 30000);

  it("a RETURNED quotation (Rep draft, revision 2) shows the banner with the approval-history disclosure and opens at the first incomplete step", async () => {
    await open({ view: snapshotView(true), draftOver: { siteName: "" }, row: { revision: 2 } });
    const banner = screen.getByTestId("returned-banner");
    expect(banner.textContent).toContain("Returned to the Rep (revision 2)");
    expect(banner.textContent).toContain("Returned by the Estimator/Manager - see Approval history");
    expect(within(banner).getByText("Show the full approval history")).toBeTruthy();
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
    expect(screen.getByText(/REPLACES every quantity you entered, the quantity overrides and their reasons/)).toBeTruthy();
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
    expect(tools.closest('[data-testid="audit-details"]')).toBeNull(); // a testing control is not audit evidence: it is reachable in one click, outside the Audit details
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
    expect(within(sub).getByText("Price confirmed by someone other than the quotation contact (optional)")).toBeTruthy();
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
    // UX-006i2: Stage 2 has NO Rep controls at all (no Charges / Exclusions panels, no editable quantity); the Rep's values are only in the read-only summary.
    expect(panel("charges")).toBeNull();
    expect(screen.queryByLabelText(/^Delivery/)).toBeNull();
    expect(screen.queryByText("Customer-driven exclusions")).toBeNull();
    expect(within(panel("mapping") as HTMLElement).getByTestId("rep-owned-note")).toBeTruthy();
    expect(screen.getByTestId("rep-summary")).toBeTruthy();
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

  it("ROUND 4: Show all steps keeps the declared step ORDER (rail buttons and panels) and reveals every step the viewer may see", async () => {
    await open({ view: snapshotView(true) });
    fireEvent.click(screen.getByLabelText("Show all steps"));
    const rail = [...document.querySelectorAll("[data-step]")].map((e) => e.getAttribute("data-step"));
    const declared = ["customer", "site", "equipment", "review", "submit"].filter((id) => rail.includes(id));
    expect(rail.filter((id) => declared.includes(id as string))).toEqual(declared);
    for (const id of declared) expect(shown(id), id).toBe(true);
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

// ── Real-browser findings on #185 @61fa036 (level 2), each fixed with a test ──
const viewing = () => document.querySelector('[data-stage][aria-current="step"]')!.getAttribute("data-stage");
const noMapDraft = () => ({ config: { ...readyDraft.config }, estimator: { ...readyDraft.estimator, confirmedMappings: {}, priceResolutions: {} } });

describe("P1-1: the landing stage and entry step are role-aware (no ?stage=)", () => {
  it("a Rep on a READY, unsubmitted Rep draft lands on Stage 1 step 5 (Submit), the card says 'Ready to submit' (never 'Complete') and the next-action line says what the Rep does", async () => {
    await open({ view: snapshotView(true), draftOver: readyDraft, stage: "" });
    expect(viewing()).toBe("1");
    expect(current()).toBe("submit");
    const card = document.querySelector('[data-stage="1"]')!;
    expect(card.textContent).toContain("Ready to submit");
    expect(card.textContent).not.toContain("Complete");
    expect(screen.getByTestId("next-action").textContent).toContain("Rep: submit to the Estimator (Stage 1, step 5).");
  }, 30000);

  it("a returned quotation opens on Stage 1 at the first incomplete step", async () => {
    await open({ view: snapshotView(true), draftOver: { ...readyDraft, siteName: "" }, row: { revision: 2 }, stage: "" });
    expect(viewing()).toBe("1");
    expect(current()).toBe("site");
  }, 30000);

  it("a Rep whose own steps are done but who waits on Estimator mappings lands on Stage 1 and is told nothing is left for them", async () => {
    await open({ view: snapshotView(true), draftOver: noMapDraft(), stage: "" });
    expect(viewing()).toBe("1");
        expect(screen.getByTestId("next-action").textContent).toMatch(/will be resolved by the Estimator after you submit/);
    expect(document.querySelector('[data-stage="1"]')!.textContent).toContain("Ready to submit");
  }, 30000);

  it("an Estimator-only viewer on a Rep draft with Estimator-owned mapping lands on Stage 2; without such work as before (Stage 1)", async () => {
    await open({ view: snapshotView(true), draftOver: noMapDraft(), roles: ["ESTIMATOR"], commercials: true, stage: "" });
    await waitFor(() => expect(viewing()).toBe("2"));
    expect(document.querySelector('[data-stage="1"]')!.textContent).not.toContain("Ready to submit"); // never for others
  }, 30000);
});

describe("P1-2: inline validation at the field", () => {
  it("a fresh blank form does not shout; a touched field shows a human message under it with aria-invalid and aria-describedby; leaving the step shows the rest", async () => {
    await open({ view: snapshotView(true), draftOver: { siteName: "", config: { ...goodConfig, lengthM: 0 } }, step: "2" });
    expect(screen.queryAllByTestId("field-error").length).toBe(0);
    const site = screen.getByLabelText(/^Site \/ project name/) as HTMLInputElement;
    expect(site.getAttribute("aria-invalid")).toBeNull();
    fireEvent.blur(site);
    const err = within(site.closest("label")!).getByTestId("field-error");
    expect(err.textContent).toBe("Site / project name is required.");
    expect(site.getAttribute("aria-invalid")).toBe("true");
    expect(site.getAttribute("aria-describedby")).toBe(err.id);
    const len = screen.getByLabelText(/^Length/);
    expect(len.getAttribute("aria-invalid")).toBeNull(); // not touched yet
    fireEvent.click(screen.getByRole("button", { name: "Back" })); // leaving the step = trying to proceed
    expect(len.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(len.getAttribute("aria-describedby")!)!.textContent).toBe("Length must be greater than zero."); // human label, not "lengthM"
    expect(document.body.textContent).not.toMatch(/lengthM|widthM/);
    fireEvent.change(len, { target: { value: "49.5" } });
    await waitFor(() => expect(len.getAttribute("aria-invalid")).toBeNull());
  }, 30000);

  it("a missing penning pig size shows at the select once touched", async () => {
    await open({ view: snapshotView(true), draftOver: { config: { ...goodConfig, penningPigSize: null } }, step: "3" });
    expect(screen.queryAllByTestId("field-error").length).toBe(0);
    const sel = screen.getByLabelText("Penning pig size");
    fireEvent.blur(sel);
    expect(sel.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(sel.getAttribute("aria-describedby")!)!.textContent).toBe("Choose the penning pig size.");
  }, 30000);
});

describe("P1-3: every control on every Stage 1 step has an accessible name", () => {
  const nameOf = (el: Element): string => {
    const lab = (el as HTMLInputElement).labels ? [...((el as HTMLInputElement).labels ?? [])].map((l) => l.textContent ?? "").join(" ") : "";
    const by = (el.getAttribute("aria-labelledby") ?? "").split(" ").map((i) => document.getElementById(i)?.textContent ?? "").join(" ");
    const own = el.tagName === "BUTTON" || el.tagName === "SUMMARY" ? el.textContent ?? "" : "";
    return (el.getAttribute("aria-label") ?? "") + lab + by + own + (el.getAttribute("title") ?? "");
  };
  it.each([["REP", ["REP", "ESTIMATOR"] as Role[], false], ["observer", [] as Role[], true]])("%s (all steps mounted, show-all)", async (_n, roles, comm) => {
    vi.stubGlobal("localStorage", { getItem: () => "1", setItem: () => undefined });
    await open({ view: snapshotView(true), draftOver: readyDraft, roles, commercials: comm });
    const bad = [...document.querySelectorAll('[data-step-panel] input:not([type="hidden"]), [data-step-panel] select, [data-step-panel] textarea, [data-step-panel] button, [data-step-panel] summary')].filter((el) => nameOf(el).trim() === "").map((el) => `${el.tagName}:${el.getAttribute("placeholder") ?? el.className.slice(0, 30)}`);
    expect(bad).toEqual([]);
    expect(screen.getAllByLabelText(/^Quantity override for /).length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText(/^Exclusion reason for /).length).toBeGreaterThan(0);
  }, 30000);
});

describe("P2 fixes", () => {
  it("(a) the Rep reads 'Quantity needed' on quantities the Rep must enter, never 'Estimator input required'", async () => {
    await open({ view: snapshotView(true), step: "3" });
    const t = (panel("equipment") as HTMLElement).textContent ?? "";
    expect(t).toContain("QUANTITY NEEDED");
    expect(t).toContain("Quantity needed:");
    expect(t).not.toMatch(/ESTIMATOR INPUT REQUIRED|Estimator input required/);
  }, 30000);

  it("(b) the sample note clears on a step change; the save message mentions sign-off only when one was withdrawn", async () => {
    await open({ view: snapshotView(true), step: "2", draftOver: { config: { ...goodConfig, lengthM: 0 } } });
    fireEvent.click(screen.getByRole("button", { name: "Load sample measurements" }));
    expect(screen.getByTestId("sample-note")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByTestId("sample-note")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(screen.getByText("Draft saved.")).toBeTruthy(), { timeout: 8000 });
    expect(document.body.textContent).not.toMatch(/sign-off made on earlier content/);
  }, 30000);

  it("(c) the unsaved note says nothing about costs or margins to a viewer who cannot see them", async () => {
    await open({ view: snapshotView(true), step: "2" });
    await act(async () => { fireEvent.change(screen.getByLabelText(/^Length/), { target: { value: "50" } }); });
    expect(screen.getByTestId("unsaved-note").textContent).toMatch(/quantities, prices and totals are a live preview/);
    expect(screen.getByTestId("unsaved-note").textContent).not.toMatch(/cost|margin/i);
  }, 30000);

  it("(e) the breadcrumb link and the optional-equipment rows have 44px hit areas", async () => {
    await open({ view: snapshotView(true), step: "3" });
    expect(screen.getByRole("link", { name: /Solution Builder quotes/ }).className).toContain("min-h-11");
    const label = screen.getByTestId("optional-state-controller").closest("label")!;
    expect(label.className).toContain("min-h-11");
    expect(label.querySelector("input")!.className).toContain("size-6");
  }, 30000);

  it("(f) Cancel on the replace-customer warning returns to the current customer view (search closed)", async () => {
    await open({ view: snapshotView(true), step: "1" });
    vi.spyOn(ca, "searchQuoteCustomersForQuoteAction").mockResolvedValue({ ok: true, data: [{ name: "Other", tradingName: null, contactName: null, email: null, currency: null }] } as never);
    fireEvent.click(screen.getByRole("button", { name: "Change customer" }));
    fireEvent.change(screen.getByLabelText(/Search by name/), { target: { value: "Other" } });
    fireEvent.click(screen.getByRole("button", { name: "Search Cin7 customers" }));
    fireEvent.click(await screen.findByRole("button", { name: "Select" }));
    await screen.findByTestId("replace-warning-effects");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText(/Search by name/)).toBeNull();
    expect(screen.getByRole("button", { name: "Change customer" })).toBeTruthy();
    expect(screen.getByTestId("customer-title").textContent).toBe("Acme Pigs");
  }, 30000);

  it("(g) the quotation-only contact says it is audited and not written to Cin7", async () => {
    await open({ view: snapshotView(true), step: "1" });
    fireEvent.click(screen.getByRole("button", { name: /Quotation-only contact/ }));
    expect(screen.getByText(/recorded in the audit trail and used on this quotation only; it is not written to Cin7/)).toBeTruthy();
  }, 30000);

  it("(i) 'price confirmed by someone else' is a collapsed, clearly-labelled optional confirmer (not a delivery contact), and keeps its function", async () => {
    await open({ view: snapshotView(true), draftOver: readyDraft, step: "5" });
    const sub = panel("submit") as HTMLElement;
    const d = (await within(sub).findByTestId("alt-confirmer")) as HTMLDetailsElement;
    expect(d.open).toBe(false);
    expect(d.textContent).toContain("Price confirmed by someone other than the quotation contact (optional)");
    expect(d.textContent).toMatch(/does not change who the quotation is sent to/);
    expect(d.textContent).toContain("Another Cin7 contact:"); // functionality kept, inside the disclosure only
    expect(within(sub).getAllByRole("radio", { hidden: true }).every((r) => d.contains(r))).toBe(true);
  }, 30000);
});

// ── Fresh independent UX review (level 2) ──
describe("review findings: say it up front, charges first, explicit confirmation, inline return reason", () => {
  it("P0: the first screen says up front that an Estimator maps and prices some products (with a collapsible Why?), without inventing any data", async () => {
    await open({ view: customerView(), step: "1" });
    const note = screen.getByTestId("estimator-note");
    expect(note.textContent).toContain("Some products must be mapped and priced by an Estimator before this quotation can be submitted - you can finish your part first; we will show exactly what is waiting on them.");
    expect(within(note).getByText("Why?")).toBeTruthy();
    expect((note.querySelector("details") as HTMLDetailsElement).open).toBe(false);
  }, 30000);

  it("P1: Charges & assumptions come BEFORE the long quantities table, say who supplies each value, the M75 price is not labelled 'estimator input', and the charge inputs have distinct names", async () => {
    await open({ view: snapshotView(true), draftOver: readyDraft, step: "3" });
    const eq = panel("equipment") as HTMLElement;
    const titles = [...eq.querySelectorAll("h2 ~ * [class*=uppercase], h2 ~ div [class*=uppercase]")].map((e) => e.textContent ?? "");
    const text = eq.textContent ?? "";
    expect(text.indexOf("Charges & assumptions")).toBeGreaterThan(-1);
    expect(text.indexOf("Charges & assumptions")).toBeLessThan(text.indexOf("Quantities (per room"));
    expect(titles.length).toBeGreaterThan(0);
    expect(text).toMatch(/Usually supplied by the courier or haulier quote/);
    expect(text).toContain("M75 system price (per system)");
    expect(text).not.toMatch(/Estimator input by design|Entered by hand by design/);
    expect(within(eq).getByLabelText("Delivery charge (R ex VAT)")).toBeTruthy();
    expect(within(eq).getByLabelText("Installation charge (R ex VAT)")).toBeTruthy();
  }, 30000);

  it("P1: Submit needs an explicit tick 'I confirm that <contact> has confirmed the quotation total of <amount> ex VAT'; choosing someone else resets it; the action is not called before the tick", async () => {
    const send = vi.spyOn(actions, "sendGrowerQuoteToEstimatorAction");
    await open({ view: snapshotView(true), draftOver: readyDraft, step: "5" });
    const sub = panel("submit") as HTMLElement;
    const btn = (await within(sub).findByRole("button", { name: "Submit to Estimator" })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(document.getElementById("send-estimator-why")!.textContent).toBe("Tick the confirmation above to enable Submit to Estimator.");
    const tick = within(sub).getByLabelText(/I confirm that Sean has confirmed the quotation total of R.*ex VAT/) as HTMLInputElement;
    expect(within(sub).getByTestId("confirm-ack").textContent).toMatch(/R\s?[\d\s]+,\d\d/); // the shared money format
    fireEvent.click(tick);
    await waitFor(() => expect(btn.disabled).toBe(false));
    // a different confirmer clears the tick
    const alt = within(sub).getByTestId("alt-confirmer") as HTMLDetailsElement;
    alt.open = true;
    fireEvent.click(within(sub).getByLabelText(/Another Cin7 contact: Thandi/));
    await waitFor(() => expect((within(sub).getByLabelText(/I confirm that Thandi has confirmed/) as HTMLInputElement).checked).toBe(false));
    expect(btn.disabled).toBe(true);
    expect(send).not.toHaveBeenCalled();
  }, 30000);

  it("P1: a returned quotation shows the latest return reason, who and when INLINE (no click), with a plain next action; entry stays at the first incomplete step", async () => {
    vi.spyOn(aa, "getDocumentApprovalAction").mockResolvedValue({ ok: true, data: { available: true, latest: null, history: [
      { id: "e1", action: "SUBMIT", to_status: "PENDING", reason: null, actor_email: "rep@nq", actor_name: null, created_at: "2026-11-01T08:00:00Z" },
      { id: "e2", action: "RETURN", to_status: "RETURNED", reason: "Delivery cost is wrong; check the haulier quote", actor_email: "est@nq", actor_name: "Esther Estimator", created_at: "2026-11-02T09:30:00Z" },
    ] } } as never);
    await open({ view: snapshotView(true), draftOver: { siteName: "" }, row: { revision: 2 } });
    const reason = await screen.findByTestId("return-reason");
    expect(reason.textContent).toContain("Returned by Esther Estimator");
    expect(reason.textContent).toContain("Delivery cost is wrong; check the haulier quote");
    expect(screen.getByTestId("returned-banner").textContent).toContain("Fix what the Estimator described, then submit again.");
    expect(current()).toBe("site");
  }, 30000);

  it("P1: when the approval history is unavailable the banner keeps its fixed text", async () => {
    vi.spyOn(aa, "getDocumentApprovalAction").mockResolvedValue({ ok: false, error: "x" } as never);
    await open({ view: snapshotView(true), draftOver: { siteName: "" }, row: { revision: 2 } });
    expect(screen.queryByTestId("return-reason")).toBeNull();
    expect(screen.getByTestId("returned-banner").textContent).toContain("Returned by the Estimator/Manager - see Approval history");
  }, 30000);

  it("P1: customer search says 'Type at least 2 characters to search' and 'No customers found for <query>'", async () => {
    await open({ view: customerView(), step: "1" });
    expect(screen.getByTestId("search-min").textContent).toBe("Type at least 2 characters to search.");
    vi.spyOn(ca, "searchQuoteCustomersForQuoteAction").mockResolvedValue({ ok: true, data: [] } as never);
    fireEvent.change(screen.getByLabelText(/Search by name/), { target: { value: "zzz" } });
    expect(screen.queryByTestId("search-min")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Search Cin7 customers" }));
    expect((await screen.findByTestId("no-customer-results")).textContent).toContain("No customers found for “zzz”.");
  }, 30000);
});

describe("review findings P2", () => {
  it("the lock reason is derived from CURRENT state: with a snapshot selected but no contact it asks for the contact, never 'choose the customer'; a blank draft name does not make a selected customer 'missing'", async () => {
    await open({ view: snapshotView(false), draftOver: { customerName: "" } });
    expect(screen.getByTestId("step-blocked-site").textContent).toBe("Rep: choose the quotation contact in step 1 (Customer & contact) first.");
    cleanup();
    await open({ view: snapshotView(true), draftOver: { customerName: "" } });
    expect(status("site")).not.toBe("Locked");
  }, 60000);

  it("the calculation badge reads 'In progress' (neutral), not 'BLOCKED', on an unfinished Stage 1 draft", async () => {
    await open({ view: snapshotView(true), step: "2" });
    const bar = screen.getByTestId("quote-summary-bar");
    expect(within(bar).getByText("In progress")).toBeTruthy();
    expect(bar.textContent).not.toMatch(/BLOCKED|DRAFT/);
  }, 30000);

  it("inside a step the six stage cards collapse to one line, expandable; the cards stay in the DOM", async () => {
    await open({ view: snapshotView(true), step: "2" });
    const toggle = screen.getByTestId("stage-nav-toggle");
    expect(toggle.textContent).toContain("Stage 1 of 6 · Configuration");
    expect(toggle.textContent).toContain("Show all stages");
    expect(document.getElementById("stage-nav-list")!.className).toContain("hidden");
    fireEvent.click(toggle);
    expect(document.getElementById("stage-nav-list")!.className).not.toMatch(/(^|\s)hidden/);
    expect(document.querySelectorAll("[data-stage]").length).toBe(6);
  }, 30000);

  it("'Load recommended configuration' states precisely what it replaces and keeps", async () => {
    await open({ view: snapshotView(true), step: "3" });
    const t = screen.getByText(/Load recommended configuration” fills/).textContent ?? "";
    expect(t).toMatch(/REPLACES every quantity you entered, the quantity overrides and their reasons/);
    expect(t).toMatch(/keeps the site, room measurements, charges, M75 price, assumptions, product choices and manual prices/);
  }, 30000);
});

// ── Second independent UX review (level 2) ──
describe("P0: a Rep changing a product-affecting control (the server refuses; presentation only)", () => {
  it("warns beside the control, and when Save is refused says what to do at the control and at Save, offers Undo, marks the step Needs attention and names the Estimator in the stage line", async () => {
    await open({ view: snapshotView(true), draftOver: readyDraft, roles: ["REP"], step: "3" });
    expect(screen.getAllByText(/Changing this needs an Estimator to confirm the product afterwards\./).length).toBe(2); // beside the feeder variant and beside the optional equipment
    expect(status("equipment")).toBe("Complete");
    const sel = screen.getByLabelText(/CCM feeder variant/) as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "WINDOW" } });
    expect(status("equipment")).toBe("Needs attention"); // never 'Complete' with an unsaved product change
    expect(document.getElementById(sel.getAttribute("aria-describedby")!)!.textContent).toContain("This change needs an Estimator to confirm the new product.");
    expect(screen.getByTestId("next-action").textContent).toContain("Waiting on the Estimator for 1 product choice");
    fireEvent.click(screen.getByRole("button", { name: "Save draft" })); // the REAL server action refuses a mapping change by a non-mapper
    await waitFor(() => expect(screen.getByTestId("product-change-refused")).toBeTruthy(), { timeout: 8000 });
    const full = () => [...document.querySelectorAll('[role="alert"]')].filter((e) => (e.textContent ?? "").includes("This change needs an Estimator to confirm the new product."));
    expect(full().length).toBe(1); // the full message appears ONCE (at the control, role=alert) ...
    expect(full()[0].closest("label, div")!.contains(sel) || document.getElementById(sel.getAttribute("aria-describedby")!)).toBeTruthy();
    expect(screen.getByTestId("product-change-refused").textContent).toBe("1 change needs an Estimator - see Equipment (step 3)."); // ... elsewhere only a short reference
    expect(document.body.textContent).not.toContain("Only an Estimator or Manager can map a product.");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo this change" }));
    expect(sel.value).toBe("STANDARD");
    expect(status("equipment")).toBe("Complete");
    expect(screen.queryByTestId("product-change-refused")).toBeNull();
    expect(full().length).toBe(0);
    expect(document.querySelectorAll('[role="alert"][data-kind="error"]').length).toBe(0); // the stale save error is gone too
    expect(screen.getByTestId("save-state").textContent).toContain("All changes saved"); // the draft equals the saved one again
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  }, 60000);

  it("an Estimator-capable user changing the variant sees no such warning (they may map)", async () => {
    await open({ view: snapshotView(true), draftOver: readyDraft, roles: ["REP", "ESTIMATOR"], step: "3" });
    expect(screen.queryByText(/Changing this needs an Estimator/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/CCM feeder variant/), { target: { value: "WINDOW" } });
    expect(screen.queryByTestId("product-change-refused")).toBeNull();
  }, 30000);
});

describe("second review: chrome, saving rules, up-front note, step 3 disclosure", () => {
  it("price source / provenance sits in one collapsed disclosure; the save row and show-all share the step toolbar; the saving rule is stated once", async () => {
    await open({ view: snapshotView(true), step: "2" });
    const audit = screen.getByTestId("audit-details") as HTMLDetailsElement;
    expect(audit.open).toBe(false);
    expect(audit.querySelector("summary")!.textContent).toBe("Audit details");
    const prov = screen.getByTestId("provenance");
    expect(audit.contains(prov)).toBe(true);
    expect(prov.textContent).toContain("Price source & provenance");
    expect(prov.textContent).toContain("Grower House Template v1");
    const rail = screen.getByTestId("step-rail");
    expect(within(rail).getByRole("button", { name: "Save draft" })).toBeTruthy();
    expect(within(rail).getByLabelText("Show all steps")).toBeTruthy();
    expect(screen.getAllByTestId("saving-rules").length).toBe(1);
    expect(screen.getByTestId("saving-rules").textContent).toBe("Customer and contact save as you choose them. Everything else saves when you press Save draft.");
  }, 30000);

  it("the up-front note also says the customer must confirm the total; the Estimator part goes away once nothing is waiting on the Estimator", async () => {
    await open({ view: customerView(), step: "1" });
    expect(screen.getByTestId("estimator-note").textContent).toContain("The customer must also confirm the quotation total with you before you submit (you record this at the last step).");
    expect(screen.getByTestId("estimator-note").textContent).toContain("mapped and priced by an Estimator");
    cleanup();
    await open({ view: snapshotView(true), draftOver: readyDraft, step: "1" });
    expect(screen.getByTestId("estimator-note").textContent).not.toContain("mapped and priced by an Estimator");
    expect(screen.getByTestId("estimator-note").textContent).toContain("The customer must also confirm");
  }, 60000);

  it("the stage line lists the top open items in plain words (max 3 + N more)", async () => {
    await open({ view: snapshotView(true), step: "3" });
    const t = screen.getByTestId("next-action").textContent ?? "";
    expect(t).toMatch(/Still to do: .*enter the (quantity|amount)/);
    expect(t).not.toMatch(/readiness/i);
    expect(t).toMatch(/\(\+\d+ more - see Review, step 4\)/);
  }, 30000);

  it("step 3 sections: Quantities / Charges / Exclusions are collapsible with a status chip, open only when they need attention; the content stays mounted", async () => {
    await open({ view: snapshotView(true), step: "3" });
    const q = screen.getByTestId("section-quantities") as HTMLDetailsElement;
    expect(q.open).toBe(true);
    expect(q.textContent).toMatch(/\d+ to enter - needs attention/);
    expect((screen.getByTestId("section-exclusions") as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByTestId("section-exclusions").textContent).toContain("None excluded");
    cleanup();
    await open({ view: snapshotView(true), draftOver: readyDraft, step: "3" });
    for (const id of ["section-quantities", "section-charges"]) { const d = screen.getByTestId(id) as HTMLDetailsElement; expect(d.open, id).toBe(false); expect(d.textContent, id).toContain("Complete"); }
    expect(screen.getByTestId("section-quantities").querySelector("table")).not.toBeNull(); // still mounted while closed
    fireEvent.click(screen.getByTestId("section-quantities").querySelector("summary")!);
  }, 60000);

  it("'Load recommended configuration' sets the penning pig size and says so", async () => {
    await open({ view: snapshotView(true), step: "3", draftOver: { config: { ...goodConfig, penningPigSize: null } } });
    expect(screen.getByText(/Load recommended configuration” fills/).textContent).toContain("including the penning pig size");
    fireEvent.click(screen.getByRole("button", { name: "Load recommended configuration" }));
    if (screen.queryByRole("button", { name: "Replace values" })) fireEvent.click(screen.getByRole("button", { name: "Replace values" }));
    expect((screen.getByLabelText("Penning pig size") as HTMLSelectElement).value).toBe("SMALL");
  }, 30000);

  it("Enter in the customer search does nothing below 2 characters", async () => {
    await open({ view: customerView(), step: "1" });
    const search = vi.spyOn(ca, "searchQuoteCustomersForQuoteAction");
    const input = screen.getByLabelText(/Search by name/);
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(search).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Search Cin7 customers" }) as HTMLButtonElement).disabled).toBe(true);
  }, 30000);

  it("when the wizard opens with nothing focused, focus moves to the step heading", async () => {
    await open({ view: snapshotView(true) });
    await waitFor(() => expect(document.activeElement?.tagName).toBe("H2"));
  }, 30000);
});

// ── Regression e2e findings ──
describe("regression: customer search state and the second 'Load recommended configuration'", () => {
  it("D-1: reopening 'Change customer' starts with an empty search, no stale 'No customers found', and closing/cancelling resets it", async () => {
    await open({ view: snapshotView(true), step: "1" });
    vi.spyOn(ca, "searchQuoteCustomersForQuoteAction").mockResolvedValue({ ok: true, data: [] } as never);
    fireEvent.click(screen.getByRole("button", { name: "Change customer" }));
    fireEvent.change(screen.getByLabelText(/Search by name/), { target: { value: "Fixture" } });
    fireEvent.click(screen.getByRole("button", { name: "Search Cin7 customers" }));
    expect((await screen.findByTestId("no-customer-results")).textContent).toContain("No customers found for “Fixture”.");
    fireEvent.click(screen.getByRole("button", { name: "Keep current customer" }));
    fireEvent.click(screen.getByRole("button", { name: "Change customer" }));
    expect((screen.getByLabelText(/Search by name/) as HTMLInputElement).value).toBe("");
    expect(screen.queryByTestId("no-customer-results")).toBeNull();
    expect(screen.getByTestId("search-min")).toBeTruthy();
  }, 30000);

  it("D-2: pressing 'Load recommended configuration' again over edited quantities asks Replace / Cancel; Cancel keeps the values; the step is preserved", async () => {
    await open({ view: snapshotView(true), step: "3", draftOver: { config: { ...goodConfig, penningPigSize: null } } });
    fireEvent.click(screen.getByRole("button", { name: "Load recommended configuration" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace values" })); // the fixture already holds some equipment values (running metres), so the first load asks too
    const qty = screen.getByLabelText("Quantity per room for CCM feeder (incl. monoflo drinking nipples)") as HTMLInputElement;
    expect(qty.value).toBe("18");
    await act(async () => { fireEvent.change(qty, { target: { value: "7" } }); });
    fireEvent.click(screen.getByRole("button", { name: "Load recommended configuration" }));
    expect(screen.getByTestId("sample-confirm")).toBeTruthy();
    expect(current()).toBe("equipment");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(qty.value).toBe("7");
    fireEvent.click(screen.getByRole("button", { name: "Load recommended configuration" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace values" }));
    expect((screen.getByLabelText("Quantity per room for CCM feeder (incl. monoflo drinking nipples)") as HTMLInputElement).value).toBe("18");
    expect(current()).toBe("equipment");
  }, 30000);

  it("the toolbar does not overflow at 390px (static class contract: every toolbar child may wrap or shrink)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(`${__dirname}/../[id]/page.tsx`, "utf8");
    // (intent preserved: the toolbar wraps; it now lives in StepRail's moreActions/actions row so a phone can tuck the secondary items into the collapsed list)
    expect(readFileSync(`${__dirname}/../../../components/ui/StepRail.tsx`, "utf8")).toContain('<div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">'); // the toolbar wraps
    expect(src).toContain('flex flex-wrap items-center gap-3 ${cls}'); // the save row wraps
    const sections = readFileSync(`${__dirname}/../[id]/RepConfigSections.tsx`, "utf8");
    expect(sections).toContain("min-w-0 max-w-full"); // the collapsible chip and table wrapper cannot widen the page
  });
});

// ── Corrections round, phase 1 ──
const LEAK = /landed|mark-?up|\b20%|\bROE\b|Freight/i;
const BASELINE = { contractCents: 1000000, internalMargin: null, template: { name: "Grower", version: "1", rulesetVersion: "1" }, quote: { revision: 1 }, pricing: { source: { label: "test" }, basis: "Landed cost (Cost × ROE × Freight) + 20% markup", quoteType: "project" }, overrides: [], exclusions: [], priceResolutions: [] };

describe("D-4: a Rep never reads the cost basis or markup", () => {
  it("no 'landed', 'markup', '20%', 'ROE' or 'Freight' anywhere on the Rep's Stage 1 (all steps shown) or Stage 2", async () => {
    vi.stubGlobal("localStorage", { getItem: () => "1", setItem: () => undefined });
    await open({ view: snapshotView(true), draftOver: { ...readyDraft, quoteType: "project" }, roles: ["REP"] });
    expect((document.body.textContent ?? "").match(new RegExp(".{40}(" + LEAK.source + ").{40}", "i"))?.[0] ?? "").toBe("");
    const opts = [...document.querySelectorAll('select option')].map((o) => o.textContent);
    expect(opts).toContain("Project pricing");
    expect(opts).toContain("Standard price list basis");
    cleanup();
    await open({ view: snapshotView(true), draftOver: { ...readyDraft, quoteType: "project" }, roles: ["REP"], stage: "2" });
    expect(document.body.textContent).not.toMatch(LEAK);
  }, 60000);

  it("the accepted-baseline summary (Stage 6) shows a Rep the quotation type only; a cost-visible Manager keeps the detailed basis", async () => {
    const final = { state: "MANAGER_APPROVED_FINAL", requires_customer_acceptance: false, customer_confirmed_cents: 1, accepted_baseline: BASELINE };
    await open({ view: snapshotView(true), draftOver: { ...readyDraft, quoteType: "project" }, roles: ["REP"], stage: "6", row: final, deliveryOk: true });
    await screen.findByText("Accepted commercial baseline (frozen)");
    expect(document.body.textContent).not.toMatch(LEAK);
    expect(document.body.textContent).toContain("Pricing basisProject pricing");
    cleanup();
    await open({ view: snapshotView(true), draftOver: { ...readyDraft, quoteType: "project" }, roles: ["MANAGER"], commercials: true, stage: "6", row: final, deliveryOk: true });
    await screen.findByText("Accepted commercial baseline (frozen)");
    expect(document.body.textContent).toMatch(/Landed cost \(Cost × ROE × Freight\) \+ 20% markup/);
  }, 60000);

  it("the neutral labels name the type without any basis", async () => {
    const { QUOTE_TYPE_NEUTRAL } = await import("@/newquip/grower/pricing-source");
    expect(Object.values(QUOTE_TYPE_NEUTRAL).join(" ")).not.toMatch(LEAK);
  });
});

describe("touch targets on the primary journey are class-contracted at 44px", () => {
  it("Stage 1 form controls, the shell nav, the quote list and the small disclosure links", async () => {
    const { readFileSync } = await import("node:fs");
    const rd = (f: string) => readFileSync(`${__dirname}/../${f}`, "utf8");
    const page = rd("[id]/page.tsx");
    expect(page).toContain("[&_input:not([type=checkbox]):not([type=radio])]:min-h-11 [&_select]:min-h-11 [&_textarea]:min-h-11"); // additive, Stage 1 form only
    expect(page).toContain('data-testid="provenance"');
    expect(rd("[id]/AuditDetails.tsx")).toMatch(/<summary[^>]*className="[^"]*min-h-11/);
    expect(rd("../NewquipShell.tsx")).not.toContain("md:min-h-9");
    expect(rd("page.tsx")).not.toContain("h-9 items-center");
    expect(rd("[id]/Stage1Review.tsx")).toContain("inline-flex min-h-11 cursor-pointer items-center");
    expect(rd("[id]/CustomerPanel.tsx")).toContain('inline-flex min-h-11 cursor-pointer items-center font-medium text-slate-700">Details');
    expect(rd("fields.tsx")).toContain("h-9"); // the shared inputs are NOT changed for the Project / claims / billing screens
  });
  it("the step rail is dense on Stage 1 (compact cards), and the stage indicator is one box", async () => {
    await open({ view: snapshotView(true), step: "2" });
    const card = document.querySelector('[data-step="site"]')!;
    expect(card.className).toContain("p-2");
    const nav = screen.getByTestId("stage-nav");
    expect(nav.className).toContain("rounded-lg border");
    expect(nav.querySelector('[data-testid="next-action"]')!.className).toContain("max-sm:hidden");
  }, 30000);
});

// ── Phase 2: Rep handoff (S1a) and customer integrity (S1b) wired into Stage 1 ──
import { renderToStaticMarkup } from "react-dom/server";
describe("S1a: the Rep submits with Estimator-owned items open (indicative total)", () => {
  it("Review shows 'Awaiting the Estimator: N product choices, N prices' informationally; Submit is not locked; the indicative total, the plain note and the tick are shown; the action gets the indicative amount", async () => {
    const send = vi.spyOn(actions, "sendGrowerQuoteToEstimatorAction").mockImplementation((async (qid: string) => actions.getGrowerQuoteAction(qid)) as never);
    await open({ view: snapshotView(true), draftOver: noMapDraft(), step: "5" });
    expect(status("submit")).not.toBe("Locked");
    expect(current()).toBe("submit");
    const caption = screen.getByTestId("total-caption").textContent ?? "";
    expect(caption).toMatch(/^Indicative total \(\d+ lines? await the Estimator\)$/);
    const bar = screen.getByTestId("quote-summary-bar");
    expect(bar.textContent).toMatch(/R\s?[\d\s]+,\d\d/); // an amount IS shown although the budget is incomplete
    const sub = panel("submit") as HTMLElement;
    const n = Number(caption.match(/\((\d+)/)![1]);
    expect(within(sub).getByTestId("indicative-note").textContent).toBe(`This total is indicative while ${n} lines await the Estimator. If the Estimator's pricing changes it, the quotation returns to you to reconfirm the amount with the customer.`);
    const btn = (await within(sub).findByRole("button", { name: "Submit to Estimator" })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(within(sub).getByLabelText(/has confirmed the indicative quotation total of R/));
    await waitFor(() => expect(btn.disabled).toBe(false));
    fireEvent.click(btn);
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][1]).toBeGreaterThan(0); // the indicative total in cents (server figure), not null
    // Review: informational, never a blocker
    fireEvent.click(screen.getByRole("button", { name: /Review configuration/ }));
  }, 60000);

  it("Review groups the awaiting items as counts", async () => {
    await open({ view: snapshotView(true), draftOver: noMapDraft(), step: "4" });
    expect(screen.getByTestId("est-mappings-group").textContent).toMatch(/Awaiting the Estimator: \d+ product choices?, \d+ prices?\./);
    expect(document.body.textContent).not.toMatch(/nothing for you to do yet/);
  }, 30000);
});

describe("S1b: customer identity", () => {
  it("with Cin7 lookup available a typed name is NOT the identity: a legacy quotation without a snapshot shows 'Select the Cin7 customer' (needs attention), no typed field, later steps locked", async () => {
    await open({ view: customerView(), draftOver: { customerName: "Typed Name Ltd" }, stage: "" });
    expect(screen.queryByRole("textbox", { name: /^Customer\b/, hidden: true })).toBeNull();
    expect(status("customer")).toBe("Needs attention");
    expect(within(screen.getByTestId("step-rail")).getByText(/Select the Cin7 customer/)).toBeTruthy();
    expect(status("site")).toBe("Locked");
    expect(document.querySelector('[data-stage="1"]')!.textContent).not.toContain("Complete");
  }, 30000);

  it("the typed fallback still exists where Cin7 lookup is unavailable", async () => {
    await open({ view: customerView({ available: false }), draftOver: { customerName: "Typed Name Ltd" }, step: "1" });
    expect(screen.getByRole("textbox", { name: /^Customer\b/, hidden: true })).toBeTruthy();
    expect(status("customer")).toBe("Complete");
  }, 30000);
});

describe("S1b: changing the contact", () => {
  it("when it would withdraw the customer's confirmation the Rep is told first and must confirm; confirming passes confirmWithdrawal=true and the effect is shown; Cancel calls nothing", async () => {
    const view = snapshotView(true, { contactChangeWithdrawsConfirmation: true, confirmationRecorded: true });
    await open({ view, step: "1" });
    const choose = vi.spyOn(ca, "chooseQuoteContactAction").mockResolvedValue({ ok: true, data: { ...snapshotView(true), effect: { confirmationCleared: true, signoffCleared: false, returnedToRep: true } } } as never);
    fireEvent.click(screen.getByRole("button", { name: /Thandi/ }));
    expect(screen.getByTestId("contact-withdraw-warning").textContent).toBe("Changing the contact withdraws the customer's confirmation (and returns the quotation to you if the Estimator is reviewing it)");
    expect(choose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("contact-withdraw-warning")).toBeNull();
    expect(choose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Thandi/ }));
    fireEvent.click(screen.getByRole("button", { name: "Change contact" }));
    await waitFor(() => expect(choose).toHaveBeenCalledTimes(1));
    expect(choose.mock.calls[0][2]).toBe(true);
    expect((await screen.findByTestId("confirmation-effect")).textContent).toBe("The customer's price confirmation was withdrawn; the quotation was returned to you as a new revision. Reconfirm the amount with the customer, then submit again.");
  }, 30000);

  it("without a recorded confirmation there is no warning and the action is not asked to withdraw anything", async () => {
    await open({ view: snapshotView(true), step: "1" });
    const choose = vi.spyOn(ca, "chooseQuoteContactAction").mockResolvedValue({ ok: true, data: snapshotView(true) } as never);
    fireEvent.click(screen.getByRole("button", { name: /Thandi/ }));
    expect(screen.queryByTestId("contact-withdraw-warning")).toBeNull();
    await waitFor(() => expect(choose).toHaveBeenCalled());
    expect(choose.mock.calls[0][2]).toBe(false);
  }, 30000);

  it("a returned quotation explains an Estimator price change from the save's confirmationEffect (previous -> new, withdrawn, reconfirm)", async () => {
    await open({ view: snapshotView(true), draftOver: { siteName: "" }, row: { revision: 2 } });
    const real = actions.saveGrowerDraftAction;
    vi.spyOn(actions, "saveGrowerDraftAction").mockImplementation((async (qid: string, d: never) => { const r: any = await real(qid, d); return { ...r, data: { ...r.data, confirmationEffect: { confirmationCleared: true, signoffCleared: false, returnedToRep: true, previousCents: 1000000, newCents: 1250000 } } }; }) as never);
    fireEvent.change(screen.getByLabelText(/^Site \/ project name/), { target: { value: "Farm 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    const t = await screen.findByTestId("return-amount-change");
    expect(t.textContent).toMatch(/^The total changed from R\s?10\s?000,00 to R\s?12\s?500,00; the customer's confirmation was withdrawn: reconfirm the new amount with the customer and submit again\./);
  }, 30000);
});

describe("template page (Rep-visible) and the cost-basis wording", () => {
  it("renders no landed-cost / markup / 20% / ROE / Freight wording for a Rep; a cost-visible viewer still reads the register as written", async () => {
    const Page = (await import("../template/page")).default;
    vi.mocked(canSeeCosts).mockResolvedValue(false);
    const rep = renderToStaticMarkup(await Page());
    expect(rep).toContain("Project pricing");
    // (the register legitimately mentions delivery "freight" elsewhere, so the scan names the cost-basis wording itself)
    expect((rep.match(/.{30}(landed cost|mark-?up|\b20%|\bROE\b).{30}/i) ?? [""])[0]).toBe("");
    vi.mocked(canSeeCosts).mockResolvedValue(true);
    expect(renderToStaticMarkup(await Page())).toMatch(/landed cost/i);
  }, 30000);
});

// ── D-11: a returned quotation whose approval was withdrawn (price edit changed the total) says what happened ──
describe("D-11: returned banner for the three cases", () => {
  const history = (events: unknown[]) => vi.spyOn(aa, "getDocumentApprovalAction").mockResolvedValue({ ok: true, data: { available: true, latest: null, history: events } } as never);
  it("(1) a RETURN with a reason: the existing banner with the reason and 'Fix what the Estimator described'", async () => {
    history([{ id: "e", action: "RETURN", to_status: "RETURNED", reason: "Check the haulier quote", actor_email: "est@nq", actor_name: null, created_at: "2026-11-02T09:30:00Z" }]);
    await open({ view: snapshotView(true), draftOver: readyDraft, row: { revision: 2 } });
    expect((await screen.findByTestId("return-reason")).textContent).toContain("Check the haulier quote");
    expect(screen.getByTestId("returned-banner").textContent).toContain("Fix what the Estimator described, then submit again.");
    expect(screen.queryByTestId("return-withdrawn")).toBeNull();
  }, 30000);

  it("(2) withdrawn WITHOUT a reason (fresh load): says the total changed, shows the current indicative total, points to step 5, and never says 'Fix what the Estimator described'", async () => {
    history([{ id: "e", action: "WITHDRAW", to_status: "WITHDRAWN", reason: null, actor_email: "sys@nq", actor_name: null, created_at: "2026-11-02T09:30:00Z" }]);
    await open({ view: snapshotView(true), draftOver: readyDraft, row: { revision: 2, customer_confirmed_cents: null } });
    const t = (await screen.findByTestId("return-withdrawn")).textContent ?? "";
    expect(t).toMatch(/^The total changed after the Estimator's review, so the customer's confirmation was withdrawn\. Reconfirm the current amount \(R\s?[\d\s]+,\d\d\) with the customer, then submit again \(step 5\)\.$/);
    expect(screen.getByTestId("returned-banner").textContent).not.toContain("Fix what the Estimator described");
    expect(screen.getByTestId("returned-banner").textContent).not.toContain("see Approval history for the reason");
  }, 30000);

  it("(3) the session-local sentence 'from R x to R y' still wins when the save reported the effect; and an unreadable history keeps the fixed text", async () => {
    history([]);
    await open({ view: snapshotView(true), draftOver: { siteName: "" }, row: { revision: 2, customer_confirmed_cents: null } });
    await screen.findByTestId("return-withdrawn");
    const real = actions.saveGrowerDraftAction;
    vi.spyOn(actions, "saveGrowerDraftAction").mockImplementation((async (qid: string, d: never) => { const r: any = await real(qid, d); return { ...r, data: { ...r.data, confirmationEffect: { confirmationCleared: true, signoffCleared: false, returnedToRep: true, previousCents: 1000000, newCents: 1250000 } } }; }) as never);
    fireEvent.change(screen.getByLabelText(/^Site \/ project name/), { target: { value: "Farm 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect((await screen.findByTestId("return-amount-change")).textContent).toContain("The total changed from");
    expect(screen.queryByTestId("return-withdrawn")).toBeNull();
    cleanup();
    vi.spyOn(aa, "getDocumentApprovalAction").mockResolvedValue({ ok: false, error: "x" } as never);
    await open({ view: snapshotView(true), draftOver: readyDraft, row: { revision: 2, customer_confirmed_cents: null } });
    expect(screen.getByTestId("returned-banner").textContent).toContain("see Approval history for the reason");
    expect(screen.queryByTestId("return-withdrawn")).toBeNull();
  }, 60000);
});

// ── Owner directive: first field above the fold on a phone (<640px compaction; class contracts, measured in a real browser) ──
describe("phone compaction keeps the navigation contract", () => {
  it("the rail header is 'Step n of N · name' with the list collapsed; Show all steps and Next incomplete sit inside the collapsed region on a phone; Save stays visible; the saving rule has a phone twin", async () => {
    await open({ view: snapshotView(true), step: "2" });
    expect(screen.getByTestId("step-rail-toggle").textContent).toBe("Step 2 of 5 · Site & measurements▼");
    const more = screen.getByTestId("step-rail-more");
    expect(more.className).toContain("max-[700px]:hidden");
    expect(within(more).getByLabelText("Show all steps")).toBeTruthy();
    expect(more.textContent).toContain("Next incomplete step");
    expect(screen.getByTestId("step-rail").querySelector("ol")!.getAttribute("id")).toBe("s1-list"); // still an ordered list
    expect(document.querySelector('[data-step="site"]')!.getAttribute("aria-current")).toBe("step");
    expect(screen.getByRole("button", { name: "Save draft" })).toBeTruthy(); // not inside the collapsed region
    expect(more.contains(screen.getByRole("button", { name: "Save draft" }))).toBe(false);
    expect(screen.getByTestId("saving-rules").className).toContain("max-sm:hidden");
    expect(screen.getByTestId("saving-rules-mobile").className).toContain("sm:hidden");
    fireEvent.click(screen.getByTestId("step-rail-toggle"));
    expect(screen.getByTestId("step-rail-more").className).not.toContain("max-[700px]:hidden");
  }, 30000);

  it("phone-only utility classes: no desktop class changed (the h1 stays in the DOM for screen readers; the stage words and the extra intros hide only below 640px)", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync(`${__dirname}/../[id]/page.tsx`, "utf8");
    expect(page).toContain("max-sm:sr-only"); // h1 + Calculation label stay for assistive tech
    expect(page).toContain("max-sm:[&_section.rounded-lg]:p-3!");
    expect(page).toContain("max-sm:flex-nowrap"); // the summary bar is one row on a phone
    expect(readFileSync(`${__dirname}/../[id]/StageNav.tsx`, "utf8")).toContain('<span className="max-sm:sr-only">');
  });
});
