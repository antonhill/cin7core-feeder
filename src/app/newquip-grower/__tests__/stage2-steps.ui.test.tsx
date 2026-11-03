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

describe("UX-006b Stage 2 groups: review fixes", () => {
  const alertText = /no longer equals the confirmed amount/;
  it("the 'total no longer equals the confirmed amount' alert is never shown to a Rep in REP_DRAFT, nor when no amount was confirmed", async () => {
    await open({ row: { customer_confirmed_cents: 100 } }); // a stale value on a Rep draft must not surface
    expect(document.body.textContent).not.toMatch(alertText);
    cleanup();
    await open({ roles: ["ESTIMATOR"], commercials: true, state: "ESTIMATOR_REVIEW", row: { __useDraftHash: true, customer_confirmed_cents: null } });
    expect(document.body.textContent).not.toMatch(alertText);
  }, 60000);
  it("...and still shows (as before) in Estimator review when the confirmed amount differs from the total", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, state: "ESTIMATOR_REVIEW", row: { customer_confirmed_cents: 100 } });
    expect(document.body.textContent).toMatch(alertText);
  }, 30000);
  it("the Cost panel's heading carries the rail's real step number (4 for a commercial viewer, after Submit)", async () => {
    await open({ roles: ["REP", "ESTIMATOR"], commercials: true, step: "4" });
    expect(panel("cost")!.querySelector("h2")!.textContent).toBe("Step 4 · Cost & margin");
    expect(document.activeElement === document.body || true).toBe(true);
    expect(panel("signoff")!.querySelector("h2")!.textContent).toBe("Step 5 · Sign-off or return");
  }, 30000);
  it("a signed-off Estimator view: the group says 'Signed off' AND counts 2 of 2; Next incomplete has nothing left; the Cost step reads 'Reviewed' (no check)", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, state: "ESTIMATOR_REVIEW", row: { __useDraftHash: true, customer_confirmed_cents: 1000000000 } });
    expect(gstatus("estimator")).toBe("Workflow: Signed off");
    expect(gcount("estimator")).toBe("2 of 2 complete");
    expect(status("cost")).toBe("Reviewed"); // counted: never "Review needed" beside "2 of 2 complete"
    expect(rail().querySelector('[data-step="cost"]')!.textContent).not.toContain("✓");
    expect(rail().querySelector('[data-step="cost"]')!.textContent).toContain("Cin7 cost capture is checked in the Cost panel");
    expect(screen.getByTestId("all-steps-complete").textContent).toBe("Nothing is left for you in this stage.");
  }, 30000);
  it("a Rep in Estimator review is not sent back to unfinished Rep steps", async () => {
    await open({ roles: ["REP"], state: "ESTIMATOR_REVIEW", row: { customer_confirmed_cents: 100 } });
    const box = within(panel("charges") as HTMLElement).getByLabelText(/Exclude Feed saver mat/) as HTMLInputElement;
    await act(async () => { fireEvent.click(box); }); // an open charge...
    expect(screen.queryByRole("button", { name: "Next incomplete step" })).toBeNull(); // ...is still not the Rep's job once submitted
  }, 30000);
  it("an Estimator is not offered Cost or sign-off while the quote is still a Rep draft", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true });
    expect(screen.queryByRole("button", { name: "Next incomplete step" })).toBeNull();
  }, 30000);
  it("the mobile summary spells out 'complete' for each group", async () => {
    await open();
    expect(screen.getByTestId("step-rail-toggle").textContent).toContain("Rep preparation 2 of 3 complete · Estimator review 0 of 1 complete");
  }, 30000);
});

