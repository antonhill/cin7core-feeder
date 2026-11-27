// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ToolboxAccessRow, ModuleAuditList, GRANTABLE_TOOLBOX_MODULES } from "../ToolboxAccess";

afterEach(cleanup);
const member = (allowedModules: string[] | null) => ({ userId: "u1", email: "shirnel@newquip.co.za", role: "member", allowedModules });

describe("ToolboxAccessRow", () => {
  it("shows NewQuip workspace only by default and offers no NewQuip-own module as a switch", () => {
    render(<ToolboxAccessRow member={member(null)} isSelf={false} isBusy={false} onSave={() => {}} />);
    expect(screen.getByTestId("toolbox-effective").textContent).toBe("NewQuip workspace only");
    expect(GRANTABLE_TOOLBOX_MODULES.map((m) => m.href)).not.toContain("/projects");
    expect(screen.queryByText(/Full access/)).toBeNull();
  });
  it("shows the effective access and saves exactly the toggled modules", () => {
    const onSave = vi.fn();
    render(<ToolboxAccessRow member={member(["/quotes"])} isSelf={false} isBusy={false} onSave={onSave} />);
    expect(screen.getByTestId("toolbox-effective").textContent).toBe("NewQuip workspace + Toolbox: Quotes");
    const save = screen.getByRole("button", { name: "Save Toolbox access" });
    expect((save as HTMLButtonElement).disabled).toBe(true); // nothing changed
    fireEvent.click(screen.getByLabelText("Quotes")); // switch Quotes off
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith("u1", []);
  });
  it("an administrator's own row is read-only with an explanation", () => {
    render(<ToolboxAccessRow member={member([])} isSelf isBusy={false} onSave={() => {}} />);
    expect(screen.getByTestId("toolbox-self-note")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save Toolbox access" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ModuleAuditList", () => {
  it("shows who changed whose access, from what to what", () => {
    render(<ModuleAuditList entries={[{ id: "1", targetEmail: "shirnel@newquip.co.za", actorEmail: "admin@newquip.co.za", previousModules: null, newModules: ["/quotes"], changedAt: "2026-11-27T08:00:00Z" }]} />);
    const t = screen.getByTestId("module-audit").textContent ?? "";
    expect(t).toContain("shirnel@newquip.co.za");
    expect(t).toContain("none → Quotes");
    expect(t).toContain("admin@newquip.co.za");
  });
});
