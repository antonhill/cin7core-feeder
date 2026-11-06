// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import Link from "next/link";
import { useUnsavedGuard } from "../use-unsaved-guard";

function Host({ dirty, second }: { dirty: boolean; second?: boolean }) {
  useUnsavedGuard(dirty);
  useUnsavedGuard(second ?? false);
  return <div><a href="/somewhere">Leave</a><Link href="/next-link">Real link</Link><a href="#top">Jump</a><a href="/x" target="_blank">New tab</a></div>;
}
const unload = () => { const e = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(e); return e; };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("useUnsavedGuard", () => {
  it("dirty: tab close is guarded", () => {
    render(<Host dirty />);
    expect(unload().defaultPrevented).toBe(true);
  });
  it("clean: tab close is not guarded and links are not intercepted", () => {
    const confirm = vi.spyOn(window, "confirm");
    const { getByText } = render(<Host dirty={false} />);
    expect(unload().defaultPrevented).toBe(false);
    const sink = (e: Event) => e.preventDefault();
    document.addEventListener("click", sink);
    fireEvent.click(getByText("Leave"));
    document.removeEventListener("click", sink);
    expect(confirm).not.toHaveBeenCalled();
  });
  it("saved/cancelled (dirty -> clean) releases the guard", () => {
    const { rerender } = render(<Host dirty />);
    rerender(<Host dirty={false} />);
    expect(unload().defaultPrevented).toBe(false);
  });
  it("unmount removes the listeners", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<Host dirty />);
    unmount();
    expect(remove).toHaveBeenCalledWith("beforeunload", expect.any(Function));
    expect(unload().defaultPrevented).toBe(false);
  });
  it("dirty: an in-app link click asks first; declining stops it, accepting lets it through", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { getByText } = render(<Host dirty />);
    let reached = 0; // stands in for the router: it only sees clicks the guard let through
    const sink = (e: Event) => { reached++; e.preventDefault(); }; // also stops jsdom attempting a real navigation
    document.addEventListener("click", sink);
    fireEvent.click(getByText("Leave"));
    expect(reached).toBe(0);
    fireEvent.click(getByText("Leave"));
    expect(reached).toBe(1);
    document.removeEventListener("click", sink);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
  it("hash and new-tab links are never interrupted", () => {
    const confirm = vi.spyOn(window, "confirm");
    const { getByText } = render(<Host dirty />);
    const sink = (e: Event) => e.preventDefault();
    document.addEventListener("click", sink);
    fireEvent.click(getByText("Jump")); fireEvent.click(getByText("New tab"));
    document.removeEventListener("click", sink);
    expect(confirm).not.toHaveBeenCalled();
  });
  it("unmount removes the click listener too", () => {
    const remove = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(<Host dirty />);
    unmount();
    expect(remove).toHaveBeenCalledWith("click", expect.any(Function), true);
  });
  it("a real next/link Link click while dirty asks first and is blocked when declined", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { getByText } = render(<Host dirty />);
    let reached = 0;
    const sink = (e: Event) => { reached++; e.preventDefault(); };
    document.addEventListener("click", sink);
    fireEvent.click(getByText("Real link"));
    document.removeEventListener("click", sink);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(reached).toBe(0);
  });
  it("two dirty guards on one page prompt ONCE; accepting lets the click through, declining blocks it once", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(true).mockReturnValueOnce(false);
    const { getByText } = render(<Host dirty second />);
    let reached = 0;
    const sink = (e: Event) => { reached++; e.preventDefault(); };
    document.addEventListener("click", sink);
    fireEvent.click(getByText("Leave"));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(reached).toBe(1);
    fireEvent.click(getByText("Leave"));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(reached).toBe(1); // declined: blocked
    document.removeEventListener("click", sink);
  });
  it("one guard releasing while another stays dirty keeps the page guarded", () => {
    const { rerender } = render(<Host dirty second />);
    rerender(<Host dirty={false} second />);
    expect(unload().defaultPrevented).toBe(true);
    rerender(<Host dirty={false} second={false} />);
    expect(unload().defaultPrevented).toBe(false);
  });

  describe("Back/Forward via the Navigation API (Chromium only)", () => {
    type H = (e: { navigationType: string; cancelable: boolean; hashChange: boolean; preventDefault(): void }) => void;
    let handlers: Set<H>;
    beforeEach(() => {
      handlers = new Set();
      (window as unknown as { navigation: unknown }).navigation = { addEventListener: (_t: string, h: H) => handlers.add(h), removeEventListener: (_t: string, h: H) => handlers.delete(h) };
    });
    afterEach(() => { delete (window as unknown as { navigation?: unknown }).navigation; });
    const fire = (navigationType: string, o: { cancelable?: boolean; hashChange?: boolean } = {}) => {
      const e = { navigationType, cancelable: o.cancelable ?? true, hashChange: o.hashChange ?? false, prevented: false, preventDefault() { this.prevented = true; } };
      handlers.forEach((h) => h(e));
      return e;
    };
    it("dirty: a declined Back is cancelled, an accepted one is let through", () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
      render(<Host dirty />);
      expect(fire("traverse").prevented).toBe(true);
      expect(fire("traverse").prevented).toBe(false);
      expect(confirm).toHaveBeenCalledTimes(2);
    });
    it("push, replace and reload are NEVER cancelled or prompted here (cancelling a router push desyncs the App Router URL from the screen)", () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      render(<Host dirty />);
      for (const t of ["push", "replace", "reload"]) expect(fire(t).prevented).toBe(false);
      expect(confirm).not.toHaveBeenCalled();
    });
    it("a traversal the browser says is not cancelable, or a hash-only one, is left alone with no prompt", () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
      render(<Host dirty />);
      expect(fire("traverse", { cancelable: false }).prevented).toBe(false);
      expect(fire("traverse", { hashChange: true }).prevented).toBe(false);
      expect(confirm).not.toHaveBeenCalled();
    });
    it("clean: no listener at all; and it is removed on save and on unmount", () => {
      const { rerender, unmount } = render(<Host dirty={false} />);
      expect(handlers.size).toBe(0);
      rerender(<Host dirty />);
      expect(handlers.size).toBe(1);
      rerender(<Host dirty={false} />);
      expect(handlers.size).toBe(0);
      rerender(<Host dirty />);
      unmount();
      expect(handlers.size).toBe(0);
    });
    it("two dirty guards share ONE navigate listener and ONE prompt", () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      render(<Host dirty second />);
      expect(handlers.size).toBe(1);
      fire("traverse");
      expect(confirm).toHaveBeenCalledTimes(1);
    });
  });
  it("without a Navigation API (Firefox/Safari today) the other layers still work and nothing throws", () => {
    expect((window as unknown as { navigation?: unknown }).navigation).toBeUndefined();
    const { unmount } = render(<Host dirty />);
    expect(unload().defaultPrevented).toBe(true);
    unmount();
  });
});
