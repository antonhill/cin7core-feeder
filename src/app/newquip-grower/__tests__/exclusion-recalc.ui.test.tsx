// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  useSearchParams: () => new URLSearchParams("stage=2"),
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
const subtotal = () => {
  const dt = screen.getByText("Subtotal (ex VAT)");
  return dt.nextElementSibling!.textContent!;
};


const box = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const expectedSubtotal = async (exclude: string[]) => {
  const d = structuredClone(draft); d.config.exclusions = { ...d.config.exclusions, ...Object.fromEntries(exclude.map((k) => [k, "x"])) };
  const r = await actions.previewGrowerDraftAction(d);
  return r.data!.budget!.totals.subtotalExTax;
};
import { fmtZar } from "../fields";
const digits = (t: string) => t.replace(/[^0-9]/g, "");
async function open() {
  asRoles("REP", "ESTIMATOR");
  vi.mocked(canSeeCosts).mockResolvedValue(true);
  const id = await storedQuote();
  (globalThis as { __QID?: string }).__QID = id;
  const { default: Page } = await import("../[id]/page");
  render(createElement(Page));
  await waitFor(() => expect(screen.getByText("Customer-driven exclusions")).toBeTruthy(), { timeout: 5000 });
  return id;
}

describe("UAT-003 rendered page: the Exclude checkbox recalculates without Save", () => {
  it("ticking Exclude updates the totals first (before any cost or scope request), shows it is unsaved, and unticking restores them; nothing is stored", async () => {
    const id = await open();
    const stored = JSON.stringify(await loadQuote(db as never, ORG, id));
    const original = subtotal();
    const q = serialQueue(150);
    const feeder = await expectedSubtotal(["feeder"]);
    q.log.length = 0;
    fireEvent.click(box(/Exclude CCM feeder/i));
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    await waitFor(() => expect(subtotal()).not.toBe(original), { timeout: 5000 });
    await waitFor(() => expect(digits(subtotal())).toBe(digits(fmtZar(feeder))), { timeout: 5000 }); // exactly the excluded-feeder figure the engine gives
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
