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
  for (const row of db.rows("newquip_quotes") as Array<Record<string, unknown>>) if (row.id === id) { if (o.state) row.state = o.state; Object.assign(row, o.row ?? {}); }
  g.__QID = id;
  const { default: Page } = await import("../[id]/page");
  render(createElement(Page));
  await waitFor(() => expect(screen.getByTestId("step-rail")).toBeTruthy(), { timeout: 8000 });
}
const rail = () => screen.getByRole("navigation", { name: "Costing and review steps" });
const ids = () => [...rail().querySelectorAll("ol > li button")].map((b) => b.getAttribute("data-step"));
const status = (id: string) => screen.getByTestId(`step-status-${id}`).textContent;
const panel = (id: string) => document.querySelector(`[data-step-panel="${id}"]`);
const shown = (id: string) => !!panel(id) && !panel(id)!.hasAttribute("hidden");

describe("UX-006b Stage 2 steps: who has which steps", () => {
  it("a Rep (no cost visibility) has THREE steps and nothing anywhere names or shows cost and margin", async () => {
    await open();
    expect(ids()).toEqual(["lines", "charges", "handoff"]);
    expect(rail().querySelectorAll("ol > li").length).toBe(3);
    expect(panel("cost")).toBeNull();
    const text = document.body.textContent ?? "";
    for (const leak of ["Cost & margin", "Internal margins", "Estimated cost", "GP (managers)", "Cin7 latest cost"]) expect(text, leak).not.toContain(leak);
    expect(document.querySelector('[data-step="cost"]')).toBeNull();
    // what a non-commercial viewer already had stays: the physical scope and the totals
    expect(screen.getByText("Totals")).toBeTruthy();
    expect(panel("lines")!.textContent).toContain("Physical scope");
  }, 30000);

  it("an Estimator with cost visibility has FOUR steps; the cost step is mounted (hidden + inert) and holds scope, cost, totals and margin", async () => {
    await open({ roles: ["REP", "ESTIMATOR"], commercials: true });
    expect(ids()).toEqual(["lines", "charges", "cost", "handoff"]);
    const cost = panel("cost")!;
    expect(cost.hasAttribute("hidden")).toBe(true); expect(cost.hasAttribute("inert")).toBe(true);
    await waitFor(() => expect(cost.textContent).toContain("Internal margins"), { timeout: 8000 });
    expect(cost.textContent).toContain("Totals");
    expect(cost.textContent).toContain("Estimated cost");
  }, 30000);

  it("the other steps hold their panels: readiness, line decisions and mappings in 1; commercial inputs, prices and exclusions in 2; the handoff in the last", async () => {
    await open({ roles: ["REP", "ESTIMATOR"], commercials: true });
    expect(panel("lines")!.textContent).toMatch(/Quote readiness[\s\S]*Line decisions[\s\S]*Product mappings/);
    expect(within(panel("lines") as HTMLElement).getByRole("button", { name: "Confirm source-backed mappings" })).toBeTruthy();
    expect(panel("charges")!.textContent).toMatch(/Commercial inputs[\s\S]*Customer-driven exclusions/);
    expect(panel("handoff")!.textContent).toContain("Estimator review and handoff");
  }, 30000);
});

