// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const select = vi.fn(); const exit = vi.fn();
vi.mock("../demo-mode/actions", () => ({ selectDemoIdentityAction: (...a: unknown[]) => select(...a), exitDemoModeAction: (...a: unknown[]) => exit(...a) }));
import { DemoModeControls } from "../DemoModeControls";

const Q26 = "/newquip-grower/aaaaaaaa-0000-4000-8000-000000000026", Q27 = "/newquip-grower/bbbbbbbb-0000-4000-8000-000000000027";
const state = { visible: true, selectable: true, active: null, reason: null };
const replace = vi.fn(); const assign = vi.fn();
const at = (path: string) => { Object.defineProperty(window, "location", { configurable: true, value: { pathname: path, search: "?stage=2&step=4", hash: "", replace, assign, reload: vi.fn() } }); };

beforeEach(() => { select.mockReset().mockResolvedValue({ ok: true }); replace.mockReset(); assign.mockReset(); });
afterEach(cleanup);

describe("Presenter role bar never leaves the quotation being presented", () => {
  it.each([["Rep", "rep"], ["Estimator", "estimator"], ["Manager", "manager"], ["Owner (you)", "owner"]])("switching to %s reloads the CURRENT path and nothing else", async (label, slot) => {
    for (const path of [Q27, Q26, Q27]) {
      at(path); replace.mockReset(); select.mockClear();
      render(createElement(DemoModeControls, { state }));
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(select).toHaveBeenCalledWith(slot));
      await waitFor(() => expect(replace).toHaveBeenCalledWith(path)); // the exact quotation, no query, no other id
      expect(assign).not.toHaveBeenCalled();
      cleanup();
    }
  });
  it("a refused switch navigates nowhere and says why", async () => {
    at(Q27); select.mockResolvedValue({ ok: false, error: "Demo Mode is switched off." });
    render(createElement(DemoModeControls, { state }));
    fireEvent.click(screen.getByRole("button", { name: "Manager" }));
    expect(await screen.findByText(/switched off/)).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });
});
