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

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
async function open(o: { roles?: Role[]; commercials?: boolean; state?: string; row?: Record<string, unknown>; step?: string; draftOver?: Record<string, unknown> } = {}) {
  g.__STAGE = "2"; g.__STEP = o.step;
  asRoles(...(o.roles ?? ["REP"]));
  vi.mocked(canSeeCosts).mockResolvedValue(o.commercials ?? false);
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, { ...draft, customerName: "Acme Pigs", siteName: "Farm 1", ...o.draftOver });
  for (const row of db.rows("newquip_quotes") as Array<Record<string, unknown>>) if (row.id === id) { if (o.state) row.state = o.state; const { __useDraftHash, ...rest } = (o.row ?? {}) as Record<string, unknown>; Object.assign(row, rest); if (__useDraftHash) Object.assign(row, { estimator_signoff_hash: row.draft_hash, estimator_signoff_by_email: "e@nq" }); }
  g.__QID = id;
  const { default: Page } = await import("../[id]/page");
  render(createElement(Page));
  await waitFor(() => expect(screen.getByTestId("step-rail")).toBeTruthy(), { timeout: 8000 });
}
const rail = () => screen.getByRole("navigation", { name: "Costing and review steps" });
const ids = () => [...rail().querySelectorAll("ol > li button")].map((b) => b.getAttribute("data-step"));
const status = (id: string) => screen.getByTestId(`step-status-${id}`).textContent;
const gstatus = (g: string) => (screen.getByTestId(`step-group-status-${g}`).textContent ?? "").replace(/^[^A-Za-z]+/, ""); // without the tone glyph
const gcount = (g: string) => screen.getByTestId(`step-group-count-${g}`).textContent;
const panel = (id: string) => document.querySelector(`[data-step-panel="${id}"]`);
const shown = (id: string) => !!panel(id) && !panel(id)!.hasAttribute("hidden");

describe("UX-006b Stage 2 groups: who has which steps", () => {
  it("a Rep (no cost visibility) has FOUR steps in two groups; nothing anywhere names or shows cost and margin", async () => {
    await open();
    expect(ids()).toEqual(["lines", "charges", "submit", "signoff"]);
    expect(rail().querySelectorAll("ol > li").length).toBe(4);
    expect(panel("cost")).toBeNull();
    expect(gcount("rep")).toBe("2 of 3 complete");
    expect(gcount("estimator")).toBe("0 of 1 complete"); // only the sign-off: the Cost & margin step does not exist for them
    const text = document.body.textContent ?? "";
    for (const leak of ["Cost & margin", "Internal margins", "Estimated cost", "GP (managers)", "Cin7 latest cost"]) expect(text, leak).not.toContain(leak);
    expect(document.querySelector('[data-step="cost"]')).toBeNull();
    expect(screen.getByText("Totals")).toBeTruthy(); // what they already had stays
    expect(panel("lines")!.textContent).toContain("Physical scope");
  }, 30000);

  it("an Estimator with cost visibility has FIVE steps; the cost step is mounted (hidden + inert) and holds scope, cost, totals and margin", async () => {
    await open({ roles: ["REP", "ESTIMATOR"], commercials: true });
    expect(ids()).toEqual(["lines", "charges", "submit", "cost", "signoff"]);
    expect(gcount("estimator")).toBe("0 of 2 complete");
    const cost = panel("cost")!;
    expect(cost.hasAttribute("hidden")).toBe(true); expect(cost.hasAttribute("inert")).toBe(true);
    await waitFor(() => expect(cost.textContent).toContain("Internal margins"), { timeout: 8000 });
    expect(cost.textContent).toContain("Totals"); expect(cost.textContent).toContain("Estimated cost");
  }, 30000);

  it("each step holds its own panels: readiness, line decisions and mappings (1); commercial inputs, prices, exclusions (2); the Rep's price confirmation and send (3); the Estimator's sign-off and return (last)", async () => {
    await open({ roles: ["REP", "ESTIMATOR"], commercials: true });
    expect(panel("lines")!.textContent).toMatch(/Quote readiness[\s\S]*Line decisions[\s\S]*Product mappings/);
    expect(within(panel("lines") as HTMLElement).getByRole("button", { name: "Confirm source-backed mappings" })).toBeTruthy();
    expect(panel("charges")!.textContent).toMatch(/Commercial inputs[\s\S]*Customer-driven exclusions/);
    await waitFor(() => expect(within(panel("submit") as HTMLElement).getByRole("button", { name: /Record pre-approval price confirmation/, hidden: true })).toBeTruthy());
    expect(panel("signoff")!.textContent).toContain("Estimator review and handoff");
    expect(within(panel("signoff") as HTMLElement).queryByRole("button", { name: /Record pre-approval price confirmation/, hidden: true })).toBeNull();
  }, 30000);

  it("the three concepts are labelled apart: 'Calculation' on the readiness chip, 'Workflow' on each group's status line", async () => {
    await open();
    expect(within(screen.getByTestId("quote-summary-bar")).getByText("Calculation")).toBeTruthy();
    expect(gstatus("rep")).toMatch(/^Workflow: /); expect(gstatus("estimator")).toMatch(/^Workflow: /);
  }, 30000);
});

