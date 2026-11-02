// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProjectDetailsPanel } from "../ProjectDetailsPanel";
import { ProjectFeedbackProvider } from "../feedback-context";
import { useKeyedActions } from "@/components/ui/action-feedback";
import * as actions from "../../actions";
import type { ProjectView } from "@/lib/projects/project-view";

vi.mock("../../actions", () => ({ listProjectManagerOptionsAction: vi.fn(), updateProjectDetailsAction: vi.fn() }));

const view = (over: Record<string, unknown> = {}) => ({ project: { id: "p1", customer_name: "Spark", project_reference: "PRJ-X", originating_quote_ref: "NQ-Q-1", salesperson: null, project_manager: null, start_date: null, target_completion_date: null, status: "ACTIVE", tax_rule: "Standard", tax_rate_bps: 1500, ...over } }) as unknown as ProjectView;

// mimics the workspace run(): the action runs, its result is reported beside the control that ran it
function Host({ v, isAdmin = true, editable = true, onSaved }: { v: ProjectView; isAdmin?: boolean; editable?: boolean; onSaved?: () => void }) {
  const acts = useKeyedActions();
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, done?: string, key = "page") => {
    const ok = await acts.run(key, async () => fn(), { success: () => done ?? "Done." });
    if (ok) onSaved?.();
    return ok;
  };
  return <ProjectFeedbackProvider value={acts.stateOf}><ProjectDetailsPanel view={v} isAdmin={isAdmin} run={run as never} working={acts.anyPending} editable={editable} /></ProjectFeedbackProvider>;
}

beforeEach(() => {
  vi.mocked(actions.listProjectManagerOptionsAction).mockResolvedValue({ ok: true, data: ["boss@x.co.za", "pm@x.co.za"] } as never);
  vi.mocked(actions.updateProjectDetailsAction).mockResolvedValue({ ok: true, data: null } as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Project details (UAT-029)", () => {
  it("blank values read 'Not set', and an administrator sees the Edit action", () => {
    render(<Host v={view()} />);
    expect(screen.getAllByText("Not set").length).toBe(3);
    expect(screen.getByRole("button", { name: "Edit details" })).toBeTruthy();
  });
  it("a non-administrator cannot edit: no Edit action and no user list is requested", () => {
    render(<Host v={view()} isAdmin={false} />);
    expect(screen.queryByRole("button", { name: "Edit details" })).toBeNull();
    expect(actions.listProjectManagerOptionsAction).not.toHaveBeenCalled();
  });
  it("a variation's internal billing project offers no edit (its details belong to the original project)", () => {
    render(<Host v={view()} editable={false} />);
    expect(screen.queryByRole("button", { name: "Edit details" })).toBeNull();
  });
  it("Edit opens a form prefilled with the current values; Save sends them and reports beside the button", async () => {
    const saved = vi.fn();
    render(<Host v={view({ project_manager: "boss@x.co.za", start_date: "2026-11-02" })} onSaved={saved} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit details" }));
    const mgr = (await screen.findByLabelText("Project manager")) as HTMLSelectElement;
    await waitFor(() => expect(Array.from(mgr.options).map((o) => o.value)).toEqual(["", "boss@x.co.za", "pm@x.co.za"]));
    expect(mgr.value).toBe("boss@x.co.za");
    expect((screen.getByLabelText("Start date") as HTMLInputElement).value).toBe("2026-11-02");
    fireEvent.change(mgr, { target: { value: "pm@x.co.za" } });
    fireEvent.change(screen.getByLabelText("Target completion"), { target: { value: "2027-03-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(actions.updateProjectDetailsAction).toHaveBeenCalledWith("p1", { projectManager: "pm@x.co.za", startDate: "2026-11-02", targetCompletionDate: "2027-03-01" });
    expect(await screen.findByText("Project details saved.")).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Edit project details" })).toBeNull(); // closed after a successful save
  });
  it("a server refusal is shown beside the form and the entered values are kept", async () => {
    vi.mocked(actions.updateProjectDetailsAction).mockResolvedValue({ ok: false, error: "The project manager must be a user of this organisation." } as never);
    render(<Host v={view()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit details" }));
    await screen.findByLabelText("Project manager");
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-11-05" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    expect(await screen.findByText(/must be a user of this organisation/)).toBeTruthy();
    expect((screen.getByLabelText("Start date") as HTMLInputElement).value).toBe("2026-11-05");
    expect(screen.getByRole("button", { name: "Save details" })).toBeTruthy();
  });
  it("a target before the start is flagged at once and Save is disabled", async () => {
    render(<Host v={view({ start_date: "2026-11-10" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit details" }));
    await screen.findByLabelText("Project manager");
    fireEvent.change(screen.getByLabelText("Target completion"), { target: { value: "2026-11-01" } });
    expect(screen.getByText("Cannot be before the start date.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save details" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("a manager already on the record who is not in the list is still selectable (saving other fields never drops them)", async () => {
    vi.mocked(actions.listProjectManagerOptionsAction).mockResolvedValue({ ok: false, error: "offline" } as never);
    render(<Host v={view({ project_manager: "gone@x.co.za" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit details" }));
    const mgr = (await screen.findByLabelText("Project manager")) as HTMLSelectElement;
    expect(mgr.value).toBe("gone@x.co.za");
    expect(await screen.findByText("offline")).toBeTruthy();
  });
});
