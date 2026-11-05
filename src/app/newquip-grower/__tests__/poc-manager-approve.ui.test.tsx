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
import { POC_MARKER } from "@/lib/newquip-quotes/poc-presentation";
const demoAvail = vi.fn(); const demoSelect = vi.fn();
vi.mock("@/app/demo-mode/actions", () => ({ demoSwitchAvailableAction: (...a: unknown[]) => demoAvail(...a), selectDemoIdentityAction: (...a: unknown[]) => demoSelect(...a) }));

// UX-006i2, rendered through the REAL page (Stage 3): the Manager's read-only signed-off workspace and decision. Nothing is mocked but the session/auth.

let db: FakeDb;
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn() }));
vi.mock("@/lib/approvals/role-store", () => ({ resolveRoles: vi.fn(), canSeeCosts: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
const ORG = "e1aea782-d095-47ad-90fb-4fa65c9bf855";
import { seedGoldenLibrary } from "@/newquip/grower/__tests__/golden-catalogue";
const SESSION = { orgId: ORG, userId: "u1", email: "u@nq" };
const member = rolesFor("member");
const asRoles = (...r: Array<"REP" | "ESTIMATOR" | "MANAGER">) => vi.mocked(resolveRoles).mockResolvedValue(new Set(r) as never);

beforeEach(() => {
  db = new FakeDb();
  // D-19 (expected workflow change): an unmapped product the Estimator only typed a price for (the LED line) is now reported to the Manager and DISABLES plain Approve, because the server refuses it
  // and no exception can cover it. These fixtures are about the Manager decision on a clean quotation, so the golden library maps all three packages (the shared helper); the unmapped case is
  // asserted in baseline-exception.test.ts / the Stage 3 checklist tests.
  seedGoldenLibrary(db, ORG);

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

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

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

const SIGNED = { state: "ESTIMATOR_REVIEW", row: { customer_confirmed_cents: 1000000000, customer_confirmed_by: "A Customer <a@c.co>", customer_confirmed_at: "2026-11-02T08:00:00Z", handoff_by_email: "rep@nq", estimator_signoff_by_email: "e@nq", estimator_signoff_at: "2026-11-03T08:00:00Z", __useDraftHash: true } };
// An authorised incomplete-cost exception (the server waives the COST part of costing-complete): approval is then not refused for costs.
const COSTED = { estimator: { ...draft.estimator, costBasis: { incompleteAccepted: { reason: "Test exception", by: "e@nq", at: "2026-11-02T08:00:00Z" } } } };
const UNSIGNED = { state: "ESTIMATOR_REVIEW", row: { customer_confirmed_cents: 1000000000, customer_confirmed_by: "A Customer <a@c.co>", customer_confirmed_at: "2026-11-02T08:00:00Z", handoff_by_email: "rep@nq" } };
const ws = () => screen.getByTestId("stage3-workspace");
const viewedStage = () => document.querySelector('[data-testid="stage-nav"] [aria-current="step"]')!.getAttribute("data-stage");
const approve = () => screen.getByRole("button", { name: "Manager: final approval" }) as HTMLButtonElement;
const patchRow = (id: string, patch: (r: Record<string, unknown>) => Record<string, unknown>) => { const arr = db.rows("newquip_quotes") as Array<Record<string, unknown>>; const i = arr.findIndex((r) => r.id === id); arr[i] = { ...arr[i], ...patch(arr[i]) }; };
const REF = "pnzwjqjovxxdikxtfngq";
const pocOn = () => { vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("NEWQUIP_POC_PRESENTATION", "true"); vi.stubEnv("SUPABASE_URL", `https://${REF}.supabase.co`); vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `https://${REF}.supabase.co`); };
const marked = { estimator: { ...COSTED.estimator, assumptions: `${POC_MARKER}: test` } };

describe("POC Presentation Mode: the Manager has ONE Approve & Continue action and no commercial diagnostics", () => {
  it("a marked quotation with unmapped lines (the LED) and a required exception: Approve & Continue is enabled, no exception wording, no readiness checklist; it approves and continues as the Rep", async () => {
    pocOn(); demoAvail.mockResolvedValue(true); demoSelect.mockResolvedValue({ ok: true });
    db.rows("newquip_package_mappings").length = 0;
    const replace = vi.fn(); vi.stubGlobal("location", { pathname: "/newquip-grower/x", replace, assign: vi.fn() });
    await open({ stage: "3", roles: ["MANAGER"], commercials: true, ...SIGNED, draftOver: marked });
    const btn = await screen.findByTestId("poc-approve", {}, { timeout: 8000 }) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(false), { timeout: 8000 });
    expect(btn.textContent).toMatch(/Approve & Continue/);
    expect(screen.queryByRole("button", { name: "Manager: final approval" })).toBeNull();
    const t = ws().textContent ?? "";
    expect(t).not.toMatch(/recorded exception|Mapping unresolved|library mapping|Costing is complete|costing is incomplete/i);
    expect(screen.queryByTestId("approval-checklist")).toBeNull();
    vi.spyOn(da, "getQuoteDeliveryAction").mockResolvedValue({ ok: true, data: { available: false } } as never);
    const id = g.__QID!;
    const spy = vi.spyOn(actions, "approveGrowerQuoteAction").mockImplementation((async () => { patchRow(id, () => ({ state: "MANAGER_APPROVED_FINAL", approved_by_email: "m@nq" })); return actions.getGrowerQuoteAction(id); }) as never);
    fireEvent.click(btn);
    await sleep(6000); void spy; console.log("AFTERCLICK", (document.body.textContent ?? "").match(/(Could not|cannot|refus|Approval|incomplete|not)[^.]{0,200}/gi)?.slice(0, 6));
    await waitFor(() => expect((db.rows("newquip_quotes")[0] as Record<string, unknown>).state).toBe("MANAGER_APPROVED_FINAL"), { timeout: 20000 });
    await waitFor(() => expect(demoSelect).toHaveBeenCalledWith("rep"), { timeout: 8000 });
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/newquip-grower/x"), { timeout: 8000 }); // same quotation, no other id
  }, 60000);

  it("an UNMARKED quotation keeps the normal Manager screen: plain approval disabled by the mapping block, no Approve & Continue", async () => {
    pocOn(); demoAvail.mockResolvedValue(true);
    db.rows("newquip_package_mappings").length = 0;
    await open({ stage: "3", roles: ["MANAGER"], commercials: true, ...SIGNED, draftOver: COSTED });
    const b = await screen.findByRole("button", { name: "Manager: final approval" }, { timeout: 8000 }) as HTMLButtonElement;
    await waitFor(() => expect(b.disabled).toBe(true), { timeout: 8000 });
    expect(screen.queryByTestId("poc-approve")).toBeNull();
  }, 60000);
});