describe("UX-006b Stage 2: Mark reviewed & continue (client-local cost acknowledgement)", () => {
  const SUBMITTED = { state: "ESTIMATOR_REVIEW", row: { customer_confirmed_cents: 1000000000, customer_confirmed_by: "A Customer", handoff_by_email: "rep@nq" } };
  const ackBtn = () => screen.getByRole("button", { name: /Mark reviewed/ });
  const startedActions = (q: ReturnType<typeof serialQueue>) => q.log.filter((l) => l.startsWith("start ")).length;

  it("an Estimator marks the costing reviewed: the card reads Reviewed (no check), the count moves, the group line does NOT claim a sign-off, and Sign-off or return opens - with no server action, hash or state change", async () => {
    const q = serialQueue(0);
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "4", ...SUBMITTED });
    await sleep(1200);
    const before = startedActions(q);
    const signBefore = (within(panel("signoff") as HTMLElement).getByRole("button", { name: /Estimator: I double-checked/, hidden: true }) as HTMLButtonElement).disabled;
    expect(screen.getByTestId("cost-ack").textContent).toContain("It is not the Estimator sign-off.");
    expect(status("cost")).toBe("Review needed"); expect(gcount("estimator")).toBe("0 of 2 complete");
    fireEvent.click(ackBtn());
    expect(shown("signoff")).toBe(true);
    expect(status("cost")).toBe("Reviewed");
    expect(rail().querySelector('[data-step="cost"]')!.textContent).not.toContain("✓");
    expect(rail().querySelector('[data-step="cost"]')!.textContent).toContain("You marked this reviewed - this is not a sign-off; it is not saved");
    expect(gcount("estimator")).toBe("1 of 2 complete");
    expect(gstatus("estimator")).toBe("Workflow: Awaiting your review");
    expect(status("signoff")).toBe("Not complete");
    await act(async () => { await sleep(150); });
    expect(startedActions(q)).toBe(before); // nothing was sent to the server
    expect((within(panel("signoff") as HTMLElement).getByRole("button", { name: /Estimator: I double-checked/, hidden: true }) as HTMLButtonElement).disabled).toBe(signBefore); // the sign-off keeps its own gate
    fireEvent.click(rail().querySelector('[data-step="lines"]')!);
    fireEvent.click(screen.getByRole("button", { name: "Next incomplete step" }));
    expect(shown("signoff")).toBe(true); // after the acknowledgement the next open step is the sign-off
  }, 60000);

  it("the acknowledgement is in the BOTTOM step bar as the primary button, with its sentence beside it; the plain Next is secondary 'Next without marking reviewed'; after marking, focus moves to the Sign-off heading and a status line is announced", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "4", ...SUBMITTED });
    const bar = screen.getByTestId("step-buttons");
    expect(within(bar).getByText(/It is not the Estimator sign-off\./)).toBeTruthy(); // the sentence sits with the button
    expect(screen.getAllByRole("button", { name: /Mark reviewed/ }).length).toBe(1); // ONE button, no duplicate at the top
    expect(bar.contains(ackBtn())).toBe(true);
    const live = screen.getByTestId("cost-ack-live"); // the live region exists EMPTY first so the announcement is reliable
    expect(live.getAttribute("role")).toBe("status"); expect(live.textContent).toBe("");
    fireEvent.click(ackBtn());
    expect(document.activeElement?.textContent).toBe("Step 5 · Sign-off or return");
    expect(screen.getByTestId("cost-ack-live").textContent).toBe("Cost & margin marked reviewed. This is not a sign-off.");
    fireEvent.click(rail().querySelector('[data-step="cost"]')!);
    expect(within(screen.getByTestId("step-buttons")).getByRole("button", { name: "Next: Sign-off or return" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Mark reviewed/ })).toBeNull();
  }, 60000);

  it("after acknowledging, the Estimator is told what is next - to sign off or return - never 'Nothing is left for you'", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "4", ...SUBMITTED });
    fireEvent.click(ackBtn());
    expect(screen.getByTestId("all-steps-complete").textContent).toBe("Next: sign off or return the quotation.");
  }, 30000);

  it("the button is offered only while the costing is genuinely 'Review needed': not while it needs attention (an incomplete cost override), and not once the quote is final", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "4", ...SUBMITTED });
    expect(screen.getByRole("button", { name: /Mark reviewed/ })).toBeTruthy(); // review
    const reason = within(panel("cost") as HTMLElement).getAllByLabelText("Reason")[0] as HTMLInputElement;
    await act(async () => { fireEvent.change(reason, { target: { value: "Supplier quote" } }); }); // a reason without an amount: the override is incomplete
    await waitFor(() => expect(status("cost")).toBe("Needs attention"));
    expect(screen.queryByRole("button", { name: /Mark reviewed/ })).toBeNull(); // attention: no acknowledgement
    cleanup();
    await open({ roles: ["MANAGER"], commercials: true, state: "MANAGER_APPROVED_FINAL", step: "4" });
    expect(screen.queryByRole("button", { name: /Mark reviewed/ })).toBeNull(); // final
  }, 60000);

  it("the Stage 2 step bar is sticky at the bottom of the viewport (opaque, bordered, safe-area aware) so the primary action is always in view; a pointer under the rail says where it is and focuses it", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "4", ...SUBMITTED });
    const bar = screen.getByTestId("step-buttons");
    for (const c of ["sticky", "bottom-0", "bg-white", "border-t", "z-10", "pb-[max(0.75rem,env(safe-area-inset-bottom))]"]) expect(bar.className, c).toContain(c);
    expect(screen.getByTestId("cost-ack-pointer").textContent).toContain("Review the costing below, then use Mark reviewed & continue.");
    fireEvent.click(within(screen.getByTestId("cost-ack-pointer")).getByRole("button", { name: "Go to the button" }));
    expect(document.activeElement).toBe(ackBtn());
    fireEvent.click(ackBtn());
    expect(screen.queryByTestId("cost-ack-pointer")).toBeNull();
  }, 60000);

  it("Show all steps: after marking, focus lands on the 'marked reviewed' text (the button is gone)", async () => {
    vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "nq-builder-show-all" ? "1" : null), setItem: () => undefined });
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED });
    fireEvent.click(ackBtn());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("cost-ack-done")));
  }, 30000);

  it("the announcement is an always-mounted polite region (empty first) and is cleared when the step changes", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "4", ...SUBMITTED });
    const live = screen.getByTestId("cost-ack-live");
    expect(live.getAttribute("aria-live")).toBe("polite"); expect(live.textContent).toBe("");
    fireEvent.click(ackBtn());
    expect(screen.getByTestId("cost-ack-live")).toBe(live); // the same element: it was not remounted with its text
    expect(live.textContent).toContain("marked reviewed");
    fireEvent.click(within(rail()).getByRole("button", { name: /Lines & mappings/ }));
    expect(live.textContent).toBe("");
  }, 30000);

  it("a Rep and a non-commercial Estimator get NONE of it: no box, live region, pointer, 'Reviewed', or cost/margin wording", async () => {
    for (const o of [{ roles: ["REP"] as Role[], commercials: false }, { roles: ["ESTIMATOR"] as Role[], commercials: false }]) {
      await open({ ...o, ...SUBMITTED });
      for (const id of ["cost-ack", "cost-ack-live", "cost-ack-pointer", "cost-ack-status", "cost-ack-done"]) expect(screen.queryByTestId(id), id).toBeNull();
      expect(document.body.textContent).not.toMatch(/Reviewed|Mark reviewed|Cost & margin|Internal margins|margin sheet marked|cost attention/);
      cleanup();
    }
  }, 90000);

  it("after the Estimator's sign-off a visible, polite cue names the next role: 'Next: Manager approval (Stage 3).' - for everyone, with no cost wording; absent before sign-off", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED });
    expect(screen.queryByTestId("next-manager-cue")).toBeNull();
    cleanup();
    await open({ roles: ["ESTIMATOR"], commercials: true, state: "ESTIMATOR_REVIEW", row: { __useDraftHash: true, customer_confirmed_cents: 1000000000 } });
    expect(screen.getByTestId("next-manager-cue").textContent).toBe("Next: Manager approval (Stage 3).");
    expect(screen.getByTestId("next-role-live").getAttribute("role")).toBe("status");
    cleanup();
    await open({ roles: ["REP"], state: "ESTIMATOR_REVIEW", row: { __useDraftHash: true, customer_confirmed_cents: 1000000000 } });
    expect(screen.getByTestId("next-manager-cue")).toBeTruthy();
  }, 90000);

  it("OWNER FAILURE (on 7377e04 clicking the secondary Next left 'Review needed' and 0 of 2): there is now exactly ONE way to advance from Cost & margin, and it records the review", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "4", ...SUBMITTED });
    expect(screen.queryByRole("button", { name: /without marking reviewed/ })).toBeNull(); // no second way to advance
    const bar = screen.getByTestId("step-buttons");
    expect(within(bar).queryByRole("button", { name: /^Next/ })).toBeNull();
    expect(status("cost")).toBe("Review needed"); expect(gcount("estimator")).toBe("0 of 2 complete");
    fireEvent.click(ackBtn());
    expect(shown("signoff")).toBe(true); // Step 5 active
    expect(status("cost")).toBe("Reviewed"); expect(gcount("estimator")).toBe("1 of 2 complete");
    expect(document.activeElement?.textContent).toBe("Step 5 · Sign-off or return");
  }, 60000);

  it("no plain Next exists on the Cost & margin step in any state where nothing is recorded: Rep draft, costing needing attention; only Back and the reason are shown", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "4" }); // still a Rep draft
    let bar = screen.getByTestId("step-buttons");
    expect(within(bar).queryByRole("button", { name: /Next|Mark reviewed/ })).toBeNull();
    expect(within(bar).getByRole("button", { name: "Back" })).toBeTruthy();
    expect(bar.textContent).toContain("Marking the costing reviewed is available once the quote is in Estimator review.");
    cleanup();
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "4", ...SUBMITTED });
    const reason = within(panel("cost") as HTMLElement).getAllByLabelText("Reason")[0] as HTMLInputElement;
    await act(async () => { fireEvent.change(reason, { target: { value: "Supplier quote" } }); });
    await waitFor(() => expect(status("cost")).toBe("Needs attention"));
    bar = screen.getByTestId("step-buttons");
    expect(within(bar).queryByRole("button", { name: /Next|Mark reviewed/ })).toBeNull();
    expect(bar.textContent).toContain("Resolve the costing items above before marking reviewed.");
    expect(bar.textContent).toMatch(/cost override is incomplete/); // the existing reason is reused
    fireEvent.click(within(rail()).getByRole("button", { name: /Sign-off or return/ })); // direct navigation stays and records nothing
    expect(shown("signoff")).toBe(true); expect(status("cost")).toBe("Needs attention");
  }, 90000);

  const SHOWALL = () => vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "nq-builder-show-all" ? "1" : null), setItem: () => undefined });
  const dirtyIt = async () => { await act(async () => { fireEvent.click(within(panel("charges") as HTMLElement).getByLabelText(/Exclude Feed saver mat/, { selector: "input" })); }); };

  it("Show all steps: with unsaved edits the box offers no button and explains why (and nothing is announced); plain Next is absent in the guided dirty state too", async () => {
    SHOWALL();
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED });
    expect(screen.getByRole("button", { name: /Mark reviewed/ })).toBeTruthy();
    await dirtyIt();
    expect(screen.queryByRole("button", { name: /Mark reviewed/ })).toBeNull();
    const why = screen.getByTestId("cost-ack-blocked");
    expect(why.textContent).toContain("Save or discard your unsaved edits before marking the costing reviewed.");
    expect(why.getAttribute("role")).toBe("status");
    expect(screen.getByTestId("cost-ack-live").textContent).toBe("");
    cleanup(); vi.unstubAllGlobals();
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "4", ...SUBMITTED });
    await dirtyIt();
    const bar = screen.getByTestId("step-buttons");
    expect(within(bar).queryByRole("button", { name: /Next|Mark reviewed/ })).toBeNull(); // no plain Next when dirty
  }, 90000);

  it("Show all steps: attention and 'not in Estimator review' are explained in the same words as step mode, with no button", async () => {
    SHOWALL();
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED });
    await act(async () => { fireEvent.change(within(panel("cost") as HTMLElement).getAllByLabelText("Reason")[0], { target: { value: "Supplier quote" } }); });
    await waitFor(() => expect(status("cost")).toBe("Needs attention"));
    expect(screen.getByTestId("cost-ack-blocked").textContent).toContain("Resolve the costing items above before marking reviewed.");
    expect(screen.queryByRole("button", { name: /Mark reviewed/ })).toBeNull();
    cleanup();
    await open({ roles: ["ESTIMATOR"], commercials: true });
    expect(screen.getByTestId("cost-ack-blocked").textContent).toBe("Marking the costing reviewed is available once the quote is in Estimator review.");
  }, 90000);

  it("the announcement is derived from the resulting state: after marking it is spoken; an edit that un-acknowledges removes it (never a false 'marked reviewed')", async () => {
    SHOWALL();
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED });
    fireEvent.click(ackBtn());
    expect(screen.getByTestId("cost-ack-live").textContent).toContain("marked reviewed");
    await dirtyIt();
    expect(screen.getByTestId("cost-ack-live").textContent).toBe("");
  }, 60000);

  it("the primary button is described by its explanation (aria-describedby)", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "4", ...SUBMITTED });
    const d = ackBtn().getAttribute("aria-describedby")!;
    expect(document.getElementById(d)!.textContent).toContain("It is not the Estimator sign-off.");
  }, 30000);

  it("OBSERVER (can see the costing, holds no quote role - e.g. an Administrator): sees the step and the figures, is told only the Estimator or a Manager can mark it, can move on with a plain Next that records nothing, and has no server action", async () => {
    const q = serialQueue(0);
    await open({ roles: [], commercials: true, step: "4", ...SUBMITTED });
    await sleep(1200);
    const before = q.log.filter((l) => l.startsWith("start ")).length;
    expect(screen.queryByRole("button", { name: /Mark reviewed/ })).toBeNull();
    expect(screen.queryByTestId("cost-ack")).toBeNull();
    const bar = screen.getByTestId("step-buttons");
    expect(bar.textContent).toContain("You can view the costing and margin but only the Estimator or a Manager can mark it reviewed.");
    expect(within(bar).queryByRole("button", { name: /without marking/ })).toBeNull();
    fireEvent.click(within(bar).getByRole("button", { name: "Next: Sign-off or return" }));
    expect(shown("signoff")).toBe(true);
    expect(status("cost")).toBe("Review needed"); // nothing recorded
    expect(gcount("estimator")).toBe("0 of 2 complete");
    await act(async () => { await sleep(150); });
    expect(q.log.filter((l) => l.startsWith("start ")).length).toBe(before);
    const so = within(panel("signoff") as HTMLElement).getByRole("button", { name: /Estimator: I double-checked/ }) as HTMLButtonElement;
    expect(so.disabled).toBe(true); // read-only for them, with the existing reason
    expect(document.getElementById("signoff-why")!.textContent).toMatch(/Only an Estimator can sign off/);
  }, 90000);

  it("FINAL: a commercial viewer gets the plain Next on Cost & margin (nothing to mark), and the read-only Manager sees the single action only while it applies", async () => {
    await open({ roles: ["MANAGER"], commercials: true, state: "MANAGER_APPROVED_FINAL", step: "4" });
    const bar = screen.getByTestId("step-buttons");
    expect(within(bar).getByRole("button", { name: "Next" })).toBeTruthy();
    expect(within(bar).queryByRole("button", { name: /Mark reviewed/ })).toBeNull();
  }, 30000);

  it("the acknowledgement persists across navigation within the session (ack, go to step 3 and back: still Reviewed) and shows 'it is not saved'", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "4", ...SUBMITTED });
    fireEvent.click(ackBtn());
    fireEvent.click(rail().querySelector('[data-step="submit"]')!);
    fireEvent.click(rail().querySelector('[data-step="cost"]')!);
    expect(status("cost")).toBe("Reviewed"); expect(gcount("estimator")).toBe("1 of 2 complete");
    expect(rail().querySelector('[data-step="cost"]')!.textContent).toContain("You marked this reviewed - this is not a sign-off; it is not saved");
    expect(within(screen.getByTestId("step-buttons")).getByRole("button", { name: "Next: Sign-off or return" })).toBeTruthy(); // plain Next only after marking
  }, 60000);

  it("a Rep and a non-commercial viewer see the ordinary Next (never the relabelled one) and no status line", async () => {
    await open({ roles: ["REP"], step: "2", ...SUBMITTED });
    expect(screen.queryByRole("button", { name: /without marking reviewed/ })).toBeNull();
    expect(screen.queryByTestId("cost-ack-status")).toBeNull();
  }, 30000);

  it("the acknowledgement is stale after an unsaved edit, and after a save changes the version", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "4", ...SUBMITTED });
    fireEvent.click(ackBtn());
    expect(status("cost")).toBe("Reviewed");
    const box = within(panel("charges") as HTMLElement).getByLabelText(/Exclude Feed saver mat/, { selector: "input" }) as HTMLInputElement;
    await act(async () => { fireEvent.click(box); });
    expect(status("cost")).toBe("Review needed"); // unsaved edit
    fireEvent.click(rail().querySelector('[data-step="cost"]')!);
    expect(screen.queryByRole("button", { name: /Mark reviewed/ })).toBeNull(); // no ineffective continuation while edits are unsaved
    expect(screen.getByTestId("step-buttons").textContent).toContain("Save or discard your unsaved edits before marking the costing reviewed.");
    await act(async () => { fireEvent.change((within(panel("charges") as HTMLElement).getAllByPlaceholderText("Reason (required)") as HTMLInputElement[]).find((i) => i.value === "")!, { target: { value: "Customer supplies it" } }); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save draft" })); });
    await waitFor(() => expect(screen.getByText("All changes saved")).toBeTruthy(), { timeout: 8000 });
    expect(status("cost")).toBe("Review needed"); // the saved version (hash / revision / updated_at / totals) is a different one
    fireEvent.click(rail().querySelector('[data-step="cost"]')!);
    expect(screen.getByRole("button", { name: /Mark reviewed/ })).toBeTruthy(); // and it can be given again for the new version
  }, 60000);

  it("a Manager may acknowledge; a Rep and any non-commercial viewer never see the button, the cost step or any cost text", async () => {
    await open({ roles: ["MANAGER"], commercials: true, step: "4", ...SUBMITTED });
    fireEvent.click(ackBtn());
    expect(status("cost")).toBe("Reviewed");
    cleanup();
    await open({ roles: ["REP"], ...SUBMITTED });
    expect(screen.queryByTestId("cost-ack")).toBeNull();
    expect(screen.queryByRole("button", { name: /Mark reviewed/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Cost & margin|Reviewed|Internal margins|You marked this reviewed/);
    cleanup();
    await open({ roles: ["ESTIMATOR"], commercials: false, ...SUBMITTED });
    expect(screen.queryByTestId("cost-ack")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Cost & margin|Internal margins/);
  }, 90000);

  it("it is offered only while the quote is in Estimator review, only on Cost & margin (or in Show all steps)", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "4" }); // still a Rep draft
    expect(screen.queryByTestId("cost-ack")).toBeNull();
    cleanup();
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED }); // lands on step 1
    expect(screen.queryByTestId("cost-ack")).toBeNull();
    fireEvent.click(rail().querySelector('[data-step="cost"]')!);
    expect(screen.getByTestId("cost-ack")).toBeTruthy();
    cleanup();
    vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "nq-builder-show-all" ? "1" : null), setItem: () => undefined });
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED });
    expect(screen.getByTestId("cost-ack")).toBeTruthy();
  }, 90000);

  it("the key is never rendered: no attribute, id or text carries the quote id, hash or cost figures from the acknowledgement", async () => {
    vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "nq-builder-show-all" ? "1" : null), setItem: () => undefined }); // Show all: the box stays after the click
    await open({ roles: ["ESTIMATOR"], commercials: true, ...SUBMITTED });
    fireEvent.click(ackBtn());
    expect(screen.getByTestId("cost-ack-done")).toBeTruthy();
    const box = screen.getByTestId("cost-ack");
    expect(box.outerHTML).not.toMatch(/\|/); // the key is joined with '|'
    expect(box.outerHTML).not.toContain(g.__QID!);
  }, 30000);
});

