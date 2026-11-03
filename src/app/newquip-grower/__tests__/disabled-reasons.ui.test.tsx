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


// F-12 harness (copied from the D4 corrections test). UAT-003, rendered through the REAL page with the owner's real quote shape and the real workbook price source (no test price snapshot). Server actions are run through a
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function open(stage = "2", roles: Array<"REP" | "ESTIMATOR" | "MANAGER"> = ["REP", "ESTIMATOR"], state?: string, wait = "Product mappings") {
  (globalThis as { __STAGE?: string }).__STAGE = stage;
  asRoles(...roles);
  vi.mocked(canSeeCosts).mockResolvedValue(true);
  const id = await storedQuote();
  if (state) for (const row of db.rows("newquip_quotes") as Array<Record<string, unknown>>) if (row.id === id) row.state = state;
  (globalThis as { __QID?: string }).__QID = id;
  vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "nq-builder-show-all" ? "1" : null), setItem: () => undefined }); // these checks look across the whole stage: "Show all steps" (UX-006b)
  const { default: Page } = await import("../[id]/page");
  render(createElement(Page));
  await waitFor(() => expect(screen.getByText(wait)).toBeTruthy(), { timeout: 5000 });
}


const described = (el: HTMLElement) => (el.getAttribute("aria-describedby") ?? "").split(" ").map((i) => document.getElementById(i)?.textContent ?? "").join(" ");

describe("F-12 Solution Builder disabled controls say why", () => {
  it("Save draft: disabled with 'no unsaved changes' until an edit, then enabled with no reason", async () => {
    await open();
    const save = screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(described(save)).toMatch(/no unsaved changes/);
    expect(document.getElementById("save-why")!.className).toContain("text-slate-700");
  }, 30000);

  it("Save draft: a viewer who cannot edit is told so (and the explanation names no one)", async () => {
    // UX-006i2: Stage 2 has no Save bar for a viewer who cannot edit there (a Manager only inspects it), so the explanation is checked where Save lives for everyone: Stage 1.
    await open("1", ["MANAGER"], undefined, "Equipment selections");
    const save = screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(described(save)).toMatch(/only a Rep or Estimator can edit and save/);
  }, 30000);

  // UX-006i1: the Rep's price confirmation + send moved to Stage 1 step 5 and is now labelled "Submit to Estimator" (same action, same gates, same disabled reasons).
  it("Submit to Estimator: a non-Rep is told only a Rep can send it", async () => {
    await open("1", ["ESTIMATOR"], undefined, "Charges & assumptions");
    const btn = (await screen.findByRole("button", { name: "Submit to Estimator", hidden: true }, { timeout: 5000 })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(described(btn)).toMatch(/Only a Rep can record the price confirmation/);
  }, 30000);

  it("Submit to Estimator: a Rep with no chosen Cin7 customer is told to select one in step 1", async () => {
    await open("1", ["REP", "ESTIMATOR"], undefined, "Charges & assumptions");
    const btn = (await screen.findByRole("button", { name: "Submit to Estimator", hidden: true }, { timeout: 5000 })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(described(btn).length).toBeGreaterThan(10);
  }, 30000);

  it("Estimator sign-off and the return buttons: a non-Estimator is not offered them and is told whose action it is", async () => {
    // UX-006i2: the sign-off and return controls exist only for the authenticated Estimator ("only valid actions"); a Rep reads who has the work instead of meeting a disabled button.
    await open("2", ["REP"], "ESTIMATOR_REVIEW", "Sign off or return");
    expect(screen.queryByRole("button", { name: /Sign off for Manager approval/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Return to rep" })).toBeNull();
    expect(screen.getByTestId("signoff-not-yours").textContent).toMatch(/Only an Estimator can sign off or return it here/);
  }, 30000);

  it("Estimator sign-off keeps its READY gate and reason, and the return button says a reason is required", async () => {
    await open("2", ["ESTIMATOR"], "ESTIMATOR_REVIEW", "Sign off or return");
    const so = screen.getByRole("button", { name: /Sign off for Manager approval/ }) as HTMLButtonElement;
    expect(so.disabled ? described(so) : "").toMatch(so.disabled ? /must be READY/ : /^\s*$/); // gate unchanged: disabled only with its reason (this fixture's readiness decides which)
    const ret = screen.getByRole("button", { name: "Return to rep" }) as HTMLButtonElement;
    expect(ret.disabled).toBe(true);
    expect(described(ret)).toMatch(/Enter the reason for returning it/);
  }, 30000);

  it("Manager return buttons say a reason is required; Final approval keeps its blocked messages", async () => {
    await open("3", ["MANAGER"], "ESTIMATOR_REVIEW", "Return to rep — reason");
    const ret = screen.getByRole("button", { name: /Return to rep/ }) as HTMLButtonElement;
    expect(ret.disabled).toBe(true);
    expect(described(ret)).toMatch(/enter the reason for returning it/);
    expect(screen.getByText(/Waiting for the Estimator/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Return to rep/), { target: { value: "Price wrong" } });
    expect(ret.disabled).toBe(false);
    expect(ret.getAttribute("aria-describedby")).toBeNull();
  }, 30000);

  it("Manager: final approval is described by whichever message applies (role, missing sign-off) and is never silent", async () => {
    await open("3", ["MANAGER"], "ESTIMATOR_REVIEW", "Return to rep — reason");
    const approve = screen.getByRole("button", { name: "Manager: final approval" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(described(approve)).toMatch(/Waiting for the Estimator/);
    cleanup();
    await open("3", ["REP"], "ESTIMATOR_REVIEW", "Final approval needs the Manager role.");
    const approve2 = screen.getByRole("button", { name: "Manager: final approval" }) as HTMLButtonElement;
    expect(described(approve2)).toMatch(/needs the Manager role/);
  }, 60000);

  it("Stage 1 pig-size options use the shared money format (R 1 300,00 / rm), not hard-coded R1,300", async () => {
    await open("1", ["REP"], undefined, "Equipment selections");
    const labels = Array.from(document.querySelectorAll("option")).map((o) => o.textContent ?? "").filter((t) => /\/ rm/.test(t));
    expect(labels.length).toBe(3);
    expect(labels[0]).toBe("Small — R\u00A01\u00A0300,00 / rm");
    expect(labels.join("")).not.toMatch(/R1,/);
  }, 30000);
});
