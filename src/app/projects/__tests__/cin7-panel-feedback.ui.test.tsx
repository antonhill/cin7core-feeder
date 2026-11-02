// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Cin7SaleCreationPanel } from "../[id]/Cin7SaleCreationPanel";
import { ProjectFeedbackProvider } from "../[id]/feedback-context";
import { useKeyedActions, type ActionOutcome } from "@/components/ui/action-feedback";
import * as c7 from "../cin7-actions";
import type { ProjectView } from "@/lib/projects/project-view";

// UAT-025: "Create Sales Order in Cin7" and "Reconcile with Cin7" report beside their own button. The host mimics the Project workspace's run().

vi.mock("../cin7-actions", () => ({
  getCin7ReferenceOptionsAction: vi.fn(), createCin7SaleAction: vi.fn(), getPackageMappingAction: vi.fn(), getCin7SaleCreationStatusAction: vi.fn(),
  reconcileCin7SaleCreationAction: vi.fn(), resolveScopeItemAction: vi.fn(), runP0ChecklistAction: vi.fn(),
}));
vi.mock("../[id]/VariationProductPicker", () => ({ VariationProductPicker: () => null }));

const view = { project: { id: "p1", customer_name: "Spark", originating_quote_ref: "NQ-Q-0017" }, stages: [{ id: "s1", name: "Variation", valueCents: 50_000_000 }] } as unknown as ProjectView;
const creation = { id: "cr1", creation_state: "CREATED", cin7_sale_number: "SO-00028", last_error_message: "The Sale was created but does not read back as planned; it was NOT linked.", last_error_code: "VERIFICATION_FAILED" };
const status = (over: Record<string, unknown> = {}) => ({ ok: true, data: { gates: { orgEnabled: true, isManager: true, writesEnabled: true }, creation, linked: false, scopeItems: [], saleLines: [], blockers: [], excluded: [], ...over } });

function Host() {
  const acts = useKeyedActions();
  const run = (fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>, done?: string, key = "page", opts?: { success?: (v: unknown, r: { data?: unknown }) => string }) =>
    acts.run(key, async () => ({ ...(await fn()) }), { success: (r) => (opts?.success ? opts.success(null, r) : done ?? "Done.") });
  return <ProjectFeedbackProvider value={acts.stateOf}><Cin7SaleCreationPanel view={view} run={run} working={acts.anyPending} /></ProjectFeedbackProvider>;
}
const reconcileBtn = () => screen.getByRole("button", { name: /Reconcile with Cin7/ }) as HTMLButtonElement;
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

beforeEach(() => {
  vi.mocked(c7.getCin7SaleCreationStatusAction).mockResolvedValue(status() as never);
  vi.mocked(c7.getCin7ReferenceOptionsAction).mockResolvedValue({ ok: false, error: "n/a" } as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Cin7 Sale creation panel", () => {
  it("Reconcile: in progress, then the server's own outcome message, both inside the same block as the button", async () => {
    const d = deferred<ActionOutcome>();
    vi.mocked(c7.reconcileCin7SaleCreationAction).mockReturnValue(d.promise as never);
    render(<Host />);
    await screen.findByText(/Cin7 SO-00028/);
    fireEvent.click(reconcileBtn());
    const block = reconcileBtn().closest("div.space-y-2") as HTMLElement;
    const pending = await screen.findByText(/Working/);
    expect(block.contains(pending)).toBe(true);
    expect(reconcileBtn().disabled).toBe(true);
    await act(async () => d.resolve({ ok: true, data: { message: "Reconciled: SO-00028 matches the plan and is now linked." } }));
    const ok = await screen.findByText(/Reconciled: SO-00028 matches the plan/);
    expect(block.contains(ok)).toBe(true);
    expect(ok.closest("[role=status]")).not.toBeNull();
  });

  it("Reconcile refused: a visible alert next to the button naming the reason; the button is usable again", async () => {
    vi.mocked(c7.reconcileCin7SaleCreationAction).mockResolvedValue({ ok: false, error: "Pick has an unexpected field \"Foo\"" } as never);
    render(<Host />);
    await screen.findByText(/Cin7 SO-00028/);
    fireEvent.click(reconcileBtn());
    const alert = await waitFor(() => { const e = document.querySelector('[data-testid="action-feedback"][data-kind="error"]') as HTMLElement; expect(e).not.toBeNull(); return e; });
    expect((reconcileBtn().closest("div.space-y-2") as HTMLElement).contains(alert)).toBe(true);
    expect(alert.textContent).toContain('Pick has an unexpected field "Foo"');
    expect(reconcileBtn().disabled).toBe(false);
  });

  it("Reconcile cannot be fired twice by a double-click", async () => {
    const d = deferred<ActionOutcome>();
    vi.mocked(c7.reconcileCin7SaleCreationAction).mockReturnValue(d.promise as never);
    render(<Host />);
    await screen.findByText(/Cin7 SO-00028/);
    act(() => { fireEvent.click(reconcileBtn()); fireEvent.click(reconcileBtn()); });
    expect(c7.reconcileCin7SaleCreationAction).toHaveBeenCalledTimes(1);
    await act(async () => d.resolve({ ok: true, data: { message: "ok" } }));
  });
});
