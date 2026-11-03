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
import * as costActions from "../cost-actions";
import { emptyDraft } from "@/newquip/grower/draft";
import { rolesFor } from "@/newquip/quote/roles";
import * as actions from "../actions";

// UX-006b, rendered through the REAL page (Stage 2) with the owner's real quote shape: the guided steps, the Rep (three steps) and Estimator (four steps) variants, Back / Next, ?step=,
// Show all steps, statuses derived from data (never from a visit), and that the requests made on mount are the same whichever step is shown. Nothing is mocked but the session/auth.

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
const asRoles = (...r: Array<"REP" | "ESTIMATOR" | "MANAGER">) => vi.mocked(resolveRoles).mockResolvedValue(new Set(r) as never);

beforeEach(() => {
  db = new FakeDb();
  
  vi.clearAllMocks();
  vi.mocked(requireNewquipPocOrg).mockResolvedValue(SESSION as never);
  vi.mocked(requireModuleAccess).mockResolvedValue(SESSION as never);
  vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("not admin"));
  vi.mocked(canSeeCosts).mockResolvedValue(false);
  asRoles("REP");
  (globalThis as { __STEP?: string }).__STEP = undefined;
});


vi.mock("next/navigation", () => ({
  useParams: () => ({ id: (globalThis as { __QID?: string }).__QID }),
  useSearchParams: () => new URLSearchParams("stage=" + ((globalThis as { __STAGE?: string }).__STAGE ?? "2") + ((globalThis as { __STEP?: string }).__STEP ? `&step=${(globalThis as { __STEP?: string }).__STEP}` : "")),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/newquip-grower/x",
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
const config = {"rooms":12,"widthM":14.43,"lengthM":49.5,"totalPens":20,"pigsPerRoom":600,"hospitalPens":2,"feederVariant":"STANDARD","penningPigSize":"SMALL","optionalEquipment":{"cone_fans":false,"controller":true,"manure_plug":false,"pad_cooling":false,"control_panel":false,"silo_weighing":false,"emergency_windows":false},"quantityOverrides":{"led_light":38,"feed_saver_mat":18},"selectedFeederType":"CCM","slattedFloorAreaM2":120,"estimatorQuantities":{"feeder":18,"pvc_door":2,"bulk_tank":1,"cone_fans":4,"controller":2,"flex_auger":1,"cup_drinker":54,"manure_plug":2,"pad_cooling":3,"concrete_slat":1320,"control_panel":2,"silo_weighing":2,"emergency_windows":2},"selectedDrinkerType":"CUP_NEW","selectedPenningType":"PP_GREEN_VENTED","selectedFlooringType":"CONCRETE_1200X450X70","selectedLightingType":"FORTIS_1_2_5000K","quantityOverrideReasons":{"led_light":"Test","feed_saver_mat":"Test"},"penningRunningMetresPerRoom":20};
const pr = (p: number) => ({ at: "t", by: "x", reason: "Master workbook has no usable price. Temporary POC estimator value only.", unitPriceExVat: p });
const draft: any = { ...emptyDraft(), quoteType: "day_to_day", config: { ...config, exclusions: { pvc_door: "Not needed" } },
  estimator: { ...emptyDraft().estimator, confirmedMappings: {"feeder":"PNQ082","pvc_door":"NQ2114","bulk_tank":"SYSH-2750-3","controller":"HO05084000","concrete_slat":"NQ1161","feed_saver_mat":"ERT053"}, confirmedPackages: ["cup_drinker","led_light"], charges: {"delivery":979992,"installation":1200000,"concrete_slat_delivery":250000}, unitPrices: {"flex_auger":45000}, priceResolutions: {pvc_door:pr(3000),led_light:pr(881),controller:pr(3000),cup_drinker:pr(548),concrete_slat:pr(203),feed_saver_mat:pr(919)} } };

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); try { window.localStorage.clear(); } catch { /* the "Show all steps" preference must not leak between tests */ } });

import * as ca from "../customer-actions";
import * as da from "../delivery-actions";
import * as dc from "../document-actions";
import * as ma from "../mapping-actions";
import * as ta from "../template-actions";
const mods: Record<string, Record<string, unknown>> = { actions, costActions, ca, da, dc, ma, ta };
type Spy = { n: string; spy: any };
/** Run every server action through ONE queue, one at a time, each taking `ms` - how Next.js serialises a client's server actions. Returns the order they STARTED and FINISHED in. */
function serialQueue(ms: number) {
  const log: string[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  const spies: Spy[] = [];
  for (const [mn, m] of Object.entries(mods)) for (const [fn, f] of Object.entries(m)) {
    if (typeof f !== "function" || !/Action$/.test(fn)) continue;
    const orig = f as (...a: unknown[]) => Promise<unknown>;
    spies.push({ n: fn, spy: vi.spyOn(m as any, fn).mockImplementation(((...a: unknown[]) => {
      const run = tail.then(async () => { log.push(`start ${fn}`); await new Promise((r) => setTimeout(r, ms)); const r = await orig(...a); log.push(`end ${fn}`); return r; });
      tail = run.catch(() => undefined);
      return run;
    }) as never) });
    void mn;
  }
  return { log, spies };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Role = "REP" | "ESTIMATOR" | "MANAGER";
const g = globalThis as { __QID?: string; __STAGE?: string; __STEP?: string };

/** Opens Stage 2 as `roles`. `commercials` is the viewer's cost visibility (an Estimator/Manager in practice). */
async function open(o: { stage?: string; roles?: Role[]; commercials?: boolean; state?: string; row?: Record<string, unknown>; step?: string; draftOver?: Record<string, unknown> } = {}) {
  g.__STAGE = o.stage ?? "2"; g.__STEP = o.step;
  asRoles(...(o.roles ?? ["REP"]));
  vi.mocked(canSeeCosts).mockResolvedValue(o.commercials ?? false);
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, { ...draft, customerName: "Acme Pigs", siteName: "Farm 1", ...o.draftOver });
  for (const row of db.rows("newquip_quotes") as Array<Record<string, unknown>>) if (row.id === id) { if (o.state) row.state = o.state; const { __useDraftHash, ...rest } = (o.row ?? {}) as Record<string, unknown>; Object.assign(row, rest); if (__useDraftHash) Object.assign(row, { estimator_signoff_hash: row.draft_hash, estimator_signoff_by_email: "e@nq" }); }
  g.__QID = id;
  const { default: Page } = await import("../[id]/page");
  render(createElement(Page));
  await waitFor(() => expect(screen.getByTestId(o.stage && o.stage !== "2" ? "stage-nav" : "step-rail")).toBeTruthy(), { timeout: 8000 });
}
const rail = () => screen.getByRole("navigation", { name: "Costing and review steps" });
const ids = () => [...rail().querySelectorAll("ol > li button")].map((b) => b.getAttribute("data-step"));
const status = (id: string) => screen.getByTestId(`step-status-${id}`).textContent;
const panel = (id: string) => document.querySelector(`[data-step-panel="${id}"]`);
const shown = (id: string) => !!panel(id) && !panel(id)!.hasAttribute("hidden");
const toggle = () => (screen.getByTestId("step-rail-toggle").textContent ?? "").replace(/[▲▼]$/, "");
const current = () => rail().querySelector('[aria-current="step"]')!.getAttribute("data-step");
const started = (q: ReturnType<typeof serialQueue>) => q.log.filter((l) => l.startsWith("start ")).length;
const SHOWALL = () => vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "nq-builder-show-all" ? "1" : null), setItem: () => undefined });
// A quotation the Rep has submitted: the price confirmation is recorded (contact + time + amount) and the state is ESTIMATOR_REVIEW.
const SUBMITTED = { state: "ESTIMATOR_REVIEW", row: { customer_confirmed_cents: 1000000000, customer_confirmed_by: "A Customer <a@c.co>", customer_confirmed_at: "2026-11-02T08:00:00Z", handoff_by_email: "rep@nq" } };
// Estimator-owned blockers on a Rep draft: no product mappings and no manual prices yet.
const UNMAPPED = { estimator: { ...draft.estimator, confirmedMappings: {}, confirmedPackages: [], priceResolutions: {} } };

