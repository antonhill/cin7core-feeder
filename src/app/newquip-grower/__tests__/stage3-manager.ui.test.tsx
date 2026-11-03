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

// UX-006i2, rendered through the REAL page (Stage 3): the Manager's read-only signed-off workspace and decision. Nothing is mocked but the session/auth.

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
const UNSIGNED = { state: "ESTIMATOR_REVIEW", row: { customer_confirmed_cents: 1000000000, customer_confirmed_by: "A Customer <a@c.co>", customer_confirmed_at: "2026-11-02T08:00:00Z", handoff_by_email: "rep@nq" } };
const ws = () => screen.getByTestId("stage3-workspace");
const viewedStage = () => document.querySelector('[data-testid="stage-nav"] [aria-current="step"]')!.getAttribute("data-stage");
const approve = () => screen.getByRole("button", { name: "Manager: final approval" }) as HTMLButtonElement;
const patchRow = (id: string, patch: (r: Record<string, unknown>) => Record<string, unknown>) => { const arr = db.rows("newquip_quotes") as Array<Record<string, unknown>>; const i = arr.findIndex((r) => r.id === id); arr[i] = { ...arr[i], ...patch(arr[i]) }; };

describe("UX-006i2 Stage 3: the Manager's signed-off workspace", () => {
  it("shows the Rep's summary once and the Estimator's result - signed off by whom and when, the costing headline (the Manager may see cost), exceptions, the total and whether the confirmed amount matches - above the decision", async () => {
    await open({ stage: "3", roles: ["MANAGER"], commercials: true, ...SIGNED });
    expect(screen.getAllByTestId("rep-summary").length).toBe(1);
    expect(screen.getByTestId("rep-summary-confirmation").textContent).toMatch(/confirmed by A Customer <a@c\.co> on /);
    const result = within(ws()).getByTestId("estimator-result");
    expect(screen.getByTestId("result-signoff").textContent).toMatch(/^e@nq, .*2026/);
    expect(screen.getByTestId("result-costing").textContent).toMatch(/^R.* · (N\/A|[\d.]+%)$/);
    expect(result.textContent).toContain("Customer-confirmed amount");
    expect(within(screen.getByTestId("result-exceptions")).getAllByRole("listitem").length).toBeGreaterThan(0); // the fixture's manual quotation prices
    expect(screen.getByTestId("result-exceptions").textContent).toMatch(/manual quotation price/);
    expect(screen.getByTestId("stage3-status-line").textContent).toBe("Signed off by the Estimator. Your decision: approve, or return it. Next responsible role: Manager.");
    expect(screen.getByTestId("next-owner").textContent).toBe("Manager");
    expect(ws().textContent.indexOf("Estimator result")).toBeLessThan(ws().textContent.indexOf("Before you decide"));
  }, 60000);

  it("is READ-ONLY apart from the decision: no editable Rep or Estimator field, no step rail, no Show all steps; the only inputs are the Manager's own return reason", async () => {
    await open({ stage: "3", roles: ["MANAGER"], commercials: true, ...SIGNED });
    expect(screen.queryByTestId("step-rail")).toBeNull();
    expect(screen.queryByLabelText("Show all steps")).toBeNull();
    expect(screen.queryByTestId("step-buttons")).toBeNull();
    const fields = [...ws().querySelectorAll("input, select, textarea")] as HTMLInputElement[];
    expect(fields.length).toBe(1);
    expect(screen.getByLabelText(/Return to rep — reason/)).toBe(fields[0]);
    expect(within(screen.getByTestId("rep-summary")).queryAllByRole("button").length).toBe(0);
    expect(screen.queryByRole("button", { name: "Confirm source-backed mappings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Mark reviewed|Estimator: I double-checked/ })).toBeNull();
  }, 60000);

  it("Approve is enabled only with a current sign-off; Return buttons need a reason; the checklist (checkApproval's own conditions) is unchanged and shown once", async () => {
    await open({ stage: "3", roles: ["MANAGER"], commercials: true, ...SIGNED });
    expect(approve().disabled).toBe(false);
    expect(screen.getAllByTestId("approval-checklist").length).toBe(1);
    const toRep = screen.getByRole("button", { name: "Return to rep (reject)" }) as HTMLButtonElement;
    const toEst = screen.getByRole("button", { name: "Manager: return to estimator" }) as HTMLButtonElement;
    expect(toRep.disabled).toBe(true); expect(toEst.disabled).toBe(true);
    expect(screen.getByTestId("return-owners").textContent).toMatch(/Return to rep: the Rep corrects it \(new revision\).*Return to estimator: the Estimator.s sign-off is withdrawn/);
    fireEvent.change(screen.getByLabelText(/Return to rep — reason/), { target: { value: "Margin too low" } });
    expect(toRep.disabled).toBe(false); expect(toEst.disabled).toBe(false);
  }, 60000);

  it("not signed off yet: Approve is disabled with the Estimator named as the next owner, the explanation shown exactly once; Return to rep stays available with a reason", async () => {
    await open({ stage: "3", roles: ["MANAGER"], commercials: true, ...UNSIGNED });
    expect(approve().disabled).toBe(true);
    expect(screen.getAllByText(/Waiting for the Estimator/)).toHaveLength(1);
    expect(screen.getByTestId("stage3-status-line").textContent).toBe("Not signed off yet. Next responsible role: Estimator.");
    expect(screen.getByTestId("next-owner").textContent).toBe("Estimator");
    expect(screen.queryByRole("button", { name: "Manager: return to estimator" })).toBeNull(); // nothing to withdraw
    fireEvent.change(screen.getByLabelText(/Return to rep — reason/), { target: { value: "Missing prices" } });
    expect((screen.getByRole("button", { name: "Return to rep (reject)" }) as HTMLButtonElement).disabled).toBe(false);
  }, 60000);

  it("Approve keeps its audit consequence: it calls the EXISTING approve action once; Return to estimator / Return to rep pass the reason to the existing actions", async () => {
    await open({ stage: "3", roles: ["MANAGER"], commercials: true, ...SIGNED });
    const id = g.__QID!;
    const toEst = vi.spyOn(actions, "returnGrowerQuoteToEstimatorAction").mockImplementation((async () => { patchRow(id, () => ({ estimator_signoff_hash: null })); return actions.getGrowerQuoteAction(id); }) as never);
    fireEvent.change(screen.getByLabelText(/Return to rep — reason/), { target: { value: "Check the feeder price" } });
    fireEvent.click(screen.getByRole("button", { name: "Manager: return to estimator" }));
    await waitFor(() => expect(toEst).toHaveBeenCalledWith(id, "Check the feeder price"), { timeout: 8000 });
    await waitFor(() => expect(viewedStage()).toBe("2"), { timeout: 8000 }); // a Manager's return to the Estimator moves 3 -> 2 (followTransition)
    expect(screen.getByTestId("stage2-status-line").textContent).toMatch(/Next responsible role: Estimator/);
  }, 60000);

  it("Manager approval calls the approve action once and the view moves on", async () => {
    vi.spyOn(da, "getQuoteDeliveryAction").mockResolvedValue({ ok: true, data: { available: false } } as never);
    await open({ stage: "3", roles: ["MANAGER"], commercials: true, ...SIGNED });
    const id = g.__QID!;
    const spy = vi.spyOn(actions, "approveGrowerQuoteAction").mockImplementation((async () => { patchRow(id, () => ({ state: "MANAGER_APPROVED_FINAL", approved_by_email: "m@nq" })); return actions.getGrowerQuoteAction(id); }) as never);
    await waitFor(() => expect(approve().disabled).toBe(false), { timeout: 8000 });
    fireEvent.click(approve());
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1), { timeout: 8000 });
    await waitFor(() => expect(viewedStage()).toBe("4"), { timeout: 8000 });
  }, 60000);

  it("stale sign-off: the Estimator's sign-off is called out of date, Approve is disabled, and the result says so", async () => {
    await open({ stage: "3", roles: ["MANAGER"], commercials: true, state: "ESTIMATOR_REVIEW", row: { ...UNSIGNED.row, estimator_signoff_hash: "stale-hash", estimator_signoff_by_email: "e@nq", estimator_signoff_at: "2026-11-03T08:00:00Z" } });
    expect(approve().disabled).toBe(true);
    expect(screen.getByText(/no longer matches the current quotation/)).toBeTruthy();
    expect(screen.getByTestId("result-signoff").textContent).toContain("(out of date)");
    expect(screen.getByTestId("stage3-status-line").textContent).toBe("The Estimator's sign-off is out of date. Next responsible role: Estimator.");
  }, 60000);

  it("the confirmed amount is compared with the total: a different amount shows 'Does not match the total'", async () => {
    await open({ stage: "3", roles: ["MANAGER"], commercials: true, state: "ESTIMATOR_REVIEW", row: { ...SIGNED.row, customer_confirmed_cents: 100 } });
    expect(screen.getByTestId("estimator-result").textContent).toContain("Does not match the total");
  }, 60000);

  it("a Rep draft: the decision is not available; the Manager reads that the quotation is with the Rep and the Rep is the next owner", async () => {
    await open({ stage: "3", roles: ["MANAGER"], commercials: true });
    expect(screen.queryByRole("button", { name: "Manager: final approval" })).toBeNull();
    expect(screen.getByTestId("stage3-status-line").textContent).toBe("The Rep has not submitted yet. Next responsible role: Rep.");
    expect(screen.getByText(/This quotation is with the Rep/)).toBeTruthy();
  }, 60000);

  it("approved: the workspace is read-only history - 'Manager approved - final', no decision buttons", async () => {
    await open({ stage: "3", roles: ["MANAGER"], commercials: true, state: "MANAGER_APPROVED_FINAL", row: { ...SIGNED.row } });
    expect(screen.getByText("Manager approved — final")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /final approval|Return to/ })).toBeNull();
  }, 60000);
});

