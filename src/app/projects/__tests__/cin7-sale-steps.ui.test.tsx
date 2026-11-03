// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Cin7SaleCreationPanel } from "../[id]/Cin7SaleCreationPanel";
import { ProjectFeedbackProvider } from "../[id]/feedback-context";
import { useKeyedActions, type ActionOutcome, type Reconciled } from "@/components/ui/action-feedback";
import * as c7 from "../cin7-actions";
import type { ProjectView } from "@/lib/projects/project-view";

// UX-006e: guided steps over the Cin7 Sale creation panel. The host mimics the Project workspace's run().
// OWNER REQUIREMENT: prove which interactions write. Navigation (Back/Next/rail/show-all/next-incomplete) calls NO action; createCin7SaleAction is called only by the final button.

vi.mock("../cin7-actions", () => ({
  getCin7ReferenceOptionsAction: vi.fn(), createCin7SaleAction: vi.fn(), getPackageMappingAction: vi.fn(), getCin7SaleCreationStatusAction: vi.fn(),
  reconcileCin7SaleCreationAction: vi.fn(), resolveScopeItemAction: vi.fn(), runP0ChecklistAction: vi.fn(),
}));
vi.mock("../[id]/VariationProductPicker", () => ({ VariationProductPicker: () => null }));

const view = { project: { id: "p1", customer_name: "Spark", originating_quote_ref: "NQ-Q-0017", tax_rate_bps: 1500 }, stages: [{ id: "s1", name: "Deposit", valueCents: 50_000_000 }] } as unknown as ProjectView;
const item = { id: "i1", description: "Pump station", unit: "ea", quantity: 2, origin: { section: "Equipment" }, mapping: { status: "UNMAPPED", reason: "No SKU" }, resolution: null };
const gates = { orgEnabled: true, isManager: true, writesEnabled: true };
const status = (over: Record<string, unknown> = {}) => ({ ok: true, data: { gates, creation: null, linked: false, scopeItems: [], saleLines: [], blockers: [], excluded: [], ...over } });
const ACTIONS = ["createCin7SaleAction", "resolveScopeItemAction", "runP0ChecklistAction", "reconcileCin7SaleCreationAction", "getPackageMappingAction", "getCin7SaleCreationStatusAction"] as const;

let initial: ReturnType<typeof status>["data"] | null = null;
function Host() {
  const acts = useKeyedActions();
  const run = (fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>, done?: string, key = "page", opts?: { success?: (v: unknown, r: { data?: unknown }) => string; reconcile?: () => Promise<Reconciled>; doneAfterReconcile?: string; exclusive?: boolean; cin7?: boolean }) =>
    acts.run(key, async () => ({ ...(await fn()) }), { success: (r) => (opts?.success ? opts.success(null, r) : done ?? "Done."), reconcile: opts?.reconcile, doneAfterReconcile: opts?.doneAfterReconcile, exclusive: opts?.exclusive, cin7: opts?.cin7 });
  return <ProjectFeedbackProvider value={acts.stateOf}><Cin7SaleCreationPanel view={view} run={run} working={acts.anyPending} boot={initial as never} /></ProjectFeedbackProvider>;
}
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const rail = (id: string) => document.querySelector(`[data-testid="step-rail"] [data-step="${id}"]`) as HTMLElement;
const current = () => document.querySelector('[data-testid="step-rail"] [aria-current="step"]')!.getAttribute("data-step");
const panelOf = (id: string) => document.querySelector(`[data-step-panel="${id}"]`) as HTMLElement;
const goto = (id: string) => fireEvent.click(rail(id));
const nextBtn = () => screen.queryByRole("button", { name: "Next" });
const createBtn = () => screen.getByRole("button", { name: "Create Sales Order in Cin7" }) as HTMLButtonElement;
const tick = () => fireEvent.click(screen.getByLabelText(/I confirm I want to create one Cin7 Sales Order/));
const callsToActions = () => ACTIONS.map((n) => vi.mocked(c7[n] as never as () => unknown).mock.calls.length);
const fillAccount = () => { fireEvent.change(screen.getByLabelText("Revenue account code"), { target: { value: "200" } }); fireEvent.change(screen.getByLabelText("Cin7 location"), { target: { value: "MSTR" } }); }; // the references: account and location