describe("UX-006i2 Stage 2 is the Estimator's: who has which steps", () => {
  it("an Estimator with cost visibility has FOUR steps in ONE list (no Rep group): mapping, costs, final review, sign-off; Rep controls and the Submit step are gone", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED });
    expect(ids()).toEqual(["mapping", "costs", "final", "signoff"]);
    expect(rail().querySelectorAll('[role="group"]').length).toBe(0);
    expect(ids().includes("submit" as never)).toBe(false);
    for (const t of ["Customer-driven exclusions", "Commercial inputs (ex VAT)", "Submit to Estimator"]) expect(screen.queryByText(t), t).toBeNull();
    expect(panel("charges")).toBeNull(); expect(panel("submit")).toBeNull();
    expect(screen.queryByLabelText(/^Delivery/)).toBeNull();
    expect(screen.queryByLabelText(/Exclude /)).toBeNull();
    expect(screen.queryByTestId("submit-pointer")).toBeNull();
    // the old Rep-side status chips / pointers are not rendered
    expect(document.body.textContent).not.toMatch(/Rep preparation(?! complete)|Open Stage 1 step/); // (the collapsed stage line may say "Rep preparation complete - next: Stage 2")
  }, 30000);

  it("a viewer without cost visibility has TWO steps (mapping, sign-off): the costing steps are absent, never disabled, and no cost wording appears", async () => {
    await open({ roles: ["REP"], ...SUBMITTED });
    expect(ids()).toEqual(["mapping", "signoff"]);
    expect(panel("costs")).toBeNull(); expect(panel("final")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Cost & margin|Costs, margins|Internal margins|Estimated cost|GP \(managers\)|Cin7 latest cost|Mark reviewed|Final review/);
    expect(screen.getByText("Totals")).toBeTruthy(); // what the Rep could already see stays
    expect(panel("mapping")!.textContent).toContain("Physical scope");
  }, 30000);

  it("the Rep's submitted information is ONE read-only summary at the top: customer, site, total, and 'confirmed by <contact> on <date>' from the quotation's own record; the confirmation is shown once", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED });
    const sum = screen.getByTestId("rep-summary");
    expect(screen.getAllByTestId("rep-summary").length).toBe(1);
    expect(sum.textContent).toContain("Submitted by the Rep");
    expect(sum.textContent).toContain("Acme Pigs"); expect(sum.textContent).toContain("Farm 1");
    expect(screen.getByTestId("rep-summary-confirmation").textContent).toMatch(/R\s?10\s?000\s?000,00 confirmed by A Customer <a@c\.co> on /);
    expect(screen.getByTestId("rep-summary-confirmation").textContent).toMatch(/2026/);
    expect(screen.queryByTestId("confirmation-recorded")).toBeNull(); // the old duplicate Pre-approval panel is gone
    expect(document.body.textContent).not.toContain("Pre-approval price confirmation");
    // NO editable Rep control anywhere in it; the detail is a collapsible disclosure
    expect(sum.querySelectorAll("input, select, textarea, button").length).toBe(0);
    const detail = within(sum).getByTestId("rep-summary-detail");
    expect(detail.tagName).toBe("DETAILS"); expect(detail.hasAttribute("open")).toBe(false);
    expect(detail.textContent).toMatch(/Site & measurements/); expect(detail.textContent).toMatch(/Selected equipment/); expect(detail.textContent).toMatch(/Exclusions/); expect(detail.textContent).toMatch(/Quantities/); expect(detail.textContent).toMatch(/Charges/);
    expect(sum.compareDocumentPosition(rail()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // above the steps
  }, 30000);

  it("each step holds its own panels: readiness, line decisions (quantities read-only), mappings and manual prices (1); scope, cost, totals, margin (2); the checklist and the one action (3); sign-off and return (4)", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED });
    fireEvent.click(rail().querySelector('[data-step="mapping"]')!);
    expect(panel("mapping")!.textContent).toMatch(/Quote readiness[\s\S]*Line decisions[\s\S]*Product mappings/);
    expect(within(panel("mapping") as HTMLElement).getByRole("button", { name: "Confirm source-backed mappings" })).toBeTruthy();
    expect(within(panel("mapping") as HTMLElement).getByTestId("rep-owned-note").textContent).toMatch(/Quantities are the Rep.s \(read-only here\)/);
    await waitFor(() => expect(panel("costs")!.textContent).toContain("Internal margins"), { timeout: 8000 });
    for (const t of ["Totals", "Estimated cost", "Physical scope"]) expect(panel("costs")!.textContent).toContain(t);
    expect(within(panel("final") as HTMLElement).getByTestId("final-review-checklist")).toBeTruthy();
    expect(panel("signoff")!.textContent).toContain("Sign off or return");
  }, 30000);

  it("LineDecisionsTable in estimator mode: quantities are READ-ONLY (Rep-owned) and the mapping choosers are editable", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED });
    fireEvent.click(rail().querySelector('[data-step="mapping"]')!);
    const t = within(panel("mapping") as HTMLElement).getByRole("table", { name: "Line decisions" });
    expect(t.querySelectorAll('input[type="number"]').length).toBe(0); // no quantity input
    expect(t.querySelectorAll('[data-testid^="qty-readonly-"]').length).toBeGreaterThan(0);
    expect(document.querySelector('[data-testid^="mapping-chooser-"]')).toBeTruthy();
  }, 30000);

  it("the sticky summary, the three concepts: 'Calculation' on the readiness chip, the Estimator's status line names the next responsible role", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED });
    expect(within(screen.getByTestId("quote-summary-bar")).getByText("Calculation")).toBeTruthy();
    expect(screen.getByTestId("stage2-status-line").textContent).toMatch(/Next responsible role: Estimator/);
    expect(screen.getByTestId("next-owner").textContent).toBe("Estimator");
  }, 30000);
});

describe("UX-006i2 Stage 2: an Estimator on a Rep draft (the Rep is waiting on their mapping)", () => {
  it("opens at step 1 with 'The Rep is waiting on your mapping' and the blockers listed; steps 2-4 are LOCKED with the real reason; the locked steps cannot be selected", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, draftOver: UNMAPPED });
    expect(current()).toBe("mapping");
    const banner = screen.getByTestId("rep-waiting-banner");
    expect(banner.textContent).toContain("Needed from you before the Rep can submit");
    expect(document.body.textContent!.split("The Rep is waiting on your mapping").length - 1).toBe(1); // said once (the status line), not repeated in the banner
    expect(screen.getByTestId("all-steps-complete").textContent).toBe("Next: choose the products listed above, then save.");
    expect(banner.querySelectorAll("li").length).toBeGreaterThan(0);
    expect(banner.textContent).toMatch(/Choose or confirm the product for/);
    expect(screen.getByTestId("stage2-status-line").textContent).toBe("The Rep is waiting on your mapping.");
    expect(screen.getByTestId("next-owner").textContent).toBe("Estimator");
    for (const id of ["costs", "final", "signoff"]) {
      const b = rail().querySelector(`[data-step="${id}"]`) as HTMLElement;
      expect(b.getAttribute("aria-disabled")).toBe("true");
      expect(screen.getByTestId(`step-blocked-${id}`).textContent).toContain("The Rep has not submitted yet");
      expect(status(id)).toBe("Locked");
      fireEvent.click(b); expect(current()).toBe("mapping"); expect(shown(id)).toBe(false);
    }
    // the Estimator's own mapping controls are live (the server lets an Estimator map on a Rep draft)
    expect((screen.getByRole("button", { name: "Confirm source-backed mappings" }) as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelector('[data-testid^="mapping-chooser-"]')).toBeTruthy();
  }, 30000);

  it("Next is disabled with the reason; Show all steps lists the locked steps as heading + reason only (their content stays hidden and inert); no sign-off or cost action is reachable", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, draftOver: UNMAPPED });
    const next = within(screen.getByTestId("step-buttons")).getByRole("button", { name: /^Next:/ }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    expect(screen.getByTestId("next-blocked").textContent).toContain("The Rep has not submitted yet");
    expect(document.getElementById(next.getAttribute("aria-describedby")!)!.textContent).toContain("The Rep has not submitted yet");
    cleanup();
    SHOWALL();
    await open({ roles: ["ESTIMATOR"], commercials: true, draftOver: UNMAPPED });
    for (const id of ["costs", "final", "signoff"]) {
      expect(shown(id)).toBe(true);
      expect(screen.getByTestId(`panel-blocked-${id}`).textContent).toContain("The Rep has not submitted yet");
      expect(panel(id)!.querySelector("[hidden][inert]")).toBeTruthy(); // the content is not shown
    }
    expect(screen.queryByRole("button", { name: /Mark reviewed/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Sign off for Manager approval/ })).toBeNull();
  }, 60000);

  it("a Rep draft with nothing for the Estimator to map: the line says it is with the Rep; sign-off stays locked", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true });
    expect(screen.queryByTestId("rep-waiting-banner")).toBeNull();
    expect(screen.getByTestId("stage2-status-line").textContent).toMatch(/The Rep has not submitted yet\. Next responsible role: Rep\./);
    expect(status("signoff")).toBe("Locked");
  }, 30000);
});

