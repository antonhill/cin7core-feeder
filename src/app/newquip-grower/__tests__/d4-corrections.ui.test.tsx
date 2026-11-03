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
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function open(stage = "2", state?: string) {
  (globalThis as { __STAGE?: string }).__STAGE = stage;
  asRoles("REP", "ESTIMATOR");
  vi.mocked(canSeeCosts).mockResolvedValue(true);
  const id = await storedQuote();
  // UX-006i2: the costing steps open once the Rep has submitted (they are locked on a Rep draft), so the cost-panel checks run on a quotation in Estimator review.
  if (state) for (const row of db.rows("newquip_quotes") as Array<Record<string, unknown>>) if (row.id === id) row.state = state;
  (globalThis as { __QID?: string }).__QID = id;
  vi.stubGlobal("localStorage", { getItem: (k: string) => (k === "nq-builder-show-all" ? "1" : null), setItem: () => undefined }); // these checks look across the whole stage: "Show all steps" (UX-006b)
  const { default: Page } = await import("../[id]/page");
  render(createElement(Page));
  await waitFor(() => expect(screen.getByText("Product mappings")).toBeTruthy(), { timeout: 5000 }); // UX-006i2: the exclusions are the Rep's (Stage 1); "Product mappings" is the Estimator's step 1 panel that marks Stage 2 as loaded
}

// D4 audit corrections (display only). Class-level checks for the layout fixes; wording checks for the rest.
describe("D4 corrections on the Solution Builder quote page", () => {
  it("F-03: the page is titled Solution Builder and the breadcrumb says Solution Builder quotes", async () => {
    await open();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Solution Builder");
    expect(screen.getByText(/Solution Builder quotes/)).toBeTruthy();
    expect(screen.queryByText(/Grower quotes/)).toBeNull();
  }, 30000);

  it("F-01: every money figure in the Line decisions table cannot wrap, and the displayed text is the same", async () => {
    await open();
    const table = screen.getByRole("table", { name: "Line decisions" });
    const money = [...table.querySelectorAll("tbody td")].filter((td) => /^R\s[\d\s,]+,\d\d$/.test(td.textContent!.trim()));
    expect(money.length).toBeGreaterThan(3);
    for (const td of money) expect(td.className).toContain("whitespace-nowrap");
  }, 30000);

  it("F-07: the unit / exception declarations stack below sm and their cards may shrink, so a phone does not scroll sideways", async () => {
    await open("2", "ESTIMATOR_REVIEW");
    await screen.findByText("Unit of measure", {}, { timeout: 8000 });
    const rows = ["Confirm per stock unit", "Record exception"].map((n) => screen.queryByRole("button", { name: n })?.parentElement).filter(Boolean) as HTMLElement[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) { expect(r.className).toContain("flex-col"); expect(r.className).toContain("sm:flex-row"); expect(r.firstElementChild!.className).toContain("min-w-0"); expect(r.parentElement!.className).toContain("min-w-0"); }
    // UX-006i1: the Rep's "Submit to Estimator" moved to Stage 1 step 5. UX-006i2: Stage 2 no longer has a Submit step or pointer at all (the Rep's summary replaces it).
    expect(screen.queryByRole("button", { name: /Record pre-approval price confirmation/ })).toBeNull();
    expect(screen.queryByTestId("submit-pointer")).toBeNull();
    expect(screen.getByTestId("rep-summary")).toBeTruthy();
  }, 30000);
});