describe("UX-006b Stage 2 steps: navigation", () => {
  it("step 1 is current by default; Next and Back move through the steps, update ?step= and focus the new heading; steps are NOT gates", async () => {
    await open({ roles: ["REP", "ESTIMATOR"], commercials: true });
    expect(rail().querySelector('[aria-current="step"]')!.textContent).toContain("Lines & mappings");
    expect(shown("lines")).toBe(true);
    for (const s of ["charges", "cost", "handoff"]) { expect(shown(s)).toBe(false); expect(panel(s)!.hasAttribute("inert")).toBe(true); }
    fireEvent.click(screen.getByRole("button", { name: "Next" })); // never requires completion
    expect(new URL(window.location.href).searchParams.get("step")).toBe("2");
    expect(shown("charges")).toBe(true); expect(shown("lines")).toBe(false);
    expect(document.activeElement?.textContent).toBe("Step 2 · Charges, exclusions & prices");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(shown("lines")).toBe(true);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.click(within(rail()).getByRole("button", { name: /Handoff/ })); // jump straight to the last step
    expect(shown("handoff")).toBe(true);
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
  }, 30000);

  it("?step= is validated against THIS viewer's steps: a Rep (three) given step=4 falls back to step 1; an Estimator given 3 opens Cost & margin", async () => {
    await open({ step: "4" });
    expect(shown("lines")).toBe(true);
    cleanup();
    await open({ roles: ["REP", "ESTIMATOR"], commercials: true, step: "3" });
    expect(shown("cost")).toBe(true);
    cleanup();
    await open({ step: "x" });
    expect(shown("lines")).toBe(true);
  }, 60000);

  it("Show all steps reveals every step, is remembered under the SAME key as Stage 1, and is restored; storage that throws still renders", async () => {
    const data: Record<string, string> = {};
    vi.stubGlobal("localStorage", { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } });
    await open({ roles: ["REP", "ESTIMATOR"], commercials: true });
    fireEvent.click(screen.getByLabelText("Show all steps"));
    for (const s of ["lines", "charges", "cost", "handoff"]) expect(shown(s)).toBe(true);
    expect(data["nq-builder-show-all"]).toBe("1");
    expect(screen.queryByTestId("step-buttons")).toBeNull(); // no Back / Next in the expert layout
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

  it("Next incomplete step jumps to the first later step that is not complete", async () => {
    await open({ roles: ["REP", "ESTIMATOR"], commercials: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "Next incomplete step" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Next incomplete step" }));
    const open2 = ids().find((id) => id !== "lines" && status(id!) !== "Complete")!;
    expect(shown(open2)).toBe(true);
  }, 30000);

  it("switching stage keeps the address bar honest: ?step= follows the stage's own step and is dropped when it is the first", async () => {
    await open({ roles: ["REP", "ESTIMATOR"], commercials: true });
    fireEvent.click(within(rail()).getByRole("button", { name: /Cost & margin/ }));
    expect(new URL(window.location.href).searchParams.get("step")).toBe("3");
    fireEvent.click(document.querySelector('[data-stage="3"]')!);
    const u = new URL(window.location.href);
    expect(u.searchParams.get("stage")).toBe("3"); expect(u.searchParams.has("step")).toBe(false);
    fireEvent.click(document.querySelector('[data-stage="2"]')!);
    expect(new URL(window.location.href).searchParams.get("step")).toBe("3"); // Stage 2 remembers its own step
    expect(shown("cost")).toBe(true);
  }, 30000);

  it("the rail is an ordered list; the current step has aria-current and moving focuses its heading", async () => {
    await open();
    expect(rail().querySelector("ol")).toBeTruthy();
    expect(rail().querySelectorAll('[aria-current="step"]').length).toBe(1);
    fireEvent.click(within(rail()).getByRole("button", { name: /Handoff/ }));
    expect(rail().querySelector('[aria-current="step"]')!.textContent).toContain("Handoff");
    expect(document.activeElement?.textContent).toBe("Step 3 · Handoff");
  }, 30000);

describe("UX-006b Stage 2 steps: statuses come from data, never from a visit", () => {
  it("an excluded item with no reason makes the charges step Needs attention (live); giving the reason clears it; visiting alone changes nothing", async () => {
    await open({ roles: ["REP", "ESTIMATOR"], commercials: true });
    const before = status("charges");
    fireEvent.click(within(rail()).getByRole("button", { name: /Charges, exclusions/ })); // visit
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
    const save = screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(document.getElementById("save-why")!.textContent).toBe("Give every excluded item a reason or remove it before saving.");
  }, 30000);

  it("Handoff, Rep draft: a READY quote is Not complete (ready for the confirmation), never Complete from a visit", async () => {
    await open({ draftOver: {} });
    await waitFor(() => expect(status("handoff")).not.toBe(""));
    fireEvent.click(within(rail()).getByRole("button", { name: /Handoff/ }));
    expect(["Not complete", "Needs attention"]).toContain(status("handoff"));
    expect(status("handoff")).not.toBe("Complete");
  }, 30000);

  it("Handoff, Estimator review: unsigned is not complete; a sign-off for THIS content is Complete; a stale one needs attention", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, state: "ESTIMATOR_REVIEW" });
    expect(status("handoff")).not.toBe("Complete");
    cleanup();
    await open({ roles: ["ESTIMATOR"], commercials: true, state: "ESTIMATOR_REVIEW", row: { estimator_signoff_hash: "stale-hash", estimator_signoff_by_email: "e@nq" } });
    expect(status("handoff")).toBe("Needs attention");
    expect(rail().textContent).toContain("The sign-off no longer matches the quotation");
  }, 60000);

  it("Handoff, final and read-only: Complete, the Stage 2 fields are disabled and Save explains it, and the rail still navigates", async () => {
    await open({ roles: ["MANAGER"], commercials: true, state: "MANAGER_APPROVED_FINAL" });
    expect(status("handoff")).toBe("Complete");
    expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(rail()).getByRole("button", { name: /Charges, exclusions/ }));
    expect(shown("charges")).toBe(true);
    expect(panel("charges")!.closest("fieldset")!.disabled).toBe(true);
    // the frozen-scope evidence stays with the handoff, exactly as before
    expect(panel("handoff")!.textContent).toContain("Physical scope");
  }, 30000);

  it("a Manager with no edit permission still navigates; the cost step's status is derived from the loaded budget", async () => {
    await open({ roles: ["MANAGER"], commercials: true });
    fireEvent.click(within(rail()).getByRole("button", { name: /Cost & margin/ }));
    expect(shown("cost")).toBe(true);
    expect(["Complete", "Needs attention", "Not complete"]).toContain(status("cost"));
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