describe("UX-006i2 Stage 2: Rep, Manager and observer inspect it read-only", () => {
  it("a Rep (submitted): the next responsible role is the Estimator; every Estimator control is absent or disabled; nothing is left for them", async () => {
    await open({ roles: ["REP"], ...SUBMITTED });
    expect(screen.getByTestId("stage2-status-line").textContent).toBe("Submitted by the Rep. Next responsible role: Estimator.");
    expect(screen.getByTestId("next-owner").textContent).toBe("Estimator");
    expect(screen.queryByRole("button", { name: "Next incomplete step" })).toBeNull();
    expect(screen.getByTestId("all-steps-complete").textContent).toBe("Nothing is left for you in this stage.");
    expect(screen.queryByRole("button", { name: /Sign off for Manager approval/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Return to rep" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull(); // no Save bar for a viewer who cannot edit here
    expect(panel("mapping")!.closest("fieldset")!.disabled).toBe(true);
    expect(screen.getByTestId("signoff-not-yours").textContent).toMatch(/Only an Estimator can sign off or return it here/);
  }, 30000);

  it("a Rep (not submitted yet): told to complete the Stage 1 submission, with the Rep as the next owner", async () => {
    await open({ roles: ["REP"] });
    expect(screen.getByTestId("stage2-status-line").textContent).toBe("Complete the Stage 1 submission. Next responsible role: Rep.");
    expect(screen.getByTestId("rep-summary").textContent).toContain("From the Rep (not submitted yet)");
    expect(screen.getByTestId("rep-summary-confirmation").textContent).toBe("Not recorded yet");
  }, 30000);

  it("a Manager: read-only inspection of Stage 2 with the cost steps; cannot mark reviewed, sign off or return; may open every step they can see", async () => {
    await open({ roles: ["MANAGER"], commercials: true, ...SUBMITTED });
    expect(ids()).toEqual(["mapping", "costs", "final", "signoff"]);
    for (const id of ids()) { fireEvent.click(rail().querySelector(`[data-step="${id}"]`)!); expect(shown(id!)).toBe(true); }
    fireEvent.click(rail().querySelector('[data-step="final"]')!);
    expect(screen.queryByRole("button", { name: /Mark reviewed/ })).toBeNull();
    expect(screen.getByTestId("cost-ack-blocked").textContent).toBe("You can view the costing and margin, but only the Estimator can mark it reviewed.");
    expect(panel("costs")!.closest("fieldset")!.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /Sign off for Manager approval/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  }, 30000);

  it("OBSERVER (can see the costing, holds no quote role - e.g. an Administrator): read-only wording, a plain Next that records nothing, and no server action", async () => {
    const q = serialQueue(0);
    await open({ roles: [], commercials: true, step: "3", ...SUBMITTED });
    await sleep(1200);
    const before = started(q);
    expect(current()).toBe("final");
    expect(screen.queryByRole("button", { name: /Mark reviewed/ })).toBeNull();
    expect(screen.getByTestId("cost-ack-blocked").textContent).toContain("only the Estimator can mark it reviewed");
    fireEvent.click(within(screen.getByTestId("step-buttons")).getByRole("button", { name: "Next: Sign-off or return" }));
    expect(shown("signoff")).toBe(true);
    expect(status("final")).not.toBe("Reviewed"); // nothing recorded
    expect(toggle()).toMatch(/· 1 complete/); // only the mapping step (data) - the click recorded nothing
    await act(async () => { await sleep(150); });
    expect(started(q)).toBe(before);
    expect(screen.getByTestId("signoff-not-yours")).toBeTruthy();
  }, 90000);
});

describe("UX-006i2 Stage 2: the entry step is the first incomplete step the viewer may act on, resolved once", () => {
  it("an Estimator on a submitted quote opens at Costs (mapping is already complete); with a current sign-off it opens at Sign-off", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED });
    expect(current()).toBe("costs"); expect(shown("costs")).toBe(true);
    cleanup();
    await open({ roles: ["ESTIMATOR"], commercials: true, state: "ESTIMATOR_REVIEW", row: { ...SUBMITTED.row, __useDraftHash: true } });
    expect(current()).toBe("signoff");
  }, 60000);

  it("an Estimator on a quote with open mapping blockers opens at step 1; a ?step= to a step the viewer may open wins, one that is locked is replaced by where they are", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "3", draftOver: UNMAPPED });
    expect(current()).toBe("mapping");
    await waitFor(() => expect(new URL(window.location.href).searchParams.get("step")).toBe("1"));
    cleanup();
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "4", ...SUBMITTED });
    expect(current()).toBe("signoff");
  }, 60000);

  it("the entry step is latched: a save or recalculation after the page settled never moves the viewer", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED });
    expect(current()).toBe("costs");
    fireEvent.click(rail().querySelector('[data-step="mapping"]')!);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm source-backed mappings" })); await sleep(800); }); // an edit: unsaved, live recalculation
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(current()).toBe("mapping");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save draft" })); await sleep(800); });
    await waitFor(() => expect(screen.getByText("All changes saved")).toBeTruthy(), { timeout: 8000 });
    expect(current()).toBe("mapping");
  }, 60000);
});

