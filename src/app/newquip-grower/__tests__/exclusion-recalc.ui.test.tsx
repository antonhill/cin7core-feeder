// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { canSeeCosts, resolveRoles } from "@/lib/approvals/role-store";
import { createQuote, loadQuote, saveDraft } from "@/lib/newquip-quotes/quote-store";
import * as costActions from "../cost-actions";
import { emptyDraft } from "@/newquip/grower/draft";
import { rolesFor } from "@/newquip/quote/roles";
import * as actions from "../actions";

// UAT-003, rendered through the REAL page with the owner's real quote shape and the real workbook price source (no test price snapshot). Server actions are run through a
// SERIAL, SLOW queue like the browser's: that is what failed live (each action took seconds, three were fired per edit, the preview's answer came last). Product mappings decide what a quotation is built from. NEGATIVE authorisation: a Rep (functional role REP only) cannot change ANY mapping, on create or on save,
// including the non-optional ones; an Estimator/Manager can. And mapping integrity is re-verified at estimator sign-off against the live catalogue.

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
});


vi.mock("next/navigation", () => ({
  useParams: () => ({ id: (globalThis as { __QID?: string }).__QID }),
  useSearchParams: () => new URLSearchParams("stage=" + ((globalThis as { __STAGE?: string }).__STAGE ?? "2")),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/newquip-grower/x",
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
const config = {"rooms":12,"widthM":14.43,"lengthM":49.5,"totalPens":20,"pigsPerRoom":600,"hospitalPens":2,"feederVariant":"STANDARD","penningPigSize":"SMALL","optionalEquipment":{"cone_fans":false,"controller":true,"manure_plug":false,"pad_cooling":false,"control_panel":false,"silo_weighing":false,"emergency_windows":false},"quantityOverrides":{"led_light":38,"feed_saver_mat":18},"selectedFeederType":"CCM","slattedFloorAreaM2":120,"estimatorQuantities":{"feeder":18,"pvc_door":2,"bulk_tank":1,"cone_fans":4,"controller":2,"flex_auger":1,"cup_drinker":54,"manure_plug":2,"pad_cooling":3,"concrete_slat":1320,"control_panel":2,"silo_weighing":2,"emergency_windows":2},"selectedDrinkerType":"CUP_NEW","selectedPenningType":"PP_GREEN_VENTED","selectedFlooringType":"CONCRETE_1200X450X70","selectedLightingType":"FORTIS_1_2_5000K","quantityOverrideReasons":{"led_light":"Test","feed_saver_mat":"Test"},"penningRunningMetresPerRoom":20};
const pr = (p: number) => ({ at: "t", by: "x", reason: "Master workbook has no usable price. Temporary POC estimator value only.", unitPriceExVat: p });
const draft: any = { ...emptyDraft(), quoteType: "day_to_day", config: { ...config, exclusions: { pvc_door: "Not needed" } },
  estimator: { ...emptyDraft().estimator, confirmedMappings: {"feeder":"PNQ082","pvc_door":"NQ2114","bulk_tank":"SYSH-2750-3","controller":"HO05084000","concrete_slat":"NQ1161","feed_saver_mat":"ERT053"}, confirmedPackages: ["cup_drinker","led_light"], charges: {"delivery":979992,"installation":1200000,"concrete_slat_delivery":250000}, unitPrices: {"flex_auger":45000}, priceResolutions: {pvc_door:pr(3000),led_light:pr(881),controller:pr(3000),cup_drinker:pr(548),concrete_slat:pr(203),feed_saver_mat:pr(919)} } };

async function storedQuote() {
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, draft);
  return id;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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
// UX-006i2: the exclusions are the Rep's, in Stage 1 step 3 (Stage 2 has no Rep controls), and Stage 1 has no Totals panel. The figure under test is the sticky summary bar's quote total
// (ex VAT): it is the live preview of the draft, the same number the Totals panel showed, without the transient "Recalculating" cue that sits beside it.
const subtotal = () => {
  const dd = screen.getByText("Quote total (ex VAT)").nextElementSibling!;
  return dd.firstChild!.textContent!;
};


// UX-006i1: the quantity / reason inputs now carry real accessible names ("Quantity per room for <item>"), so the tick-boxes are selected by type.
const box = (label: RegExp) => screen.getByLabelText(label, { selector: 'input[type="checkbox"]' }) as HTMLInputElement;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Captured at import, before any test installs its request queue: the expected figure is computed OUTSIDE the queue under test, so it neither delays nor appears in it.
const realPreview = actions.previewGrowerDraftAction;
const expectedSubtotal = async (exclude: string[]) => {
  const d = structuredClone(draft); d.config.exclusions = { ...d.config.exclusions, ...Object.fromEntries(exclude.map((k) => [k, "x"])) };
  const r = await realPreview(d);
  return r.data!.budget!.totals.subtotalExTax;
};
const count = (log: string[], entry: string) => log.filter((l) => l === entry).length;
/**
 * The page's own initial load. Besides the immediate requests (the quote, the cost estimate, and the customer, which two panels read), the Scope panel and the Cost panel EACH re-request on an 800 ms mount timer. Those are not caused by
 * the edit under test, and where a click lands relative to them depends on how fast the machine is (on a slow runner they can enter the queue ahead of the edit's
 * preview). Wait - by what the queue observed, not by a delay - until both have been answered, then forget them.
 */
async function settleInitialLoad(log: string[]) {
  // UX-006i2: Stage 1 mounts neither the Scope nor the Cost panel (they are Stage 2, Estimator-only), so the initial load is the quote and the customer details.
  await waitFor(() => {
    expect(count(log, "end getQuoteCustomerAction")).toBeGreaterThanOrEqual(1);
    expect(log.filter((l) => l.startsWith("start ")).length).toBe(log.filter((l) => l.startsWith("end ")).length); // nothing still in flight
  }, { timeout: 8000 });
  log.length = 0;
}
import { fmtZar } from "../fields";
const digits = (t: string) => t.replace(/[^0-9]/g, "");
async function open(stage = "1") {
  (globalThis as { __STAGE?: string }).__STAGE = stage;
  asRoles("REP", "ESTIMATOR");
  vi.mocked(canSeeCosts).mockResolvedValue(true);
  const id = await storedQuote();
  (globalThis as { __QID?: string }).__QID = id;
  const { default: Page } = await import("../[id]/page");
  render(createElement(Page));
  await waitFor(() => expect(screen.getByLabelText(/Exclude CCM feeder/i)).toBeTruthy(), { timeout: 5000 });
  return id;
}

describe("UAT-003 rendered page: the Exclude checkbox recalculates without Save", () => {
  it("ticking Exclude updates the totals first (before any cost or scope request), shows it is unsaved, and unticking restores them; nothing is stored", async () => {
    const q = serialQueue(150); // installed BEFORE the page renders, so every request it makes is observed
    const id = await open();
    const stored = JSON.stringify(await loadQuote(db as never, ORG, id));
    const original = subtotal();
    const feeder = await expectedSubtotal(["feeder"]);
    await settleInitialLoad(q.log);
    fireEvent.click(box(/Exclude CCM feeder/i));
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    await waitFor(() => expect(subtotal()).not.toBe(original), { timeout: 5000 });
    await waitFor(() => expect(digits(subtotal())).toBe(digits(fmtZar(feeder))), { timeout: 5000 }); // exactly the excluded-feeder figure the engine gives
    // The queue is serial and was emptied after the initial load, so the first answer is the first request THIS edit made: it must be the recalculation.
    const firstEnd = q.log.findIndex((l) => l.startsWith("end "));
    expect(q.log[firstEnd]).toBe("end previewGrowerDraftAction"); // the preview is not queued behind the cost / scope requests
    fireEvent.click(box(/Exclude CCM feeder/i));
    await waitFor(() => expect(subtotal()).toBe(original), { timeout: 8000 });
    await sleep(1200);
    expect(JSON.stringify(await loadQuote(db as never, ORG, id))).toBe(stored);
    expect(q.spies.find((s) => s.n === "saveGrowerDraftAction")?.spy.mock.calls.length ?? 0).toBe(0);
  }, 30000);

  it("rapid repeated changes (slower than a keystroke, faster than a server round trip): no backlog builds, and the final figures belong to the FINAL state soon after the last click", async () => {
    await open();
    const original = subtotal();
    const finalWanted = await expectedSubtotal(["feeder", "bulk_tank"]);
    const q = serialQueue(800); // each server action takes most of a second, one at a time
    q.log.length = 0;
    // tick Feeder, tick Bulk tank, untick Feeder, tick Feeder again - 450 ms apart
    for (const l of [/Exclude CCM feeder/i, /Exclude Bulk feed tank/i, /Exclude CCM feeder/i, /Exclude CCM feeder/i]) { fireEvent.click(box(l)); await sleep(450); }
    // old behaviour: three requests per click queued behind each other, so the answer for the last click was still seconds away
    await waitFor(() => expect(digits(subtotal())).toBe(digits(fmtZar(finalWanted))), { timeout: 8000 });
    expect(digits(subtotal())).not.toBe(digits(original));
    await waitFor(() => expect(screen.queryByText(/Recalculating/)).toBeNull(), { timeout: 8000 });
    expect(q.log.filter((l) => l === "start previewGrowerDraftAction").length).toBeLessThanOrEqual(4);
  }, 30000);

  it("Save is disabled until every ticked exclusion has a reason; with one, Save persists exactly the figures that were shown", async () => {
    const id = await open();
    fireEvent.click(box(/Exclude CCM feeder/i));
    await waitFor(() => expect(screen.getByText("Unsaved changes")).toBeTruthy());
    const save = screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByText(/Enter a reason for each ticked exclusion/)).toBeTruthy();
    fireEvent.change(screen.getAllByPlaceholderText("Reason (required)")[0], { target: { value: "Customer supplies their own feeders" } });
    await waitFor(() => expect(screen.queryByText(/Recalculating/)).toBeNull(), { timeout: 8000 });
    const shown = subtotal();
    await waitFor(() => expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull(), { timeout: 8000 });
    expect(subtotal()).toBe(shown);
    const saved = await loadQuote(db as never, ORG, id);
    expect(saved!.draft.config.exclusions).toMatchObject({ feeder: "Customer supplies their own feeders" });
  }, 30000);
});

// UAT-025 on the quotation page: the result of Save draft is shown directly under the Save row (not in a banner at the top of a long page), a failure keeps the edits,
// and a double-click saves once.
describe("UAT-025 rendered page: Save draft reports beside its button", () => {
  async function editReady() {
    await open();
    fireEvent.click(box(/Exclude CCM feeder/i));
    fireEvent.change(screen.getAllByPlaceholderText("Reason (required)")[0], { target: { value: "Customer supplies their own feeders" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 8000 });
    return screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement;
  }
  const region = (kind: string) => document.querySelector(`[data-testid="action-feedback"][data-kind="${kind}"]`) as HTMLElement | null;

  it("success: the confirmation sits immediately after the Save row", async () => {
    const save = await editReady();
    fireEvent.click(save);
    await waitFor(() => expect(region("success")).not.toBeNull(), { timeout: 8000 });
    const ok = region("success")!;
    expect(ok.textContent).toMatch(/Draft saved/);
    expect(ok.getAttribute("role")).toBe("status");
    expect(ok.parentElement!.previousElementSibling).toBe(save.parentElement); // directly under the row that holds the Save button
  }, 30000);

  it("failure: an alert under the Save row with the server's reason, and the unsaved edits are untouched", async () => {
    const save = await editReady();
    vi.spyOn(actions, "saveGrowerDraftAction").mockResolvedValue({ ok: false, error: "This quote was changed by someone else. Reload to continue." } as never);
    fireEvent.click(save);
    await waitFor(() => expect(region("error")).not.toBeNull(), { timeout: 8000 });
    const bad = region("error")!;
    expect(bad.getAttribute("role")).toBe("alert");
    expect(bad.textContent).toMatch(/changed by someone else/);
    expect(bad.parentElement!.previousElementSibling).toBe(save.parentElement);
    expect(screen.getByText("Unsaved changes")).toBeTruthy(); // still dirty: nothing was lost
    expect((screen.getAllByPlaceholderText("Reason (required)")[0] as HTMLInputElement).value).toBe("Customer supplies their own feeders");
  }, 30000);

  it("a double-click on Save draft saves once", async () => {
    const save = await editReady();
    const spy = vi.spyOn(actions, "saveGrowerDraftAction");
    const { act } = await import("@testing-library/react");
    act(() => { fireEvent.click(save); fireEvent.click(save); });
    await waitFor(() => expect(region("success")).not.toBeNull(), { timeout: 8000 });
    expect(spy).toHaveBeenCalledTimes(1);
  }, 30000);
});

describe("unsaved quotation protection", () => {
  const unload = () => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
  it("an untouched quotation is not guarded; an edit is; Save releases it", async () => {
    serialQueue(150);
    await open();
    expect(unload()).toBe(false);
    fireEvent.click(box(/Exclude CCM feeder/i));
    expect(unload()).toBe(true);
    fireEvent.change(screen.getAllByPlaceholderText("Reason (required)")[0], { target: { value: "Customer supplies their own feeders" } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(screen.queryByText("Unsaved changes")).toBeNull(), { timeout: 8000 });
    expect(unload()).toBe(false);
  }, 30000);
});

describe("D3-C Solution Builder: visible selected / excluded states and a stable price summary", () => {
  afterEach(() => { (globalThis as { __STAGE?: string }).__STAGE = undefined; });
  it("the price summary shows the quote total and, with a response to an edit, says the figures are a preview of unsaved edits", async () => {
    await open();
    const bar = screen.getByTestId("quote-summary-bar");
    expect(within(bar).getByText("Quote total (ex VAT)")).toBeTruthy();
    expect(within(bar).getByText("Gross margin")).toBeTruthy(); // the viewer can see commercials
    expect(within(bar).queryByText(/unsaved edits/)).toBeNull();
    fireEvent.click(box(/Exclude CCM feeder/i));
    expect(within(bar).getByText("Preview of unsaved edits")).toBeTruthy();
    await waitFor(() => expect(within(bar).getByText("Preview of unsaved edits")).toBeTruthy(), { timeout: 8000 });
  }, 30000);
  it("an excluded section is marked 'Excluded' beside its own checkbox at once, and the unticked one says 'Included'", async () => {
    await open();
    const row = box(/Exclude CCM feeder/i).closest("li")!;
    expect(within(row).getByText("Included")).toBeTruthy();
    fireEvent.click(box(/Exclude CCM feeder/i));
    expect(within(row).getByText(/Excluded/)).toBeTruthy();
    expect(within(row).getByText("A reason is required before this can be saved.")).toBeTruthy();
    fireEvent.change(within(row).getByPlaceholderText("Reason (required)"), { target: { value: "Customer supplies their own feeders" } });
    expect(within(row).queryByText("A reason is required before this can be saved.")).toBeNull();
  }, 30000);
  it("optional equipment shows Included / Not included beside each choice on the Configuration stage", async () => {
    (globalThis as { __STAGE?: string }).__STAGE = "1";
    asRoles("REP", "ESTIMATOR");
    const id = await storedQuote();
    (globalThis as { __QID?: string }).__QID = id;
    const { default: Page } = await import("../[id]/page");
    render(createElement(Page));
    await waitFor(() => expect(screen.getByText("Equipment selections")).toBeTruthy(), { timeout: 5000 });
    const controller = box(/Thomas-CL1 controller/).closest("label")!;
    expect(controller.textContent).toMatch(/Included/); // the stored draft ticks the controller
    const silo = box(/Silo weighing/).closest("label")!;
    expect(silo.textContent).toMatch(/Not included/);
    fireEvent.click(box(/Silo weighing/));
    expect(silo.textContent).toMatch(/✓ Included/);
  }, 30000);

  it("when the live recalculation FAILS the bar says so in text, marks the total out of date, and does not call it a preview", async () => {
    await open();
    const bar = screen.getByTestId("quote-summary-bar");
    vi.spyOn(actions, "previewGrowerDraftAction").mockResolvedValue({ ok: false, error: "engine down" } as never);
    fireEvent.click(box(/Exclude CCM feeder/i));
    await waitFor(() => expect(within(bar).getByText("Recalculation failed - figures are out of date")).toBeTruthy(), { timeout: 8000 });
    expect(within(bar).queryByText("Preview of unsaved edits")).toBeNull();
    expect(within(bar).getByTestId("summary-stale").textContent).toBe("(out of date)");
  }, 30000);
  it("while recalculating, the total carries a visible 'Recalculating…' cue (not only an opacity change)", async () => {
    await open();
    vi.spyOn(actions, "previewGrowerDraftAction").mockImplementation(() => new Promise(() => undefined) as never);
    fireEvent.click(box(/Exclude CCM feeder/i));
    await waitFor(() => expect(screen.getByTestId("summary-stale").textContent).toBe("Recalculating…"), { timeout: 8000 });
    expect(screen.getByTestId("quote-summary-bar").getAttribute("aria-busy")).toBe("true");
  }, 30000);
  it("NEGATIVE: a viewer who cannot see commercials never sees the margin on any stage", async () => {
    for (const stage of ["1", "2", "4"]) {
      (globalThis as { __STAGE?: string }).__STAGE = stage;
      asRoles("REP");
      vi.mocked(canSeeCosts).mockResolvedValue(false);
      const id = await storedQuote();
      (globalThis as { __QID?: string }).__QID = id;
      const { default: Page } = await import("../[id]/page");
      render(createElement(Page));
      await waitFor(() => expect(screen.getByTestId("quote-summary-bar")).toBeTruthy(), { timeout: 8000 });
      await sleep(300);
      expect(within(screen.getByTestId("quote-summary-bar")).queryByText("Gross margin")).toBeNull();
      cleanup();
    }
  }, 60000);
  it("margin is shown on the working stages but hidden on the customer-facing quotation stage", async () => {
    await open();
    expect(within(screen.getByTestId("quote-summary-bar")).getByText("Gross margin")).toBeTruthy();
    cleanup();
    await open("4").catch(() => undefined);
    await waitFor(() => expect(screen.getByTestId("quote-summary-bar")).toBeTruthy(), { timeout: 8000 });
    expect(within(screen.getByTestId("quote-summary-bar")).queryByText("Gross margin")).toBeNull();
  }, 30000);
  describe("Manager: why Final approval is disabled", () => {
    async function openAsManager(signoff: "none" | "stale" | "current") {
      (globalThis as { __STAGE?: string }).__STAGE = "3";
      asRoles("MANAGER", "REP");
      vi.mocked(canSeeCosts).mockResolvedValue(true);
      const id = await storedQuote();
      const row = db.rows("newquip_quotes").find((r) => r.id === id)!;
      row.state = "ESTIMATOR_REVIEW";
      row.estimator_signoff_hash = signoff === "none" ? null : signoff === "stale" ? "stale-hash" : row.draft_hash;
      (globalThis as { __QID?: string }).__QID = id;
      const { default: Page } = await import("../[id]/page");
      render(createElement(Page));
      await waitFor(() => expect(screen.getByText("Manager approval", { selector: "p" })).toBeTruthy(), { timeout: 8000 });
    }
    const approve = () => screen.getByRole("button", { name: "Manager: final approval" }) as HTMLButtonElement;
    it("no sign-off: says it is waiting for the Estimator exactly once", async () => {
      await openAsManager("none");
      expect(screen.getAllByText(/Waiting for the Estimator/)).toHaveLength(1);
      expect(approve().disabled).toBe(true);
    }, 30000);
    it("stale sign-off: says the sign-off no longer matches", async () => {
      await openAsManager("stale");
      expect(screen.getByText(/no longer matches the current quotation/)).toBeTruthy();
      expect(approve().disabled).toBe(true);
    }, 30000);
    it("current sign-off but unsaved edits: says to save or discard first, and approval is disabled until then", async () => {
      await openAsManager("current");
      expect(screen.queryByText(/Save or discard your edits first/)).toBeNull();
      expect(approve().disabled).toBe(false);
      const nav = (n: number) => fireEvent.click(document.querySelector(`[data-stage="${n}"]`) as HTMLElement);
      nav(1);
      fireEvent.click(await screen.findByLabelText(/Silo weighing/)); // an unsaved edit
      nav(3);
      expect(await screen.findByText(/Save or discard your edits first/)).toBeTruthy();
      expect(approve().disabled).toBe(true);
      cleanup();
    }, 30000);
  });
});