describe("UX-006b Stage 2 groups: workflow status per state and role (authoritative fields only)", () => {
  it("Rep draft, prepared and READY: 'Ready - not yet submitted'; the Estimator group waits for the Rep; Submit is Not complete", async () => {
    await open();
    await waitFor(() => expect(gstatus("rep")).toBe("Workflow: Ready - not yet submitted"));
    expect(gstatus("estimator")).toBe("Workflow: Waiting for the Rep to submit");
    expect(status("submit")).toBe("Not complete");
  }, 30000);

  it("Rep draft with an open exclusion reason: 'Preparation incomplete' (never 'ready' when the data says otherwise)", async () => {
    await open();
    const box = within(panel("charges") as HTMLElement).getByLabelText(/Exclude Feed saver mat/) as HTMLInputElement;
    await act(async () => { fireEvent.click(box); });
    expect(gstatus("rep")).toBe("Workflow: Preparation incomplete");
    expect(status("charges")).toBe("Needs attention");
  }, 30000);

  it("submitted (ESTIMATOR_REVIEW), Rep's view: all Rep steps Complete, 'Submitted - awaiting the Estimator', sign-off Not complete (never 'Needs attention' for the Rep), and Next incomplete has nothing for them", async () => {
    await open({ roles: ["REP"], state: "ESTIMATOR_REVIEW", row: { customer_confirmed_cents: 100, handoff_by_email: "r@nq" } });
    expect(gstatus("rep")).toBe("Workflow: Submitted - awaiting the Estimator");
    expect(gcount("rep")).toBe("3 of 3 complete");
    expect(gstatus("estimator")).toBe("Workflow: Awaiting Estimator review");
    expect(status("signoff")).toBe("Not complete");
    expect(screen.queryByRole("button", { name: "Next incomplete step" })).toBeNull();
    expect(screen.getByTestId("all-steps-complete").textContent).toBe("Nothing is left for you in this stage.");
    expect(rail().textContent).not.toMatch(/need attention/);
  }, 30000);

  it("submitted, Estimator's view: 'Awaiting your review'; Next incomplete leads into the Estimator's own work, not the Rep's", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, state: "ESTIMATOR_REVIEW", row: { customer_confirmed_cents: 100 } });
    expect(gstatus("estimator")).toBe("Workflow: Awaiting your review");
    expect(rail().querySelector('[data-step="signoff"]')!.textContent).toContain("Awaiting your review");
    fireEvent.click(screen.getByRole("button", { name: "Next incomplete step" }));
    expect(shown("cost")).toBe(true); // cost & margin first, then sign-off; never the Rep's steps
    fireEvent.click(screen.getByRole("button", { name: "Next incomplete step" }));
    expect(shown("signoff")).toBe(true);
  }, 30000);

  it("returned to the Rep (REP_DRAFT, revision 2): says so in both groups and offers the reconfirmation", async () => {
    await open({ row: { revision: 2 } });
    expect(gstatus("rep")).toBe("Workflow: Returned to the Rep (revision 2)");
    expect(gstatus("estimator")).toBe("Workflow: Returned to the Rep");
    expect(rail().querySelector('[data-step="submit"]')!.textContent).toContain("Returned: reconfirm the amount with the customer");
  }, 30000);

  it("a stale sign-off asks the Estimator to review again", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, state: "ESTIMATOR_REVIEW", row: { estimator_signoff_hash: "stale-hash", estimator_signoff_by_email: "e@nq" } });
    expect(gstatus("estimator")).toBe("Workflow: Sign-off out of date: review again");
    expect(status("signoff")).toBe("Needs attention");
  }, 30000);

  it("a sign-off on THIS content is Complete and both groups say 'Signed off'", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, state: "ESTIMATOR_REVIEW", row: { __useDraftHash: true } });
    expect(gstatus("estimator")).toBe("Workflow: Signed off");
    expect(gstatus("rep")).toBe("Workflow: Signed off");
    expect(status("signoff")).toBe("Complete");
  }, 30000);

  it("approved, read-only Manager: everything Complete, Save explains it, the rail still navigates, frozen scope evidence stays with the sign-off step", async () => {
    await open({ roles: ["MANAGER"], commercials: true, state: "MANAGER_APPROVED_FINAL" });
    expect(gstatus("rep")).toBe("Workflow: Approved"); expect(gstatus("estimator")).toBe("Workflow: Approved");
    expect(status("signoff")).toBe("Complete");
    expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(rail()).getByRole("button", { name: /Charges/ }));
    expect(shown("charges")).toBe(true);
    expect(panel("charges")!.closest("fieldset")!.disabled).toBe(true);
    expect(panel("signoff")!.textContent).toContain("Physical scope");
  }, 30000);

  it("a Manager sees both groups' work as their own (oversight) and can navigate to every step", async () => {
    await open({ roles: ["MANAGER"], commercials: true, state: "ESTIMATOR_REVIEW", row: { customer_confirmed_cents: 100 } });
    for (const id of ["lines", "charges", "submit", "cost", "signoff"]) { fireEvent.click(rail().querySelector(`[data-step="${id}"]`)!); expect(shown(id)).toBe(true); }
  }, 30000);
});