describe("UX-006i2 Stage 2: Final review - Mark reviewed & continue (client-local acknowledgement; #178's logic, now the single action of step 3)", () => {
  const ackBtn = () => screen.getByRole("button", { name: /Mark reviewed/ });
  // A real change to the draft (an Estimator's reason on a manual quotation price): the content hash and update time change when it is saved.
  const dirtyIt = async () => { await act(async () => { fireEvent.change(within(panel("mapping") as HTMLElement).getAllByLabelText("Reason", { selector: "input" })[0], { target: { value: "Supplier quote dated today" } }); }); };

  it("the checklist is compact and the ONE primary action is 'Mark reviewed & continue': marking moves progress 1 -> 3 (one review, counted on Costs and Final review), moves focus to the Sign-off heading, announces it, and sends NOTHING to the server", async () => {
    const q = serialQueue(0);
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "3", ...SUBMITTED });
    await sleep(1200);
    const before = started(q);
    expect(current()).toBe("final");
    expect(screen.getAllByRole("button", { name: /Mark reviewed/ }).length).toBe(1);
    expect(screen.queryByRole("button", { name: /without marking reviewed/ })).toBeNull(); // no second way forward
    expect(within(screen.getByTestId("step-buttons")).queryByRole("button", { name: /^Next/ })).toBeNull(); // no plain Next while unmarked
    expect(within(screen.getByTestId("final-review-checklist")).getAllByRole("listitem").length).toBeGreaterThanOrEqual(3);
    expect(screen.getByTestId("cost-ack").textContent).toContain("It is not the Estimator sign-off.");
    expect(status("final")).not.toBe("Reviewed");
    expect(toggle()).toMatch(/· 1 complete/); // mapping (data) only
    const signBefore = (within(panel("signoff") as HTMLElement).getByRole("button", { name: /Sign off for Manager approval/, hidden: true }) as HTMLButtonElement).disabled;
    const live = screen.getByTestId("cost-ack-live"); // the live region exists EMPTY first so the announcement is reliable
    expect(live.getAttribute("aria-live")).toBe("polite"); expect(live.textContent).toBe("");
    fireEvent.click(ackBtn());
    expect(toggle()).toMatch(/· 3 complete/); // 1 -> 3: marking records ONE review, which counts on both steps it covers (Costs and Final review)
    expect(current()).toBe("signoff");
    expect(document.activeElement?.textContent).toBe("Step 4 · Sign-off or return");
    expect(screen.getByTestId("cost-ack-live").textContent).toBe("Final review marked as reviewed for this session. This is not a sign-off.");
    expect(screen.getByTestId("cost-ack-live")).toBe(live);
    await act(async () => { await sleep(150); });
    expect(started(q)).toBe(before); // client-local
    expect(signBefore).toBe(true); // before the mark the sign-off waits (UX policy)
    expect((within(panel("signoff") as HTMLElement).getByRole("button", { name: /Sign off for Manager approval/ }) as HTMLButtonElement).disabled).toBe(false); // after it, the sign-off keeps only its own READY gate
    fireEvent.click(rail().querySelector('[data-step="final"]')!);
    expect(status("final")).toBe("Reviewed");
    expect(rail().querySelector('[data-step="final"]')!.textContent).not.toContain("✓");
    expect(rail().querySelector('[data-step="final"]')!.textContent).toContain("Marked reviewed for this session only - not saved and not a sign-off");
    expect(screen.getByTestId("cost-ack-done").textContent).toContain("not saved - repeat after a reload before signing off). It is not a sign-off.");
    expect(screen.queryByRole("button", { name: /Mark reviewed/ })).toBeNull();
    expect(within(screen.getByTestId("step-buttons")).getByRole("button", { name: "Next: Sign-off or return" })).toBeTruthy(); // plain navigation only after marking
    expect(live.textContent).toBe(""); // cleared when the step changed
  }, 60000);

  it("the primary button is described by its explanation (aria-describedby)", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "3", ...SUBMITTED });
    expect(document.getElementById(ackBtn().getAttribute("aria-describedby")!)!.textContent).toContain("It is not the Estimator sign-off.");
  }, 30000);

  it("an Estimator told what is next after marking: 'Next: sign off or return', never 'Nothing is left for you'", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "3", ...SUBMITTED });
    fireEvent.click(ackBtn());
    expect(screen.getByTestId("all-steps-complete").textContent).toBe("Next: sign off or return the quotation.");
  }, 30000);

  it("Show all steps: after marking, focus lands on the 'marked reviewed' text (the button is gone) and the same single action is on the page", async () => {
    SHOWALL();
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED });
    expect(screen.getAllByRole("button", { name: /Mark reviewed/ }).length).toBe(1);
    fireEvent.click(ackBtn());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("cost-ack-done")));
    expect(screen.queryByRole("button", { name: /Mark reviewed/ })).toBeNull();
  }, 30000);

  it("blocked states say what is outstanding, offer no action, and have no plain Next (Back only): a Rep draft locks the step; an incomplete cost override needs attention; unsaved edits must be saved first", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "3", ...SUBMITTED });
    const reason = within(panel("costs") as HTMLElement).getAllByLabelText("Reason", { selector: "input" })[0] as HTMLInputElement;
    await act(async () => { fireEvent.change(reason, { target: { value: "Supplier quote" } }); }); // a reason without an amount: the override is incomplete
    await waitFor(() => expect(status("final")).toBe("Needs attention"));
    expect(screen.queryByRole("button", { name: /Mark reviewed/ })).toBeNull();
    expect(screen.getByTestId("cost-ack-blocked").textContent).toMatch(/Resolve the costing items before marking reviewed\./);
    expect(screen.getByTestId("cost-ack-blocked").textContent).toMatch(/cost override is incomplete/);
    const bar = screen.getByTestId("step-buttons");
    expect(within(bar).queryByRole("button", { name: /Next/ })).toBeNull();
    expect(within(bar).getByRole("button", { name: "Back" })).toBeTruthy();
    expect(within(screen.getByTestId("cost-ack")).getByRole("button", { name: "Sign-off or return" })).toBeTruthy(); // the way to send it back instead; records nothing
  }, 60000);

  it("unsaved edits: no button, the reason is stated, nothing is announced; after Save the version changed so the acknowledgement must be given again", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "3", ...SUBMITTED });
    fireEvent.click(ackBtn());
    fireEvent.click(rail().querySelector('[data-step="final"]')!);
    expect(status("final")).toBe("Reviewed");
    await dirtyIt(); // an unsaved edit un-acknowledges (mutation target: drop this invalidation and this fails)
    expect(status("final")).not.toBe("Reviewed");
    expect(screen.queryByRole("button", { name: /Mark reviewed/ })).toBeNull();
    expect(screen.getByTestId("cost-ack-blocked").textContent).toContain("Save or discard your unsaved edits before marking the costing reviewed.");
    expect(screen.getByTestId("cost-ack-live").textContent).toBe(""); // never a false 'marked reviewed'
    expect(within(screen.getByTestId("step-buttons")).queryByRole("button", { name: /Next/ })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save draft" })); });
    await waitFor(() => expect(screen.getByText("All changes saved")).toBeTruthy(), { timeout: 8000 });
    expect(status("final")).not.toBe("Reviewed"); // (this fixture's project costs are incomplete, so the step also says it needs attention)
    expect(ackBtn()).toBeTruthy(); // and it can be given again for the new version
  }, 60000);

  it("the acknowledgement persists across navigation within the session (mark, go to step 1 and back: still Reviewed)", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "3", ...SUBMITTED });
    fireEvent.click(ackBtn());
    fireEvent.click(rail().querySelector('[data-step="mapping"]')!);
    fireEvent.click(rail().querySelector('[data-step="final"]')!);
    expect(status("final")).toBe("Reviewed");
  }, 30000);

  it("the key is never rendered: no attribute, id or text carries the quote id, hash or cost figures from the acknowledgement", async () => {
    SHOWALL();
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED });
    fireEvent.click(ackBtn());
    const box = screen.getByTestId("cost-ack");
    expect(box.outerHTML).not.toMatch(/\|/);
    expect(box.outerHTML).not.toContain(g.__QID!);
  }, 30000);

  it("a Rep and a non-commercial Estimator get NONE of it: no box, live region, button, 'Reviewed' or cost wording", async () => {
    for (const o of [{ roles: ["REP"] as Role[], commercials: false }, { roles: ["ESTIMATOR"] as Role[], commercials: false }]) {
      await open({ ...o, ...SUBMITTED });
      for (const id of ["cost-ack", "cost-ack-live", "cost-ack-pointer", "cost-ack-status", "cost-ack-done"]) expect(screen.queryByTestId(id), id).toBeNull();
      expect(document.body.textContent).not.toMatch(/Reviewed|Mark reviewed|Cost & margin|Costs, margins|Internal margins|cost attention/);
      cleanup();
    }
  }, 90000);

  it("final: nothing to mark - the step reads reviewed and approved", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, state: "MANAGER_APPROVED_FINAL", step: "3" });
    expect(screen.queryByRole("button", { name: /Mark reviewed/ })).toBeNull();
    expect(screen.getByTestId("final-reviewed").textContent).toContain("Reviewed and approved.");
  }, 30000);
});

describe("UX-006i2 Stage 2: Sign-off or return (only the actions valid for the authenticated Estimator)", () => {
  it("the Estimator is offered sign-off and, below it, a Return to the Rep section that names the next owner (the Rep) and the correction needed; the Rep and observers see neither button", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "4", ...SUBMITTED });
    expect(screen.getByRole("button", { name: /Sign off for Manager approval/ })).toBeTruthy();
    const ret = screen.getByTestId("return-section");
    expect(screen.getByTestId("return-next-owner").textContent).toMatch(/Next responsible role: Rep\. The quotation comes back as a new revision/);
    expect(ret.textContent).toMatch(/Say what the Rep must correct/);
    const button = within(ret).getByRole("button", { name: "Return to rep" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(document.getElementById("return-rep-why")!.textContent).toMatch(/reason/i);
  }, 30000);

  it("Return requires a reason and sends it to the EXISTING return action (the reason is stored where the server stores it today); the editor follows the transition back to Stage 1", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "4", ...SUBMITTED });
    const id = g.__QID!;
    // The return action itself needs the role store's workflow tables (not part of this harness's mock), so it is replaced by a twin that applies its stored effect (REP_DRAFT, revision + 1, sign-off and confirmation cleared); the call is asserted.
    const spy = vi.spyOn(actions, "returnGrowerQuoteToRepAction").mockImplementation((async () => {
      const arr = db.rows("newquip_quotes") as Array<Record<string, unknown>>; const i = arr.findIndex((r) => r.id === id);
      arr[i] = { ...arr[i], state: "REP_DRAFT", revision: 2, estimator_signoff_hash: null, customer_confirmed_cents: null };
      return actions.getGrowerQuoteAction(id);
    }) as never);
    fireEvent.change(screen.getByLabelText(/Return to rep — reason/), { target: { value: "Delivery charge is wrong" } });
    const button = screen.getByRole("button", { name: "Return to rep" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(spy).toHaveBeenCalledWith(id, "Delivery charge is wrong"), { timeout: 8000 });
    await waitFor(() => expect(document.querySelector('[data-testid="stage-nav"] [aria-current="step"]')!.getAttribute("data-stage")).toBe("1"), { timeout: 8000 }); // a real workflow change moves the view
  }, 60000);

  it("sign-off: inline success naming the Manager as the next owner, with an obvious next-stage action; the editor STAYS on Stage 2", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "3", ...SUBMITTED });
    const id = g.__QID!;
    fireEvent.click(screen.getByRole("button", { name: /Mark reviewed/ })); // sign-off waits for the review mark (UX policy); this lands on step 4
    const patchRow = (patch: (r: Record<string, unknown>) => Record<string, unknown>) => { const arr = db.rows("newquip_quotes") as Array<Record<string, unknown>>; const i = arr.findIndex((r) => r.id === id); arr[i] = { ...arr[i], ...patch(arr[i]) }; };
    vi.spyOn(actions, "signOffGrowerQuoteAction").mockImplementation((async () => { patchRow((r) => ({ estimator_signoff_hash: r.draft_hash, estimator_signoff_by_email: "e@nq", estimator_signoff_at: "2026-11-03T08:00:00Z" })); return actions.getGrowerQuoteAction(id); }) as never);
    expect(screen.queryByTestId("signoff-success")).toBeNull();
    fireEvent.click(await waitFor(() => { const b = screen.getByRole("button", { name: /Sign off for Manager approval/ }) as HTMLButtonElement; expect(b.disabled).toBe(false); return b; }, { timeout: 8000 }));
    const ok = await screen.findByTestId("signoff-success", {}, { timeout: 8000 });
    expect(ok.textContent).toContain("Estimator sign-off complete");
    expect(screen.getByTestId("signoff-next-owner").textContent).toMatch(/Next responsible role: Manager/);
    expect(screen.getByTestId("next-manager-cue").textContent).toBe("Next: Manager approval (Stage 3).");
    expect(document.querySelector('[data-testid="stage-nav"] [aria-current="step"]')!.getAttribute("data-stage")).toBe("2");
    expect(screen.queryByRole("button", { name: /Sign off for Manager approval/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Return to rep" })).toBeNull(); // the Manager owns the next decision
    fireEvent.click(within(ok).getByRole("button", { name: "Open Manager approval (Stage 3)" }));
    expect(document.querySelector('[data-testid="stage-nav"] [aria-current="step"]')!.getAttribute("data-stage")).toBe("3");
    expect(screen.getByTestId("stage3-workspace")).toBeTruthy();
  }, 60000);

  it("the 'total no longer equals the confirmed amount' alert is never shown to a Rep draft nor when nothing was confirmed; it shows in Estimator review when the amounts differ", async () => {
    const alertText = /The total changed from what the customer confirmed \(.+ -> .+\)\. Return to the Rep to reconfirm\./; // UX-006 corrections: one banner at the top of Stage 2 (the sign-off step no longer repeats it)
    await open({ row: { customer_confirmed_cents: 100 } });
    expect(document.body.textContent).not.toMatch(alertText);
    cleanup();
    await open({ roles: ["ESTIMATOR"], commercials: true, state: "ESTIMATOR_REVIEW", row: { __useDraftHash: true, customer_confirmed_cents: null } });
    expect(document.body.textContent).not.toMatch(alertText);
    cleanup();
    await open({ roles: ["ESTIMATOR"], commercials: true, state: "ESTIMATOR_REVIEW", row: { customer_confirmed_cents: 100 } });
    expect(document.body.textContent).toMatch(alertText);
  }, 90000);
});