beforeEach(() => {
  initial = status({ scopeItems: [item], blockers: [item] }).data;
  vi.mocked(c7.getCin7SaleCreationStatusAction).mockResolvedValue(status() as never);
  vi.mocked(c7.getCin7ReferenceOptionsAction).mockResolvedValue({ ok: false, error: "n/a" } as never);
  vi.stubGlobal("localStorage", (() => { const d: Record<string, string> = {}; return { getItem: (k: string) => d[k] ?? null, setItem: (k: string, v: string) => { d[k] = v; } }; })());
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("steps and status", () => {
  it("shows four steps, starts guided on step 1, and derives status from state (blockers -> Needs attention)", async () => {
    render(<Host />);
    expect(Array.from(document.querySelectorAll("[data-testid=step-rail] ol > li")).length).toBe(4);
    expect(current()).toBe("scope");
    expect(screen.getByTestId("step-status-scope").textContent).toBe("Needs attention");
    expect(screen.getByTestId("step-status-refs").textContent).toBe("Not complete"); // revenue account blank
    expect(screen.getByTestId("step-status-preflight").textContent).toBe("Not complete");
    expect(panelOf("refs").hasAttribute("hidden")).toBe(true);
    expect(panelOf("refs").hasAttribute("inert")).toBe(true);
    expect(screen.getByTestId("step-status-confirm").textContent).toBe("Not complete");
  });
  it("visiting a step never completes it; typing the missing reference does", () => {
    initial = status().data;
    render(<Host />);
    goto("refs"); goto("preflight"); goto("confirm");
    expect(screen.getByTestId("step-status-refs").textContent).toBe("Not complete");
    expect(screen.getByTestId("step-status-confirm").textContent).toBe("Not complete");
    expect(screen.getByTestId("step-status-scope").textContent).toBe("Complete");
    fillAccount();
    expect(screen.getByTestId("step-status-refs").textContent).toBe("Complete");
    tick();
    expect(screen.getByTestId("step-status-confirm").textContent).toBe("Not complete"); // a tick is not completion: only the Sale is
  });
  it("hidden steps stay mounted: the Cin7 list read happens once at mount and never on navigation", async () => {
    initial = status().data;
    render(<Host />);
    await waitFor(() => expect(c7.getCin7ReferenceOptionsAction).toHaveBeenCalledTimes(1));
    goto("confirm"); goto("scope"); goto("refs");
    expect(c7.getCin7ReferenceOptionsAction).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Revenue account code")).toBeTruthy();
  });
});

describe("navigation performs NO action call", () => {
  it("Next, Back, rail clicks, Next incomplete step and Show all steps call none of the actions", async () => {
    initial = status({ scopeItems: [item], blockers: [item] }).data;
    render(<Host />);
    await waitFor(() => expect(c7.getCin7ReferenceOptionsAction).toHaveBeenCalledTimes(1));
    const before = callsToActions();
    for (let i = 0; i < 3; i++) fireEvent.click(nextBtn()!);
    expect(current()).toBe("confirm");
    fireEvent.click(screen.getByRole("button", { name: "Back" })); expect(current()).toBe("preflight");
    goto("scope"); goto("confirm"); goto("refs");
    fireEvent.click(screen.getByRole("button", { name: "Next incomplete step" }));
    fireEvent.click(screen.getByLabelText("Show all steps")); fireEvent.click(screen.getByLabelText("Show all steps"));
    expect(callsToActions()).toEqual(before);
    expect(before).toEqual([0, 0, 0, 0, 0, 0]);
    expect(c7.getCin7ReferenceOptionsAction).toHaveBeenCalledTimes(1);
  });
  it("Next never needs completion, Back is absent on step 1 and Next is absent on the last step", () => {
    render(<Host />);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    fireEvent.click(nextBtn()!); // scope has a blocker, refs empty: still moves
    expect(current()).toBe("refs");
    goto("confirm");
    expect(nextBtn()).toBeNull();
    expect(createBtn()).toBeTruthy();
  });
  it("Show all steps reveals every step, hides Back/Next, and is remembered (separate key)", () => {
    render(<Host />);
    fireEvent.click(screen.getByLabelText("Show all steps"));
    for (const id of ["scope", "refs", "preflight", "confirm"]) expect(panelOf(id).hasAttribute("hidden")).toBe(false);
    expect(screen.queryByTestId("sale-step-nav")).toBeNull();
    expect(window.localStorage.getItem("nq-sale-show-all")).toBe("1");
    expect(window.localStorage.getItem("nq-builder-show-all")).toBeNull();
  });
  it("Show all steps still works when storage throws", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    render(<Host />);
    expect((screen.getByLabelText("Show all steps") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByLabelText("Show all steps"));
    expect(panelOf("confirm").hasAttribute("hidden")).toBe(false);
  });
});

describe("Create is invoked only by the final button, only when every existing gate passes", () => {
  const ready = () => { initial = status().data; render(<Host />); fillAccount(); goto("confirm"); };
  it("not ready: the button is disabled, the exact reason sentence is kept with aria-describedby, and the checklist shows what is outstanding", () => {
    ready();
    expect(createBtn().disabled).toBe(true);
    const why = document.getElementById(createBtn().getAttribute("aria-describedby")!)!;
    expect(why.textContent).toBe("Create is disabled: Tick the confirmation above.");
    const reqs = Array.from(screen.getByTestId("sale-requirements").querySelectorAll("li")).map((l) => [l.textContent, l.getAttribute("data-met")]);
    expect(reqs).toEqual([["✓ Scope resolved: done", "true"], ["✓ Cin7 references entered: done", "true"], ["○ Confirmation ticked: still to do", "false"]]);
    fireEvent.click(createBtn());
    expect(c7.createCin7SaleAction).not.toHaveBeenCalled();
  });
  it("scope blockers keep Create disabled with today's sentence, whatever the navigation", () => {
    initial = status({ scopeItems: [item], blockers: [item] }).data;
    render(<Host />); fillAccount(); goto("confirm"); tick();
    expect(createBtn().disabled).toBe(true);
    expect(document.getElementById(createBtn().getAttribute("aria-describedby")!)!.textContent).toBe("Create is disabled: A scope item is not resolved yet (see above).");
    fireEvent.click(createBtn());
    expect(c7.createCin7SaleAction).not.toHaveBeenCalled();
  });
  it("ready: one click calls createCin7SaleAction once with the typed references and the confirmation token", async () => {
    vi.mocked(c7.createCin7SaleAction).mockResolvedValue({ ok: true, data: { state: "CREATED", message: "ok", saleNumber: "SO-1", linked: false } } as never);
    ready(); tick();
    expect(createBtn().disabled).toBe(false);
    expect(createBtn().hasAttribute("aria-describedby")).toBe(false);
    expect(c7.createCin7SaleAction).not.toHaveBeenCalled(); // reaching the last step and ticking never calls it
    await act(async () => { fireEvent.click(createBtn()); });
    expect(c7.createCin7SaleAction).toHaveBeenCalledTimes(1);
    expect(vi.mocked(c7.createCin7SaleAction).mock.calls[0][1]).toMatchObject({ customerName: "Spark", location: "MSTR", revenueAccount: "200", cin7TaxRule: "Standard Rate Sales" });
  });
  it("a double-click creates exactly once (existing duplicate protection)", async () => {
    const d = deferred<ActionOutcome>();
    vi.mocked(c7.createCin7SaleAction).mockReturnValue(d.promise as never);
    ready(); tick();
    act(() => { fireEvent.click(createBtn()); fireEvent.click(createBtn()); });
    expect(c7.createCin7SaleAction).toHaveBeenCalledTimes(1);
    await act(async () => d.resolve({ ok: true, data: { message: "ok" } }));
  });
  it("a lost response leaves Create blocked (status re-read failed) with today's alert", async () => {
    vi.mocked(c7.createCin7SaleAction).mockRejectedValue(new Error("network"));
    vi.mocked(c7.getCin7SaleCreationStatusAction).mockResolvedValue({ ok: false, error: "offline" } as never);
    ready(); tick();
    await act(async () => { fireEvent.click(createBtn()); });
    await screen.findByText(/could not be re-read\. Reload the page/);
    expect((screen.getByLabelText(/I confirm I want to create one Cin7 Sales Order/) as HTMLInputElement).checked).toBe(false);
    expect(createBtn().disabled).toBe(true);
    expect(document.getElementById(createBtn().getAttribute("aria-describedby")!)!.textContent).toBe("Create is disabled: The Cin7 status is being re-read. Tick the confirmation above.");
    expect(c7.createCin7SaleAction).toHaveBeenCalledTimes(1);
  });
});

describe("role and state cases keep today's messaging", () => {
  it("non-manager: only the manager sentence, no requirement checklist, nothing callable", () => {
    initial = status({ gates: { ...gates, isManager: false } }).data;
    render(<Host />); goto("confirm");
    expect(createBtn().disabled).toBe(true);
    expect(document.getElementById(createBtn().getAttribute("aria-describedby")!)!.textContent).toBe("Create is disabled: Only a manager can create the Cin7 Sales Order.");
    expect(screen.queryByTestId("sale-requirements")).toBeNull();
    fireEvent.click(createBtn());
    expect(c7.createCin7SaleAction).not.toHaveBeenCalled();
  });
  it("non-manager with blockers still sees the manager notice per item and the preflight button disabled", () => {
    initial = status({ gates: { ...gates, isManager: false }, scopeItems: [item], blockers: [item] }).data;
    render(<Host />);
    expect(screen.getAllByText("A manager resolves this.").length).toBe(2);
    goto("preflight");
    expect((screen.getByRole("button", { name: /Run P0 checklist/ }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("writes off: today's reason is kept and Create stays disabled", () => {
    initial = status({ gates: { ...gates, writesEnabled: false } }).data;
    render(<Host />); fillAccount(); goto("confirm"); tick();
    expect(screen.getByText("Cin7 writes OFF")).toBeTruthy();
    expect(createBtn().disabled).toBe(true);
    expect(document.getElementById(createBtn().getAttribute("aria-describedby")!)!.textContent).toBe("Create is disabled: Cin7 writes are switched off for this organisation.");
    fireEvent.click(createBtn());
    expect(c7.createCin7SaleAction).not.toHaveBeenCalled();
  });
  it("already linked (no creation record): the panel renders nothing, as today", () => {
    initial = status({ linked: true }).data;
    const { container } = render(<Host />);
    expect(container.innerHTML).toBe("");
  });
  it("uncertain outcome: starts on the last step, shows the record, reconcile and the do-not-retry copy; no Create button; form steps unavailable", async () => {
    const creation = { id: "cr1", creation_state: "FAILED_UNCERTAIN", cin7_sale_number: null, last_error_message: "Response lost", last_error_code: "X" };
    initial = status({ creation }).data;
    render(<Host />);
    expect(current()).toBe("confirm");
    expect(screen.getByText(/Do not retry\. Reconcile first/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create Sales Order in Cin7" })).toBeNull();
    expect(screen.getByTestId("step-status-confirm").textContent).toBe("Needs attention");
    expect(screen.getByTestId("step-status-refs").textContent).toBe("Not available");
    vi.mocked(c7.reconcileCin7SaleCreationAction).mockResolvedValue({ ok: true, data: { message: "Reconciled" } } as never);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Reconcile with Cin7/ })); });
    expect(c7.reconcileCin7SaleCreationAction).toHaveBeenCalledTimes(1);
    expect(c7.createCin7SaleAction).not.toHaveBeenCalled();
  });
});

describe("step 1 is a database write (not a Cin7 write): resolveScopeItemAction only from its own buttons", () => {
  it("Exclude is disabled without a reason, then calls resolveScopeItemAction exactly once with the reason", async () => {
    vi.mocked(c7.resolveScopeItemAction).mockResolvedValue({ ok: true, data: [] } as never);
    render(<Host />);
    const exclude = screen.getByRole("button", { name: "Exclude from the Sale" }) as HTMLButtonElement;
    expect(exclude.disabled).toBe(true);
    fireEvent.change(screen.getAllByLabelText("Reason (required)")[0], { target: { value: "Not supplied" } });
    await act(async () => { fireEvent.click(exclude); });
    expect(c7.resolveScopeItemAction).toHaveBeenCalledTimes(1);
    expect(c7.resolveScopeItemAction).toHaveBeenCalledWith("p1", { itemId: "i1", kind: "EXCLUDE", reason: "Not supplied" });
    expect(c7.createCin7SaleAction).not.toHaveBeenCalled();
  });
});

describe("preflight (existing, read-only) and unsaved work", () => {
  it("running the check is the only thing that calls runP0ChecklistAction; its result sets the step, and changing a reference makes it stale", async () => {
    initial = status().data;
    vi.mocked(c7.runP0ChecklistAction).mockResolvedValue({ ok: true, data: { verdict: "READY_PENDING_MANUAL", counts: { PASS: 3, MANUAL: 1, FAIL: 0, NOT_RUN: 0 }, checks: [] } } as never);
    render(<Host />); fillAccount(); goto("preflight");
    expect(c7.runP0ChecklistAction).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Run P0 checklist/ })); });
    expect(c7.runP0ChecklistAction).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("step-status-preflight").textContent).toBe("Complete");
    fireEvent.change(screen.getByLabelText("Revenue account code"), { target: { value: "300" } });
    expect(screen.getByTestId("step-status-preflight").textContent).toBe("Not complete");
  });
  const unloadPrevented = () => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; };
  it("guards typed-but-uncreated references and unsaved per-item reasons; untouched is not dirty", () => {
    initial = status({ scopeItems: [item], blockers: [item] }).data;
    const { unmount } = render(<Host />);
    expect(unloadPrevented()).toBe(false);
    fireEvent.change(screen.getAllByLabelText("Reason (required)")[0], { target: { value: "x" } });
    expect(unloadPrevented()).toBe(true);
    fireEvent.change(screen.getAllByLabelText("Reason (required)")[0], { target: { value: "" } });
    expect(unloadPrevented()).toBe(false);
    fireEvent.change(screen.getByLabelText("Cin7 customer name (must already exist)"), { target: { value: "Other" } });
    expect(unloadPrevented()).toBe(true);
    unmount();
    expect(unloadPrevented()).toBe(false);
  });
  it("a record that already exists is never dirty", () => {
    initial = status({ creation: { id: "c", creation_state: "CREATED", cin7_sale_number: "SO-1", last_error_message: null } }).data;
    render(<Host />);
    expect(unloadPrevented()).toBe(false);
  });
});