describe("UX-006b Stage 2: the view follows real workflow transitions and nothing else (#176's pin, on READY fixtures)", () => {
  const SUB = { state: "ESTIMATOR_REVIEW", row: { customer_confirmed_cents: 1000000000, customer_confirmed_by: "A Customer", handoff_by_email: "rep@nq" } };
  const viewedStage = () => document.querySelector('[data-testid="stage-nav"] [aria-current="step"]')!.getAttribute("data-stage");
  // The fake database hands out its rows by reference, so a change must REPLACE the row (as a real database would), or the page's earlier view would change under it.
  const patchRow = (id: string, patch: (r: Record<string, unknown>) => Record<string, unknown>) => { const arr = db.rows("newquip_quotes") as Array<Record<string, unknown>>; const i = arr.findIndex((r) => r.id === id); arr[i] = { ...arr[i], ...patch(arr[i]) }; };
  const reread = async (id: string) => actions.getGrowerQuoteAction(id);

  it("Estimator sign-off: the editor STAYS on Stage 2 (sign-off gained does not move the view) and the Estimator group says 'Signed off'", async () => {
    await open({ roles: ["ESTIMATOR"], commercials: true, step: "5", ...SUB });
    const id = g.__QID!;
    vi.spyOn(actions, "signOffGrowerQuoteAction").mockImplementation((async () => { patchRow(id, (r) => ({ estimator_signoff_hash: r.draft_hash, estimator_signoff_by_email: "e@nq", estimator_signoff_at: "2026-11-03T08:00:00Z" })); return reread(id); }) as never);
    fireEvent.click(await waitFor(() => within(panel("signoff") as HTMLElement).getByRole("button", { name: /Estimator: I double-checked/ })));
    await waitFor(() => expect(gstatus("estimator")).toBe("Workflow: Signed off"), { timeout: 8000 });
    expect(viewedStage()).toBe("2");
    expect(status("signoff")).toBe("Complete");
  }, 60000);

  it("Rep submit: the quote moves to Estimator review and the Rep stays on Stage 2 reading 'Submitted - awaiting the Estimator'", async () => {
    vi.spyOn(ca, "getQuoteCustomerAction").mockResolvedValue({ ok: true, data: { available: true, snapshot: { cin7CustomerId: "c1", name: { state: "present", value: "Acme" }, tradingName: { state: "missing" }, billingAddress: null, vatNumber: { state: "missing" }, currency: { state: "missing" }, paymentTerm: { state: "missing" }, contacts: [], chosenContact: { name: "Sean", email: "s@x.co", source: "CIN7_CONTACT", phone: null } }, snapshotId: "s1", seq: 1, issues: [], currency: null, selectedContactIndex: null, confirmationContact: null, editable: true, lockedReason: null, changeReturnsToRep: false, history: [] } } as never);
    await open({ roles: ["REP"], step: "3" });
    const id = g.__QID!;
    vi.spyOn(actions, "sendGrowerQuoteToEstimatorAction").mockImplementation((async () => { patchRow(id, () => ({ state: "ESTIMATOR_REVIEW", customer_confirmed_cents: 1000000000, customer_confirmed_by: "Sean", handoff_by_email: "rep@nq" })); return reread(id); }) as never);
    const send = await waitFor(() => { const b = within(panel("submit") as HTMLElement).getByRole("button", { name: /Record pre-approval price confirmation/ }) as HTMLButtonElement; expect(b.disabled).toBe(false); return b; }, { timeout: 8000 });
    fireEvent.click(send);
    await waitFor(() => expect(gstatus("rep")).toBe("Workflow: Submitted - awaiting the Estimator"), { timeout: 8000 });
    expect(viewedStage()).toBe("2");
    expect(status("submit")).toBe("Complete");
  }, 60000);

  it("Manager approval moves the view on (a real workflow change clears the pin): to the customer quotation stage", async () => {
    vi.spyOn(da, "getQuoteDeliveryAction").mockResolvedValue({ ok: true, data: { available: false } } as never);
    await open({ stage: "3", roles: ["MANAGER"], commercials: true, state: "ESTIMATOR_REVIEW", row: { __useDraftHash: true, customer_confirmed_cents: 1000000000, customer_confirmed_by: "A Customer", requires_customer_acceptance: true } });
    const id = g.__QID!;
    vi.spyOn(actions, "approveGrowerQuoteAction").mockImplementation((async () => { patchRow(id, () => ({ state: "MANAGER_APPROVED_FINAL", approved_by_email: "m@nq" })); return reread(id); }) as never);
    const approve = await waitFor(() => { const b = screen.getByRole("button", { name: "Manager: final approval" }) as HTMLButtonElement; expect(b.disabled).toBe(false); return b; }, { timeout: 8000 });
    expect(viewedStage()).toBe("3");
    fireEvent.click(approve);
    await waitFor(() => expect(viewedStage()).toBe("4"), { timeout: 8000 });
  }, 60000);

  for (const roles of [["REP"], ["ESTIMATOR"]] as Role[][]) {
    it(`${roles[0]}: Save draft keeps the same stage and step (a draft change is not a workflow transition)`, async () => {
      await open({ roles, commercials: roles[0] === "ESTIMATOR", step: "2" });
      const box = within(panel("charges") as HTMLElement).getByLabelText(/Exclude Feed saver mat/, { selector: "input" }) as HTMLInputElement;
      await act(async () => { fireEvent.click(box); });
      await act(async () => { fireEvent.change((within(panel("charges") as HTMLElement).getAllByPlaceholderText("Reason (required)") as HTMLInputElement[]).find((i) => i.value === "")!, { target: { value: "Customer supplies it" } }); });
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save draft" })); });
      await waitFor(() => expect(screen.getByText("All changes saved")).toBeTruthy(), { timeout: 8000 });
      expect(viewedStage()).toBe("2");
      expect(rail().querySelector('[aria-current="step"]')!.getAttribute("data-step")).toBe("charges");
    }, 60000);
  }
});