describe("UX-006i2 Stage 2: editing during Estimator review is allowed and clears the sign-off - the page says so where the Estimator edits", () => {
  const SIGNED = { state: "ESTIMATOR_REVIEW", row: { ...SUBMITTED.row, __useDraftHash: true } };
  it("with a current sign-off, step 1 and step 2 warn that saving an edit withdraws it; an unsaved edit makes the warning stronger; it is absent for a Manager and before any sign-off or acknowledgement", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "1", ...SIGNED });
    expect(screen.getByTestId("edit-clears-signoff").textContent).toMatch(/Your sign-off is current\. Changing anything in this step and saving withdraws it/);
    expect(screen.getByTestId("edit-clears-signoff-costs").textContent).toMatch(/withdraws it/);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm source-backed mappings" })); });
    expect(screen.getByTestId("edit-clears-signoff").textContent).toMatch(/Unsaved edits: saving them withdraws your sign-off/);
    expect(status("signoff")).toBe("Needs attention");
    cleanup();
    await open({ roles: ["MANAGER"], commercials: true, step: "1", ...SIGNED });
    expect(screen.queryByTestId("edit-clears-signoff")).toBeNull();
    cleanup();
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "1", ...SUBMITTED });
    expect(screen.queryByTestId("edit-clears-signoff")).toBeNull();
  }, 90000);

  it("saving an edit after a sign-off really does withdraw it (the server's hash no longer matches), and the page then asks for the sign-off again", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "1", ...SIGNED });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Confirm source-backed mappings" })); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save draft" })); });
    await waitFor(() => expect(screen.getByText("All changes saved")).toBeTruthy(), { timeout: 8000 });
    // The draft may be unchanged in content (the source-backed mappings were already confirmed); either way the page derives the sign-off from the server's own hash comparison.
    const row = (db.rows("newquip_quotes") as Array<Record<string, unknown>>).find((r) => r.id === g.__QID)!;
    const signedNow = row.estimator_signoff_hash === row.draft_hash;
    expect(status("signoff")).toBe(signedNow ? "Complete" : "Needs attention");
  }, 60000);

  it("an acknowledged-but-unsigned review warns that an edit clears 'marked reviewed'", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "3", ...SUBMITTED });
    fireEvent.click(screen.getByRole("button", { name: /Mark reviewed/ }));
    fireEvent.click(rail().querySelector('[data-step="mapping"]')!);
    expect(screen.getByTestId("edit-clears-signoff").textContent).toMatch(/clears your 'marked reviewed'/);
  }, 60000);
});

describe("UX-006i2 Stage 2: navigation (Back only to permitted steps; no navigation action is ever called)", () => {
  it("Next and Back move through the permitted steps, update ?step= (with stage=2) and focus the new heading; the rail may jump to any permitted step", async () => {
    window.history.replaceState(null, "", "/newquip-grower/x");
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "1", ...SUBMITTED });
    expect(current()).toBe("mapping");
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    for (const s of ["costs", "final", "signoff"]) { expect(shown(s)).toBe(false); expect(panel(s)!.hasAttribute("inert")).toBe(true); }
    fireEvent.click(screen.getByRole("button", { name: "Next: Costs, margins & pricing exceptions" }));
    const q = new URL(window.location.href).searchParams;
    expect(q.get("stage")).toBe("2"); expect(q.get("step")).toBe("2");
    expect(shown("costs")).toBe(true);
    expect(document.activeElement?.textContent).toBe("Step 2 · Costs, margins & pricing exceptions");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(shown("mapping")).toBe(true);
    fireEvent.click(within(rail()).getByRole("button", { name: /Sign-off or return/ }));
    expect(shown("signoff")).toBe(true);
    expect(within(screen.getByTestId("step-buttons")).queryByRole("button", { name: /^Next/ })).toBeNull(); // the last step
  }, 30000);

  it("?step= is validated against THIS viewer's steps: a Rep (two) given 5 says so and shows the first step; an Estimator given 3 opens Final review; ?step=2 for a Rep is the sign-off view", async () => {
    window.history.replaceState(null, "", "/newquip-grower/x?stage=2&step=5");
    await open({ roles: ["REP"], step: "5", ...SUBMITTED });
    expect(current()).toBe("mapping");
    expect(screen.getByTestId("step-unavailable").textContent).toBe("That step is not available to you, so the first step is shown.");
    expect(screen.getByTestId("step-unavailable").closest("[role=status]")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Internal margins|Cost & margin/);
    await waitFor(() => expect(new URL(window.location.href).searchParams.has("step")).toBe(false));
    fireEvent.click(within(rail()).getByRole("button", { name: /Sign-off or return/ })); // a Rep has no Next in Stage 2 (P2): navigating is by the rail
    expect(screen.queryByTestId("step-unavailable")).toBeNull();
    cleanup();
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "3", ...SUBMITTED });
    expect(current()).toBe("final");
    cleanup();
    await open({ roles: ["REP"], step: "2", ...SUBMITTED });
    expect(current()).toBe("signoff");
    cleanup();
    await open({ roles: ["REP"], step: "x", ...SUBMITTED });
    expect(current()).toBe("mapping");
  }, 90000);

  it("Show all steps reveals only PERMITTED steps in order (the cost steps are absent for a viewer without cost visibility), is remembered under the SAME key as Stage 1, and is restored; storage that throws still renders", async () => {
    const data: Record<string, string> = {};
    vi.stubGlobal("localStorage", { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } });
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED });
    fireEvent.click(screen.getByLabelText("Show all steps"));
    for (const s of ["mapping", "costs", "final", "signoff"]) expect(shown(s)).toBe(true);
    expect([...document.querySelectorAll("[data-step-panel]")].map((e) => e.getAttribute("data-step-panel")).filter((x) => ["mapping", "costs", "final", "signoff"].includes(x!))).toEqual(["mapping", "costs", "final", "signoff"]);
    expect(data["nq-builder-show-all"]).toBe("1");
    expect(screen.queryByTestId("step-buttons")).toBeNull();
    cleanup();
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED });
    await waitFor(() => expect(shown("costs")).toBe(true));
    cleanup();
    await open({ roles: ["REP"], ...SUBMITTED }); // no cost visibility: show-all adds no cost step
    await waitFor(() => expect(shown("signoff")).toBe(true));
    expect(panel("costs")).toBeNull(); expect(panel("final")).toBeNull();
    cleanup();
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED });
    expect(shown("signoff")).toBe(false);
    fireEvent.click(screen.getByLabelText("Show all steps"));
    expect(shown("signoff")).toBe(true);
  }, 90000);

  it("Next incomplete step leads only into the Estimator's own open work: Costs while the project costs are incomplete (this fixture: lines with no cost need attention), Final review once they are not; nothing for a Rep; nothing while the quote is a Rep draft with no blockers", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "1", ...SUBMITTED });
    fireEvent.click(screen.getByRole("button", { name: "Next incomplete step" }));
    expect(shown("costs")).toBe(true);
    cleanup();
    await open({ roles: ["REP"], ...SUBMITTED });
    expect(screen.queryByRole("button", { name: "Next incomplete step" })).toBeNull();
    cleanup();
    await open({ roles: ["ESTIMATOR"], commercials: true });
    expect(screen.queryByRole("button", { name: "Next incomplete step" })).toBeNull();
  }, 90000);

  it("switching stage keeps the address bar honest: ?step= follows the stage's own step and is dropped when it is the first", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED });
    fireEvent.click(rail().querySelector('[data-step="final"]')!);
    expect(new URL(window.location.href).searchParams.get("step")).toBe("3");
    fireEvent.click(document.querySelector('[data-stage="3"]')!);
    const u = new URL(window.location.href);
    expect(u.searchParams.get("stage")).toBe("3"); expect(u.searchParams.has("step")).toBe(false);
    fireEvent.click(document.querySelector('[data-stage="2"]')!);
    expect(new URL(window.location.href).searchParams.get("step")).toBe("3");
    expect(shown("final")).toBe(true);
  }, 30000);

  it("?stage=2&step=3 does not also move Stage 1's step", async () => {
    await open({ roles: ["REP", "ESTIMATOR"], commercials: true, step: "3" });
    fireEvent.click(document.querySelector('[data-stage="1"]')!);
    expect(document.querySelector('[data-step-panel="customer"]')!.hasAttribute("hidden")).toBe(false);
  }, 30000);

  it("the rail is one ordered list; the current step has aria-current; moving focuses its heading; the mobile summary spells out the completed count", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED });
    expect(rail().querySelectorAll("ol").length).toBe(1);
    expect(rail().querySelectorAll('[aria-current="step"]').length).toBe(1);
    expect(toggle()).toMatch(/^Step 2 of 4 · Costs, margins & pricing exceptions · 1 complete/);
    fireEvent.click(within(rail()).getByRole("button", { name: /Sign-off or return/ }));
    expect(rail().querySelector('[aria-current="step"]')!.textContent).toContain("Sign-off or return");
    expect(document.activeElement?.textContent).toBe("Step 4 · Sign-off or return");
  }, 30000);

  it("navigation never calls a server action: moving through every step and Back records nothing and sends nothing", async () => {
    const q = serialQueue(0);
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED });
    await sleep(1200);
    const before = started(q);
    for (const id of ["mapping", "final", "signoff", "costs", "mapping"]) fireEvent.click(rail().querySelector(`[data-step="${id}"]`)!);
    fireEvent.click(screen.getByLabelText("Show all steps"));
    await act(async () => { await sleep(200); });
    expect(started(q)).toBe(before);
  }, 60000);
});