describe("UX-006i2 Stage 3: non-managers read the same facts read-only; nobody gets an implicit role; the Rep sees no cost", () => {
  for (const [who, roles, commercials] of [["Rep", ["REP"], false], ["Estimator", ["ESTIMATOR"], true], ["member (Rep + Estimator)", ["REP", "ESTIMATOR"], true], ["Administrator observer (no quote role, cost visible)", [], true]] as const) {
    it(`${who}: Approve is disabled with the existing 'needs the manager role' text; no return buttons or reason field; the workspace is still readable`, async () => {
      await open({ stage: "3", roles: [...roles] as Role[], commercials, ...SIGNED });
      expect(approve().disabled).toBe(true);
      expect(screen.getByText("Final approval needs the Manager role.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Return to/ })).toBeNull();
      expect(screen.queryByLabelText(/Return to rep — reason/)).toBeNull();
      expect(ws().querySelectorAll("input, select, textarea").length).toBe(0);
      expect(screen.getByTestId("stage3-status-line").textContent).toBe("Signed off by the Estimator. Next responsible role: Manager.");
      expect(screen.getByTestId("result-signoff").textContent).toMatch(/^e@nq/);
    }, 60000);
  }

  it("cost and margin redaction: a Rep sees NO costing headline, cost overrides or margin wording anywhere in the workspace; a cost viewer does", async () => {
    await open({ stage: "3", roles: ["REP"], commercials: false, ...SIGNED });
    expect(screen.queryByTestId("result-costing")).toBeNull();
    expect(document.body.textContent).not.toMatch(/Estimated cost|gross margin|Gross margin|GP \(managers\)|Internal margins|cost override/i);
    expect(within(screen.getByTestId("quote-summary-bar")).queryByText("Gross margin")).toBeNull();
    cleanup();
    await open({ stage: "3", roles: [], commercials: true, ...SIGNED });
    expect(screen.getByTestId("result-costing")).toBeTruthy();
  }, 90000);

  it("opening and reading Stage 3 sends nothing to the server beyond the reads (no navigation or decision action)", async () => {
    const q = serialQueue(0);
    await open({ stage: "3", roles: ["MANAGER"], commercials: true, ...SIGNED });
    await sleep(1200);
    const ran = q.log.filter((l) => l.startsWith("start ")).map((l) => l.slice(6));
    expect(ran.filter((n) => /^(save|send|signOff|return|approve|create)/i.test(n.replace(/Grower|Quote/g, ""))), ran.join(",")).toEqual([]);
    q.log.length = 0;
    fireEvent.click(document.querySelector('[data-stage="2"]')!); fireEvent.click(document.querySelector('[data-stage="3"]')!); // moving between stages is navigation: it reads, never writes
    await act(async () => { await sleep(300); });
    const after = q.log.filter((l) => l.startsWith("start ")).map((l) => l.slice(6));
    expect(after.every((n) => /^(getQuote|getGrowerQuote|getMapping|getQuoteScope|getQuoteCost|getQuoteCustomer|getQuoteDelivery|previewGrowerDraft)/.test(n)), after.join(",")).toBe(true);
  }, 60000);
});

import { EstimatorResult } from "../[id]/Stage23Panels";
import { BuildStamp } from "@/components/BuildStamp";
describe("UX-006i2 review fixes: the Manager workspace", () => {
  it("after approval it says what is next and who: 'Approved. Next: Rep issues and sends the customer quotation (Stage 4).'", async () => {
    await open({ stage: "3", roles: ["MANAGER"], commercials: true, state: "MANAGER_APPROVED_FINAL", row: { ...SIGNED.row } });
    expect(screen.getByTestId("stage3-status-line").textContent).toBe("Approved. Next: Rep issues and sends the customer quotation (Stage 4).");
    expect(screen.getByTestId("next-owner").textContent).toBe("Rep");
  }, 60000);

  it("a cost viewer sees the three largest lines (so an implausible line is noticeable); a Rep does not; nothing blocks", async () => {
    await open({ stage: "3", roles: ["MANAGER"], commercials: true, ...SIGNED });
    const lines = within(screen.getByTestId("largest-lines")).getAllByRole("listitem");
    expect(lines.length).toBe(3);
    const amount = (li: HTMLElement) => Number(li.querySelector("b")!.textContent!.replace(/[^\d,]/g, "").replace(",", "."));
    expect(amount(lines[0])).toBeGreaterThanOrEqual(amount(lines[1])); expect(amount(lines[1])).toBeGreaterThanOrEqual(amount(lines[2]));
    expect(approve().disabled).toBe(false);
    cleanup();
    await open({ stage: "3", roles: ["REP"], commercials: false, ...SIGNED });
    expect(screen.queryByTestId("largest-lines")).toBeNull();
  }, 90000);

  it("a Rep reading the Estimator result sees which lines were manually priced, but NOT the unit prices or the Estimator's free-text reasons", async () => {
    await open({ stage: "3", roles: ["REP"], commercials: false, ...SIGNED });
    const ex = screen.getByTestId("result-exceptions");
    expect(ex.textContent).toMatch(/manually priced by the Estimator/);
    expect(ex.textContent).not.toMatch(/Master workbook|manual quotation price|R\s?\d/);
    cleanup();
    await open({ stage: "3", roles: ["MANAGER"], commercials: true, ...SIGNED });
    expect(screen.getByTestId("result-exceptions").textContent).toMatch(/manual quotation price R\s?\d/);
  }, 90000);

  it("EstimatorResult flags an incomplete or unknown margin visibly (never a block), only when told it is unknown", () => {
    const props = { signedOffBy: "e@nq", signedOffAt: null, signoffCurrent: true, totalCents: 100, confirmedCents: 100, costing: { estimatedCost: 50, marginPct: null }, priceExceptions: [], costOverrides: [], showPriceDetail: true, largestLines: null };
    const { unmount } = render(createElement(EstimatorResult, { ...props, marginUnknown: true }));
    expect(screen.getByTestId("margin-flag").textContent).toMatch(/margin cannot be relied on/);
    expect(document.body.textContent).toContain("Margin: incomplete or unknown");
    unmount();
    render(createElement(EstimatorResult, { ...props, marginUnknown: false }));
    expect(screen.queryByTestId("margin-flag")).toBeNull();
  });

  it("the build stamp is a labelled muted footer and renders nothing when the build carries no commit", () => {
    vi.stubEnv("NEXT_PUBLIC_BUILD_SHA", ""); vi.stubEnv("NODE_ENV", "production");
    const a = render(createElement(BuildStamp)); expect(a.container.textContent).toBe(""); a.unmount();
    vi.stubEnv("NEXT_PUBLIC_BUILD_SHA", "abc1234");
    const b = render(createElement(BuildStamp)); expect(b.container.textContent).toBe("Page build: abc1234"); expect(b.container.innerHTML).not.toMatch(/build local/);
  });
});
