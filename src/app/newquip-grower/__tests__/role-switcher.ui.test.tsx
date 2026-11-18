// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const switchRole = vi.fn();
vi.mock("@/app/approvals/role-actions", () => ({ switchActiveRoleAction: (...a: unknown[]) => switchRole(...a) }));
import { RoleSwitcher } from "../RoleSwitcher";

const reload = vi.fn();
beforeEach(() => { switchRole.mockReset().mockResolvedValue({ ok: true }); reload.mockReset(); Object.defineProperty(window, "location", { configurable: true, value: { reload } }); });
afterEach(cleanup);

describe("RoleSwitcher", () => {
  it("shows the active role prominently, a three-way toggle with the active one selected, and a hint that cost is hidden in Rep mode", () => {
    render(createElement(RoleSwitcher, { held: ["REP", "ESTIMATOR", "MANAGER"], active: "REP" }));
    expect(screen.getByTestId("active-role").textContent).toBe("Rep");
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "Rep" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Manager" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("role-hint").textContent).toMatch(/costs, margins and markups are hidden/);
  });
  it("asks the server to switch and then fully reloads, so nothing from the previous role stays on screen", async () => {
    render(createElement(RoleSwitcher, { held: ["REP", "ESTIMATOR", "MANAGER"], active: "REP" }));
    fireEvent.click(screen.getByRole("radio", { name: "Estimator" }));
    await waitFor(() => expect(switchRole).toHaveBeenCalledWith("ESTIMATOR"));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });
  it("clicking the active role does nothing; a refusal is shown and nothing reloads", async () => {
    render(createElement(RoleSwitcher, { held: ["REP", "MANAGER"], active: "REP" }));
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    fireEvent.click(screen.getByRole("radio", { name: "Rep" }));
    expect(switchRole).not.toHaveBeenCalled();
    switchRole.mockResolvedValue({ ok: false, error: "You do not hold the Manager role." });
    fireEvent.click(screen.getByRole("radio", { name: "Manager" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/do not hold/));
    expect(reload).not.toHaveBeenCalled();
  });
});