describe("UX-006i2 Stage 2: statuses come from data, never from a visit", () => {
  it("an open manual-price reason makes the mapping step Needs attention (live); giving it clears it; visiting alone changes nothing", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "1", ...SUBMITTED });
    const before = status("mapping");
    fireEvent.click(within(rail()).getByRole("button", { name: /Costs/ })); fireEvent.click(within(rail()).getByRole("button", { name: /Product lines/ }));
    expect(status("mapping")).toBe(before);
    const reason = within(panel("mapping") as HTMLElement).getAllByLabelText("Reason", { selector: "input" })[0] as HTMLInputElement;
    await act(async () => { fireEvent.change(reason, { target: { value: "" } }); });
    expect(status("mapping")).toBe("Needs attention");
    expect(rail().textContent).toMatch(/manual price(s)? need(s)? a reason/);
    await act(async () => { fireEvent.change(reason, { target: { value: "Supplier quote" } }); });
    expect(status("mapping")).toBe("Complete");
  }, 60000);

  it("Save draft keeps the same stage and step for an Estimator (a draft change is not a workflow transition)", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "1", ...SUBMITTED });
    const reason = within(panel("mapping") as HTMLElement).getAllByLabelText("Reason", { selector: "input" })[0] as HTMLInputElement;
    await act(async () => { fireEvent.change(reason, { target: { value: "Supplier quote dated today" } }); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save draft" })); });
    await waitFor(() => expect(screen.getByText("All changes saved")).toBeTruthy(), { timeout: 8000 });
    expect(document.querySelector('[data-testid="stage-nav"] [aria-current="step"]')!.getAttribute("data-stage")).toBe("2");
    expect(current()).toBe("mapping");
  }, 60000);

  it("the Save draft button keeps its exact disabled reason: nothing to save until an edit", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "1", ...SUBMITTED });
    expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById("save-why")!.textContent).toBe("Nothing to save: there are no unsaved changes.");
  }, 30000);
});

describe("UX-006i2 Stage 2: the view follows real workflow transitions and nothing else (#176's pin, on READY fixtures)", () => {
  const SUB = SUBMITTED;
  const viewedStage = () => document.querySelector('[data-testid="stage-nav"] [aria-current="step"]')!.getAttribute("data-stage");
  // The fake database hands out its rows by reference, so a change must REPLACE the row (as a real database would), or the page's earlier view would change under it.
  const patchRow = (id: string, patch: (r: Record<string, unknown>) => Record<string, unknown>) => { const arr = db.rows("newquip_quotes") as Array<Record<string, unknown>>; const i = arr.findIndex((r) => r.id === id); arr[i] = { ...arr[i], ...patch(arr[i]) }; };
  const reread = async (id: string) => actions.getGrowerQuoteAction(id);

  it("Rep submit (Stage 1 step 5): the quote moves to Estimator review and the Rep stays on Stage 1 reading 'Rep preparation complete - next: Estimator' (read-only, pinned)", async () => {
    vi.spyOn(ca, "getQuoteCustomerAction").mockResolvedValue({ ok: true, data: { available: true, snapshot: { cin7CustomerId: "c1", name: { state: "present", value: "Acme" }, tradingName: { state: "missing" }, billingAddress: null, vatNumber: { state: "missing" }, currency: { state: "missing" }, paymentTerm: { state: "missing" }, contacts: [], chosenContact: { name: "Sean", email: "s@x.co", source: "CIN7_CONTACT", phone: null } }, snapshotId: "s1", seq: 1, issues: [], currency: null, selectedContactIndex: null, confirmationContact: null, editable: true, lockedReason: null, changeReturnsToRep: false, history: [] } } as never);
    await open({ stage: "1", roles: ["REP"], step: "5" });
    const id = g.__QID!;
    vi.spyOn(actions, "sendGrowerQuoteToEstimatorAction").mockImplementation((async () => { patchRow(id, () => ({ state: "ESTIMATOR_REVIEW", customer_confirmed_cents: 1000000000, customer_confirmed_by: "Sean", handoff_by_email: "rep@nq" })); return reread(id); }) as never);
    const sendBtn = await waitFor(() => within(panel("submit") as HTMLElement).getByRole("button", { name: "Submit to Estimator" }) as HTMLButtonElement, { timeout: 8000 });
    expect(sendBtn.disabled).toBe(true); // one explicit confirmation is needed first (i1)
    fireEvent.click(within(panel("submit") as HTMLElement).getByLabelText(/I confirm that Sean has confirmed the quotation total of/));
    const send = await waitFor(() => { const b = within(panel("submit") as HTMLElement).getByRole("button", { name: "Submit to Estimator" }) as HTMLButtonElement; expect(b.disabled).toBe(false); return b; }, { timeout: 8000 });
    fireEvent.click(send);
    await waitFor(() => expect(screen.getByTestId("rep-complete").textContent).toContain("Rep preparation complete - next: Estimator"), { timeout: 8000 });
    expect(viewedStage()).toBe("1");
    expect(screen.queryByRole("button", { name: "Submit to Estimator" })).toBeNull();
    expect((screen.getByTestId("stage1-layout") as HTMLFieldSetElement).disabled).toBe(true);
  }, 60000);

  it("Manager approval moves the view on (a real workflow change clears the pin): to the customer quotation stage", async () => {
    vi.spyOn(da, "getQuoteDeliveryAction").mockResolvedValue({ ok: true, data: { available: false } } as never);
    await open({ stage: "3", roles: ["MANAGER"], commercials: true, state: "ESTIMATOR_REVIEW", row: { ...SUB.row, __useDraftHash: true, requires_customer_acceptance: true } });
    const id = g.__QID!;
    vi.spyOn(actions, "approveGrowerQuoteAction").mockImplementation((async () => { patchRow(id, () => ({ state: "MANAGER_APPROVED_FINAL", approved_by_email: "m@nq" })); return reread(id); }) as never);
    const approve = await waitFor(() => { const b = screen.getByRole("button", { name: "Manager: final approval" }) as HTMLButtonElement; expect(b.disabled).toBe(false); return b; }, { timeout: 8000 });
    expect(viewedStage()).toBe("3");
    fireEvent.click(approve);
    await waitFor(() => expect(viewedStage()).toBe("4"), { timeout: 8000 });
  }, 60000);
});

