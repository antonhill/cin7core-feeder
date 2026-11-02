// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