describe("UX-006b Stage 2 groups: navigation", () => {
  it("step 1 is current by default; Next and Back move through the steps, update ?step= and focus the new heading; steps are NOT gates", async () => {
    await open({ roles: ["REP", "ESTIMATOR"], commercials: true });
    expect(rail().querySelector('[aria-current="step"]')!.textContent).toContain("Lines & mappings");
    for (const s of ["charges", "submit", "cost", "signoff"]) { expect(shown(s)).toBe(false); expect(panel(s)!.hasAttribute("inert")).toBe(true); }
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(new URL(window.location.href).searchParams.get("step")).toBe("2");
    expect(shown("charges")).toBe(true);
    expect(document.activeElement?.textContent).toBe("Step 2 · Charges & prices");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(shown("lines")).toBe(true);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.click(within(rail()).getByRole("button", { name: /Sign-off or return/ }));
    expect(shown("signoff")).toBe(true);
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  }, 30000);

  it("?step= is validated against THIS viewer's steps: a Rep (four) given 5 falls back to step 1; an Estimator given 4 opens Cost & margin; ?step=4 for a Rep is the sign-off view", async () => {
    await open({ step: "5" });
    expect(shown("lines")).toBe(true);
    cleanup();
    await open({ roles: ["REP", "ESTIMATOR"], commercials: true, step: "4" });
    expect(shown("cost")).toBe(true);
    cleanup();
    await open({ step: "4" });
    expect(shown("signoff")).toBe(true);
    cleanup();
    await open({ step: "x" });
    expect(shown("lines")).toBe(true);
  }, 60000);

  it("a Rep opening ?step=5 sees step 1 and Back/Next, the step state and the address bar agree (no jump to the last step)", async () => {
    window.history.replaceState(null, "", "/newquip-grower/x?stage=2&step=5");
    await open({ step: "5" });
    expect(shown("lines")).toBe(true);
    await waitFor(() => expect(new URL(window.location.href).searchParams.has("step")).toBe(false));
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(shown("charges")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(shown("lines")).toBe(true);
  }, 30000);

  it("moving between steps writes stage=2 together with step, so a reload with no ?stage= still lands on the step", async () => {
    window.history.replaceState(null, "", "/newquip-grower/x");
    await open({ roles: ["REP", "ESTIMATOR"], commercials: true });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const q = new URL(window.location.href).searchParams;
    expect(q.get("stage")).toBe("2"); expect(q.get("step")).toBe("2");
  }, 30000);

  it("?stage=2&step=3 does not also move Stage 1's step", async () => {
    await open({ roles: ["REP", "ESTIMATOR"], commercials: true, step: "3" });
    fireEvent.click(document.querySelector('[data-stage="1"]')!);
    expect(document.querySelector('[data-step-panel="customer"]')!.hasAttribute("hidden")).toBe(false);
  }, 30000);

  it("Show all steps reveals every step in the group order, is remembered under the SAME key as Stage 1, and is restored; storage that throws still renders", async () => {
    const data: Record<string, string> = {};
    vi.stubGlobal("localStorage", { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } });
    await open({ roles: ["REP", "ESTIMATOR"], commercials: true });
    fireEvent.click(screen.getByLabelText("Show all steps"));
    for (const s of ["lines", "charges", "submit", "cost", "signoff"]) expect(shown(s)).toBe(true);
    expect([...document.querySelectorAll("[data-step-panel]")].map((e) => e.getAttribute("data-step-panel")).filter((x) => ["lines", "charges", "submit", "cost", "signoff"].includes(x!))).toEqual(["lines", "charges", "submit", "cost", "signoff"]);
    expect(data["nq-builder-show-all"]).toBe("1");
    expect(screen.queryByTestId("step-buttons")).toBeNull();
    cleanup();
    await open({ roles: ["REP", "ESTIMATOR"], commercials: true });
    await waitFor(() => expect(shown("cost")).toBe(true));
    cleanup();
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    await open();
    expect(shown("charges")).toBe(false);
    fireEvent.click(screen.getByLabelText("Show all steps"));
    expect(shown("charges")).toBe(true);
  }, 60000);

  it("Next incomplete step (Rep, prepared, not submitted) goes to the Submit step: the Rep's own last action, never the Estimator's", async () => {
    await open();
    await waitFor(() => expect(status("lines")).toBe("Complete"));
    fireEvent.click(screen.getByRole("button", { name: "Next incomplete step" }));
    expect(shown("submit")).toBe(true);
  }, 30000);

  it("switching stage keeps the address bar honest: ?step= follows the stage's own step and is dropped when it is the first", async () => {
    await open({ roles: ["REP", "ESTIMATOR"], commercials: true });
    fireEvent.click(within(rail()).getByRole("button", { name: /Cost & margin/ }));
    expect(new URL(window.location.href).searchParams.get("step")).toBe("4");
    fireEvent.click(document.querySelector('[data-stage="3"]')!);
    const u = new URL(window.location.href);
    expect(u.searchParams.get("stage")).toBe("3"); expect(u.searchParams.has("step")).toBe(false);
    fireEvent.click(document.querySelector('[data-stage="2"]')!);
    expect(new URL(window.location.href).searchParams.get("step")).toBe("4");
    expect(shown("cost")).toBe(true);
  }, 30000);

  it("the rail is an ordered list inside two labelled groups; the current step has aria-current and moving focuses its heading", async () => {
    await open();
    expect(rail().querySelectorAll("ol").length).toBeGreaterThan(0);
    expect(rail().querySelectorAll('[role="group"]').length).toBe(2);
    expect(rail().querySelectorAll('[aria-current="step"]').length).toBe(1);
    fireEvent.click(within(rail()).getByRole("button", { name: /Sign-off or return/ }));
    expect(rail().querySelector('[aria-current="step"]')!.textContent).toContain("Sign-off or return");
    expect(document.activeElement?.textContent).toBe("Step 4 · Sign-off or return");
  }, 30000);
});