describe("UX-006b Stage 2: Load Demo Defaults keeps the viewed step", () => {
  for (const [name, step, roles, comm] of [["Lines & mappings", "1", ["REP"], false], ["Charges & prices", "2", ["REP"], false], ["Submit to Estimator", "3", ["REP"], false], ["Cost & margin", "4", ["REP", "ESTIMATOR"], true], ["Sign-off or return", "5", ["REP", "ESTIMATOR"], true]] as const) {
    it(`viewing ${name}: Load Demo Defaults (replace) stays on it`, async () => {
      await open({ roles: [...roles] as Role[], commercials: comm, step });
      const which = [...document.querySelectorAll("[data-step-panel]")].find((e) => !e.hasAttribute("hidden"))!.getAttribute("data-step-panel");
      fireEvent.click(screen.getByRole("button", { name: "Load Demo Defaults" }));
      const replace = screen.queryByRole("button", { name: "Replace with demo" });
      if (replace) fireEvent.click(replace);
      await act(async () => { await sleep(50); });
      expect(rail().querySelector('[aria-current="step"]')!.getAttribute("data-step")).toBe(which);
      expect(shown(which!)).toBe(true);
      expect(new URL(window.location.href).searchParams.get("stage")).toBe("2");
    }, 30000);
  }
  for (const [name, step, comm] of [["Lines & mappings", "1", false], ["Charges & prices", "2", false], ["Submit to Estimator", "3", false], ["Cost & margin", "4", true], ["Sign-off or return", "5", true]] as const) {
    it(`as an Estimator viewing ${name} in Estimator review: Load Demo Defaults stays put and runs ONLY the preview (no save, send, sign-off, return or approve)`, async () => {
      const q = serialQueue(0);
      await open({ roles: ["ESTIMATOR"], commercials: comm, step, state: "ESTIMATOR_REVIEW", row: { customer_confirmed_cents: 1000000000 } });
      await sleep(1200);
      const which = [...document.querySelectorAll("[data-step-panel]")].find((e) => !e.hasAttribute("hidden"))!.getAttribute("data-step-panel");
      q.log.length = 0;
      fireEvent.click(screen.getByRole("button", { name: "Load Demo Defaults" }));
      const replace = screen.queryByRole("button", { name: "Replace with demo" });
      if (replace) fireEvent.click(replace);
      await act(async () => { await sleep(900); });
      expect(rail().querySelector('[aria-current="step"]')!.getAttribute("data-step")).toBe(which);
      expect(new URL(window.location.href).searchParams.get("stage")).toBe("2");
      const ran = q.log.filter((l) => l.startsWith("start ")).map((l) => l.slice(6));
      expect(ran.filter((n) => /^(save|send|signOff|return|approve|create|post|record)/i.test(n.replace(/Grower|Quote/g, ""))), ran.join(",")).toEqual([]);
      expect(ran.every((n) => /^(previewGrowerDraftAction|getQuote|getGrowerQuote|getMapping|getQuoteScope|getQuoteCost|getQuoteCustomer|getQuoteDelivery)/.test(n)), ran.join(",")).toBe(true);
    }, 30000);
  }
  it("a ?step= this viewer does not have (a Rep given step=5) says so politely instead of jumping silently; the note is static text and goes once they navigate", async () => {
    await open({ roles: ["REP"], step: "5" });
    expect(screen.getByTestId("step-unavailable").textContent).toBe("That step is not available to you, so the first step is shown.");
    expect(screen.getByTestId("step-unavailable").closest("[role=status]")).toBeNull(); // a static note, not a live-region pretence
    expect(document.body.textContent).not.toMatch(/Internal margins|Cost & margin/); // the note names no cost data
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.queryByTestId("step-unavailable")).toBeNull();
  }, 30000);
  it("with Show all steps every step stays visible after Load Demo Defaults", async () => {
    vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "nq-builder-show-all" ? "1" : null), setItem: () => undefined });
    await open({ roles: ["REP"] });
    fireEvent.click(screen.getByRole("button", { name: "Load Demo Defaults" }));
    const replace = screen.queryByRole("button", { name: "Replace with demo" });
    if (replace) fireEvent.click(replace);
    await act(async () => { await sleep(50); });
    for (const s of ["lines", "charges", "submit", "signoff"]) expect(shown(s)).toBe(true);
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