// UX-006i1: the whole-quote loader lives ONLY in the collapsed "Testing utility (Preview only)" (server-derived previewTools flag). Loading it never moves the viewed step and runs only the preview.
const openTools = () => { document.querySelector('[data-testid="preview-tools"]')!.setAttribute("open", ""); return screen.getByRole("button", { name: "Load whole demonstration quote" }); };
describe("UX-006i2 Stage 2: the whole-quote loader (Preview utility) keeps the viewed step", () => {
  beforeEach(() => { vi.stubEnv("VERCEL_ENV", "preview"); });
  for (const [name, step] of [["Product lines & mapping review", "1"], ["Costs, margins & pricing exceptions", "2"], ["Final review", "3"], ["Sign-off or return", "4"]] as const) {
    it(`as an Estimator viewing ${name} in Estimator review: the loader stays put and runs ONLY the preview (no save, send, sign-off, return or approve)`, async () => {
      const q = serialQueue(0);
      await open({ roles: ["ESTIMATOR"], commercials: true, step, ...SUBMITTED });
      await sleep(1200);
      const which = current();
      q.log.length = 0;
      fireEvent.click(openTools());
      const replace = screen.queryByRole("button", { name: "Replace with demo" });
      if (replace) fireEvent.click(replace);
      await act(async () => { await sleep(900); });
      expect(current()).toBe(which);
      expect(new URL(window.location.href).searchParams.get("stage")).toBe("2");
      const ran = q.log.filter((l) => l.startsWith("start ")).map((l) => l.slice(6));
      expect(ran.filter((n) => /^(save|send|signOff|return|approve|create|post|record)/i.test(n.replace(/Grower|Quote/g, ""))), ran.join(",")).toEqual([]);
      expect(ran.every((n) => /^(previewGrowerDraftAction|getQuote|getGrowerQuote|getMapping|getQuoteScope|getQuoteCost|getQuoteCustomer|getQuoteDelivery)/.test(n)), ran.join(",")).toBe(true);
    }, 30000);
  }
  it("with Show all steps every permitted step stays visible after the loader", async () => {
    SHOWALL();
    await open({ roles: ["REP"], ...SUBMITTED });
    fireEvent.click(openTools());
    const replace = screen.queryByRole("button", { name: "Replace with demo" });
    if (replace) fireEvent.click(replace);
    await act(async () => { await sleep(50); });
    for (const s of ["mapping", "signoff"]) expect(shown(s)).toBe(true);
  }, 30000);
});

describe("UX-006i2 Stage 2: the requests made on mount do not depend on which step is shown", () => {
  const mounted = async (o: Parameters<typeof open>[0], showAll: boolean) => {
    vi.stubGlobal("localStorage", { getItem: (k: string) => (showAll && k === "nq-builder-show-all" ? "1" : null), setItem: () => undefined });
    const q = serialQueue(0);
    await open(o);
    await sleep(2500); // past the Scope and Cost panels' 800 ms mount timers
    const log = q.log.filter((l) => l.startsWith("start ")).sort();
    cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks();
    return log;
  };
  it("Estimator (four steps): the same server-action calls guided as with Show all steps", async () => {
    const o = { roles: ["ESTIMATOR"] as Role[], commercials: true, ...SUBMITTED };
    const guided = await mounted(o, false);
    db = new FakeDb(); vi.clearAllMocks(); asRoles("REP");
    const all = await mounted(o, true);
    expect(guided).toEqual(all);
    expect(guided.filter((l) => l === "start getQuoteScopeAction").length).toBeGreaterThanOrEqual(1);
    expect(guided.filter((l) => l === "start getQuoteCostEstimateAction").length).toBeGreaterThanOrEqual(2);
  }, 60000);
  it("Rep (two steps): the same calls guided as with Show all steps, and no cost estimate is ever requested", async () => {
    const guided = await mounted({ ...SUBMITTED }, false);
    db = new FakeDb(); vi.clearAllMocks(); asRoles("REP");
    const all = await mounted({ ...SUBMITTED }, true);
    expect(guided).toEqual(all);
    expect(guided).not.toContain("start getQuoteCostEstimateAction");
  }, 60000);
});

describe("UX-006i2 review fixes: wording that is true to the current state (reviewer findings)", () => {
  it("the 'needed from you' list is derived from the CURRENT open items by kind: with the products confirmed it asks only for manual prices (no stale 'choose the product'), each line once", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, draftOver: { estimator: { ...draft.estimator, priceResolutions: {} } } });
    const items = [...screen.getByTestId("rep-waiting-banner").querySelectorAll("li")].map((l) => l.textContent!);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((t) => /^Choose or confirm the product for |^Enter a manual quotation price for |^\d+ manual prices? needs? a reason/.test(t)), items.join(" | ")).toBe(true);
    expect(items.some((t) => t.startsWith("Enter a manual quotation price for "))).toBe(true); // the price kind is named as such, not as "choose the product"
    expect(items.filter((t) => t.includes("Feed saver mat")).every((t) => t.startsWith("Enter a manual"))).toBe(true); // a line whose product is confirmed is not asked for again
    expect(new Set(items).size).toBe(items.length);
    expect(screen.getByTestId("all-steps-complete").textContent).toBe("Next: choose the products listed above, then save.");
  }, 30000);

  it("the stage line is consistent for an Estimator on a Rep draft: 'your mapping is needed', never 'Starts once the quote is READY'", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, draftOver: UNMAPPED });
    const next = screen.getByTestId("next-action").textContent!;
    expect(next).not.toMatch(/Starts once the quote is READY/);
    expect(next).toMatch(/Estimator: map the products and enter the manual prices/);
    expect(document.querySelector('[data-stage="2"]')!.textContent).toContain("Your mapping is needed");
  }, 30000);

  it("Costs reads 'To review in Final review' until the review is marked, then 'Reviewed' (counted with Final review); the mark is stated as SESSION-ONLY (confirmation and a note on the step); nothing is saved", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "3", ...SUBMITTED });
    expect(status("costs")).toBe("Needs attention"); // UX-006 corrections: lines with no cost make Costs need attention (it was "To review in Final review" while costs looked complete)
    expect(rail().querySelector('[data-step="costs"]')!.textContent).toMatch(/\d+ lines? (has|have) no cost/);
    expect(screen.getByTestId("session-only-note").textContent).toMatch(/this session only: it is not saved, and after a reload you mark it again/);
    fireEvent.click(screen.getByRole("button", { name: /Mark reviewed/ }));
    expect(status("costs")).toBe("Reviewed");
    expect(rail().querySelector('[data-step="costs"]')!.textContent).toContain("session only");
    expect(screen.getByTestId("cost-ack-live").textContent).toBe("Final review marked as reviewed for this session. This is not a sign-off.");
    fireEvent.click(rail().querySelector('[data-step="final"]')!);
    expect(screen.getByTestId("cost-ack-done").textContent).toContain("Marked reviewed for this session (not saved - repeat after a reload before signing off)");
    expect(screen.getByTestId("final-review-checklist").textContent).toMatch(/Costing figures: incomplete \(\d+ lines? (has|have) no cost\)/); // ONE margin story: attention, never "Met", while project costs are incomplete
    expect(screen.getByTestId("final-check-costing").textContent).toBe("Not met");
  }, 60000);

  it("a Rep reaching Stage 2 has NO 'Next' that dead-ends: only the way back to their own stage; a Manager or observer inspects with a secondary Next that records nothing", async () => {
    await open({ roles: ["REP"], ...SUBMITTED });
    const bar = await screen.findByTestId("step-buttons", {}, { timeout: 8000 });
    expect(within(bar).queryByRole("button", { name: /^Next/ })).toBeNull();
    fireEvent.click(within(bar).getByRole("button", { name: "Return to Stage 1" }));
    expect(document.querySelector('[data-testid="stage-nav"] [aria-current="step"]')!.getAttribute("data-stage")).toBe("1");
  }, 60000);

  it("a Manager inspecting Stage 2 gets a SECONDARY Next that records nothing (not the primary action)", async () => {
    await open({ roles: ["MANAGER"], commercials: true, ...SUBMITTED });
    const bar = await screen.findByTestId("step-buttons", {}, { timeout: 8000 });
    const next = within(bar).getByRole("button", { name: /^Next:/ });
    expect(next.className).not.toMatch(/bg-indigo-600/);
  }, 60000);

  it("the manual-price inputs have UNIQUE accessible names (the line is in the name), and the plain-language term help is present", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "1", ...SUBMITTED });
    const names = [...panel("mapping")!.querySelectorAll("input[aria-label]")].map((i) => i.getAttribute("aria-label")!).filter((n) => /^Unit price for |^Reason for the manual price of /.test(n));
    expect(names.length).toBeGreaterThanOrEqual(4);
    expect(new Set(names).size).toBe(names.length);
    const help = screen.getByTestId("terms-help").textContent!;
    for (const term of ["Source-backed:", "Workbook basis:", "Default with override:", "Provisional:"]) expect(help).toContain(term);
  }, 30000);

  it("the Scope panel's package note names the Estimator or Manager (one consistent owner)", async () => {
    const src = (await import("node:fs")).readFileSync(`${__dirname}/../[id]/ScopePanel.tsx`, "utf8");
    expect(src).toContain("An Estimator or Manager can map this package.");
    expect(src).not.toContain("A manager can map");
  });
});