describe("UX-006b Stage 2 groups: statuses come from data, never from a visit", () => {
  it("an excluded item with no reason makes the charges step Needs attention (live); giving the reason clears it; visiting alone changes nothing", async () => {
    await open({ roles: ["REP", "ESTIMATOR"], commercials: true });
    const before = status("charges");
    fireEvent.click(within(rail()).getByRole("button", { name: /Charges/ }));
    expect(status("charges")).toBe(before);
    const box = within(panel("charges") as HTMLElement).getByLabelText(/Exclude Feed saver mat/) as HTMLInputElement;
    await act(async () => { fireEvent.click(box); });
    expect(status("charges")).toBe("Needs attention");
    expect(rail().textContent).toContain("1 excluded item needs a reason");
    await act(async () => { fireEvent.change((within(panel("charges") as HTMLElement).getAllByPlaceholderText("Reason (required)") as HTMLInputElement[]).find((i) => i.value === "")!, { target: { value: "Customer supplies it" } }); });
    expect(rail().textContent).not.toContain("needs a reason");
  }, 30000);

  it("the Save draft button keeps its exact disabled reason while a blank exclusion reason is open", async () => {
    await open({ roles: ["REP", "ESTIMATOR"], commercials: true });
    const box = within(panel("charges") as HTMLElement).getByLabelText(/Exclude Feed saver mat/) as HTMLInputElement;
    await act(async () => { fireEvent.click(box); });
    expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.getElementById("save-why")!.textContent).toBe("Give every excluded item a reason or remove it before saving.");
  }, 30000);

  it("the existing action buttons keep their gates: the non-Rep cannot send; the Rep cannot sign off", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true });
    const send = await waitFor(() => within(panel("submit") as HTMLElement).getByRole("button", { name: /Record pre-approval price confirmation/, hidden: true }) as HTMLButtonElement);
    expect(send.disabled).toBe(true);
    cleanup();
    await open({ roles: ["REP"], state: "ESTIMATOR_REVIEW" });
    const so = within(panel("signoff") as HTMLElement).getByRole("button", { name: /Estimator: I double-checked/, hidden: true }) as HTMLButtonElement;
    expect(so.disabled).toBe(true);
    expect(document.getElementById("signoff-why")!.textContent).toMatch(/Only an Estimator can sign off/);
  }, 60000);

  it("a Manager with no edit permission still navigates; the cost step's status is derived from the loaded budget", async () => {
    await open({ roles: ["MANAGER"], commercials: true });
    fireEvent.click(within(rail()).getByRole("button", { name: /Cost & margin/ }));
    expect(shown("cost")).toBe(true);
    expect(["Review needed", "Needs attention", "Not complete"]).toContain(status("cost"));
  }, 30000);
});

