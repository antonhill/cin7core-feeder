// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let path = "/newquip-grower/a"; let search = "";
vi.mock("next/navigation", () => ({ usePathname: () => path, useSearchParams: () => new URLSearchParams(search) }));
import { NavigationProgress } from "../NavigationProgress";
import { announceNavigation } from "../navigation-events";

const link = (href: string, extra: Record<string, string> = {}) => { const a = document.createElement("a"); a.href = href; for (const [k, v] of Object.entries(extra)) a.setAttribute(k, v); a.textContent = "go"; document.body.appendChild(a); return a; };
const active = () => screen.getByTestId("navigation-progress").getAttribute("data-active");

beforeEach(() => { vi.useFakeTimers(); path = "/newquip-grower/a"; search = ""; window.history.pushState({}, "", "/newquip-grower/a"); });
afterEach(() => { cleanup(); document.querySelectorAll("a").forEach((a) => a.remove()); vi.useRealTimers(); });

describe("global navigation feedback", () => {
  it("shows at once when an internal link is clicked, before any navigation completes", () => {
    render(createElement(NavigationProgress));
    expect(active()).toBe("false");
    act(() => { fireEvent.click(link("/projects/p1")); });
    expect(active()).toBe("true");
  });
  it("ignores external, new-tab, modified and same-location links", () => {
    render(createElement(NavigationProgress));
    for (const a of [link("https://example.com/x"), link("/projects/p1", { target: "_blank" }), link("/newquip-grower/a")]) { act(() => { fireEvent.click(a); }); expect(active()).toBe("false"); }
    act(() => { fireEvent.click(link("/projects/p1"), { metaKey: true }); });
    expect(active()).toBe("false");
  });
  it("clears when the location changes", () => {
    const { rerender } = render(createElement(NavigationProgress));
    act(() => { fireEvent.click(link("/projects/p1")); });
    path = "/projects/p1"; rerender(createElement(NavigationProgress));
    expect(active()).toBe("false");
  });
  it("shows for a programmatic navigation and cannot stick forever", () => {
    render(createElement(NavigationProgress));
    act(() => { announceNavigation(); });
    expect(active()).toBe("true");
    act(() => { vi.advanceTimersByTime(15500); });
    expect(active()).toBe("false");
  });
  it("is an announced status, with no invented percentage", () => {
    render(createElement(NavigationProgress));
    act(() => { announceNavigation(); });
    expect(screen.getByRole("status").textContent).toMatch(/Loading the next page/);
    expect(document.body.textContent).not.toMatch(/\d+\s?%/);
  });
});