describe("UX-006i2 round 2: sign-off waits for the review mark, one margin story, labels", () => {
  const signBtn = () => screen.getByRole("button", { name: "Sign off for Manager approval" }) as HTMLButtonElement;
  it("Sign off is visible but DISABLED with the visible reason until the review is marked; Return to the Rep is never gated; marking enables it", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "4", ...SUBMITTED });
    expect(signBtn().disabled).toBe(true);
    expect(document.getElementById("signoff-why")!.textContent).toBe("Mark the costing reviewed first (Final review).");
    expect(signBtn().getAttribute("aria-describedby")).toBe("signoff-why");
    expect(rail().querySelector('[data-step="signoff"]')!.textContent).toContain("Sign-off waits for the final review mark; Return is open");
    expect(status("signoff")).not.toBe("Locked"); // the step is open; only the sign-off action waits
    fireEvent.change(screen.getByLabelText(/Return to rep — reason/), { target: { value: "Wrong delivery charge" } });
    expect((screen.getByRole("button", { name: "Return to rep" }) as HTMLButtonElement).disabled).toBe(false); // never gated by the mark
    fireEvent.click(rail().querySelector('[data-step="final"]')!);
    fireEvent.click(screen.getByRole("button", { name: /Mark reviewed/ }));
    expect(signBtn().disabled).toBe(false);
    expect(document.getElementById("signoff-why")).toBeNull() ;
    expect(screen.getByTestId("signoff-effect").textContent).toBe("Signs off this version for the Manager. Any later edit withdraws it.");
    expect(signBtn().getAttribute("aria-describedby")).toBe("signoff-effect");
    // an unsaved edit invalidates the mark, and the sign-off waits again
    fireEvent.click(rail().querySelector('[data-step="mapping"]')!);
    await act(async () => { fireEvent.change(within(panel("mapping") as HTMLElement).getAllByLabelText("Reason", { selector: "input" })[0], { target: { value: "Changed after the review" } }); });
    fireEvent.click(rail().querySelector('[data-step="signoff"]')!);
    expect(status("signoff")).not.toBe("Locked");
  }, 60000);

  it("with incomplete project costs the sign-off step says what the Manager will see, next to the button, and does NOT block", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "3", ...SUBMITTED });
    fireEvent.click(screen.getByRole("button", { name: /Mark reviewed/ }));
    expect(screen.getByTestId("signoff-costs-consequence").textContent).toMatch(/^Costs are incomplete for \d+ lines?\. If you sign off, the Manager will see margin as unknown\.$/);
    expect(signBtn().disabled).toBe(false);
    expect(signBtn().parentElement!.contains(screen.getByTestId("signoff-costs-consequence"))).toBe(true); // adjacent to the button
  }, 60000);

  it("ONE margin story: the summary bar, the totals and the Final review all say 'indicative (price-list basis)' with the number of lines with no cost; the margin detail and cost capture disclosures open on their own", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "2", ...SUBMITTED });
    const bar = screen.getByTestId("quote-summary-bar");
    expect(within(bar).getByText("Indicative margin (price-list basis)")).toBeTruthy();
    expect(screen.getByTestId("summary-margin-note").textContent).toMatch(/project margin not available: \d+ lines? (has|have) no cost/);
    expect(screen.getByTestId("totals-margin-note").textContent).toMatch(/project margin not available/);
    expect(panel("costs")!.textContent).toContain("Estimated cost · indicative margin (price-list basis)");
    expect(screen.getByTestId("disc-margin").hasAttribute("open")).toBe(true);
    expect(screen.getByTestId("disc-cost-capture").hasAttribute("open")).toBe(true);
    expect(screen.getByTestId("disc-scope").hasAttribute("open")).toBe(false);
    expect(within(screen.getByTestId("disc-scope")).getByText("Physical scope")).toBeTruthy();
  }, 60000);

  it("a Rep never sees any margin wording (unchanged)", async () => {
    await open({ roles: ["REP"], ...SUBMITTED });
    expect(document.body.textContent).not.toMatch(/margin/i);
  }, 30000);
});

describe("UX-006 corrections: incompleteness is visible, the Estimator's items are theirs, first action near the top", () => {
  it("the header says 'Not commercially ready' with the counts (cost viewers) and never a plain green Ready for an incomplete estimate; the Rep sees none of it", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED });
    const chip = screen.getByTestId("commercial-chip").textContent!;
    expect(chip).toMatch(/^.?Not commercially ready: .*\d+ lines? (has|have) no cost.*\(amounts are indicative\)$/);
    expect(within(screen.getByTestId("quote-summary-bar")).getByText("Indicative: not commercially ready")).toBeTruthy(); // the calculation chip is not "Ready for review"
    expect(within(screen.getByTestId("quote-summary-bar")).queryByText(/READY FOR REVIEW/i)).toBeNull();
    cleanup();
    await open({ roles: ["REP"], ...SUBMITTED });
    expect(screen.queryByTestId("commercial-chip")).toBeNull();
    expect(document.body.textContent).not.toMatch(/commercially ready|indicative/i);
  }, 60000);

  it("a SUBMITTED quotation with open Estimator items: Stage 2 opens at step 1, says they are the Estimator's by design, and keeps sign-off disabled with the reason; Return stays available", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED, draftOver: UNMAPPED });
    expect(current()).toBe("mapping");
    const banner = screen.getByTestId("rep-waiting-banner");
    expect(banner.textContent).toContain("Yours to resolve: the Rep has already submitted");
    expect(screen.getByTestId("waiting-explain").textContent).toMatch(/Estimator items by design.*Sign-off stays disabled/);
    expect(status("mapping")).toBe("Needs attention");
    expect(rail().querySelector('[data-step="mapping"]')!.textContent).toMatch(/\d+ lines? unmapped/);
    fireEvent.click(rail().querySelector('[data-step="signoff"]')!);
    expect((screen.getByRole("button", { name: "Sign off for Manager approval" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById("signoff-why")!.textContent).toMatch(/must be READY/);
    fireEvent.change(screen.getByLabelText(/Return to rep — reason/), { target: { value: "Reconfirm" } });
    expect((screen.getByRole("button", { name: "Return to rep" }) as HTMLButtonElement).disabled).toBe(false);
  }, 60000);

  it("Final review lists exactly what is open, with its owner, under 'Not commercially ready'", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "3", ...SUBMITTED });
    const d = screen.getByTestId("not-commercially-ready");
    expect(d.textContent).toMatch(/Not commercially ready: .*no cost/);
    expect(within(d).getAllByRole("listitem").every((li) => li.textContent!.startsWith("Estimator:"))).toBe(true);
    expect(d.textContent).toMatch(/lines? (has|have) no cost: capture it from Cin7 or enter a manual estimate/);
  }, 60000);

  it("when the total differs from what the customer confirmed, ONE banner says so with both amounts, on Stage 2; Return stays available", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, state: "ESTIMATOR_REVIEW", row: { customer_confirmed_cents: 100, customer_confirmed_by: "A", customer_confirmed_at: "2026-11-02T08:00:00Z" } });
    expect(screen.getAllByTestId("total-changed").length).toBe(1);
    expect(screen.getByTestId("total-changed").textContent).toMatch(/The total changed from what the customer confirmed \(R.*1,00 -> R.*\)\. Return to the Rep to reconfirm\./);
    fireEvent.click(rail().querySelector('[data-step="signoff"]')!);
    fireEvent.change(screen.getByLabelText(/Return to rep — reason/), { target: { value: "Reconfirm the price" } });
    expect((screen.getByRole("button", { name: "Return to rep" }) as HTMLButtonElement).disabled).toBe(false);
  }, 60000);

  it("the first action of step 1 (Confirm source-backed mappings) comes BEFORE the readiness list and the line table, and exists once", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, draftOver: UNMAPPED });
    const first = screen.getByTestId("step1-first-action");
    expect(screen.getAllByRole("button", { name: "Confirm source-backed mappings" }).length).toBe(1);
    const p = panel("mapping")!;
    expect(first.compareDocumentPosition(p.querySelector("table")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(first.compareDocumentPosition(screen.getByText("Quote readiness")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("rep-waiting-banner").hasAttribute("open")).toBe(true); // the list is open when it is the primary task, as a counted disclosure
    expect(screen.getByTestId("rep-waiting-banner").querySelector("summary")!.textContent).toMatch(/· \d+ items?/);
  }, 60000);

  it("touch targets: the Costs-step buttons, the shared inputs and the approval-history summary carry 44px size classes (class contract)", async () => {
    const fs = await import("node:fs");
    const cost = fs.readFileSync(`${__dirname}/../[id]/CostPanel.tsx`, "utf8");
    expect(cost.match(/<Button size="sm"(?! className="min-h-11")/g)).toBeNull();
    expect(fs.readFileSync(`${__dirname}/../fields.tsx`, "utf8").match(/h-9 min-h-11/g)!.length).toBe(2);
    expect(fs.readFileSync(`${__dirname}/../../../components/ui/Input.tsx`, "utf8")).toContain("h-9 min-h-11");
    expect(fs.readFileSync(`${__dirname}/../../../components/ApprovalHistory.tsx`, "utf8")).toContain("inline-flex min-h-11");
  });
});