describe("UX-006b Stage 2 steps: the requests made on mount do not depend on which step is shown", () => {
  const started = async (o: Parameters<typeof open>[0], showAll: boolean) => {
    vi.stubGlobal("localStorage", { getItem: (k: string) => (showAll && k === "nq-builder-show-all" ? "1" : null), setItem: () => undefined });
    const q = serialQueue(0);
    await open(o);
    await sleep(2500); // past the Scope and Cost panels' 800 ms mount timers
    const log = q.log.filter((l) => l.startsWith("start ")).sort();
    cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks();
    return log;
  };
  it("Estimator (four steps): the same server-action calls guided as with Show all steps", async () => {
    const o = { roles: ["REP", "ESTIMATOR"] as Role[], commercials: true };
    const guided = await started(o, false);
    db = new FakeDb(); vi.clearAllMocks(); asRoles("REP");
    const all = await started(o, true);
    expect(guided).toEqual(all);
    expect(guided.filter((l) => l === "start getQuoteScopeAction").length).toBeGreaterThanOrEqual(1);
    expect(guided.filter((l) => l === "start getQuoteCostEstimateAction").length).toBeGreaterThanOrEqual(2); // immediate + the 800 ms timer, although the step is hidden
  }, 60000);
  it("Rep (three steps): the same calls guided as with Show all steps, and no cost estimate is ever requested", async () => {
    const guided = await started({}, false);
    db = new FakeDb(); vi.clearAllMocks(); asRoles("REP");
    const all = await started({}, true);
    expect(guided).toEqual(all);
    expect(guided).not.toContain("start getQuoteCostEstimateAction");
  }, 60000);
});
