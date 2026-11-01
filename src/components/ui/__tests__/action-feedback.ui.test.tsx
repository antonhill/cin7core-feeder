// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ActionFeedback, AMBIGUOUS_NOT_DONE, AMBIGUOUS_UNKNOWN, useKeyedActions, type ActionOutcome, type Reconciled } from "../action-feedback";

afterEach(() => cleanup());

type Fn = () => Promise<ActionOutcome>;
function Harness({ fn, reconcile, twice = false }: { fn: Fn; reconcile?: () => Promise<Reconciled>; twice?: boolean }) {
  const acts = useKeyedActions();
  const go = () => acts.run("k", fn, { pending: "Saving…", success: "Saved.", reconcile });
  return (
    <div>
      {/* `twice` calls run() twice inside ONE event: no re-render happens between the calls, so only a ref guard (not a `disabled` flag in state) can stop the second. */}
      <button onClick={() => { void go(); if (twice) void go(); }} disabled={acts.anyPending}>Go</button>
      <ActionFeedback state={acts.stateOf("k")} />
    </div>
  );
}
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

describe("useKeyedActions / ActionFeedback", () => {
  it("shows a pending status, then the success message, as polite status regions", async () => {
    const d = deferred<ActionOutcome>();
    render(<Harness fn={() => d.promise} />);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    const pending = await screen.findByText("Saving…");
    expect(pending.closest("[role=status]")).not.toBeNull();
    expect((screen.getByRole("button", { name: "Go" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => d.resolve({ ok: true }));
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(screen.getByText("Saved.").closest("[role=status]")?.getAttribute("aria-live")).toBe("polite");
    expect((screen.getByRole("button", { name: "Go" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a failure is an alert that takes focus, with the server's own explanation", async () => {
    render(<Harness fn={async () => ({ ok: false, error: "You do not hold the manager role." })} />);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("You do not hold the manager role.");
    expect(document.activeElement).toBe(alert);
  });

  it("a second call while the first is in flight is ignored, even when it arrives before any re-render", async () => {
    const d = deferred<ActionOutcome>();
    const fn = vi.fn(() => d.promise);
    render(<Harness fn={fn} twice />);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(fn).toHaveBeenCalledTimes(1);
    await act(async () => d.resolve({ ok: true }));
    // once finished, a new attempt is allowed again
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(fn).toHaveBeenCalledTimes(2);
    await act(async () => undefined);
  });

  describe("an ambiguous failure (thrown / lost response) re-reads authoritative state BEFORE any retry is suggested", () => {
    it("recorded after all: reported as done, no retry advice", async () => {
      const order: string[] = [];
      render(<Harness fn={async () => { order.push("action"); throw new Error("network"); }} reconcile={async () => { order.push("reconcile"); return "done"; }} />);
      fireEvent.click(screen.getByRole("button", { name: "Go" }));
      expect((await screen.findByText(/recorded/i)).closest("[role=status]")).not.toBeNull();
      expect(order).toEqual(["action", "reconcile"]);
      expect(screen.queryByText(/try again/i)).toBeNull();
    });
    it("verified not recorded: a retry is suggested only now", async () => {
      render(<Harness fn={async () => { throw new Error("timeout"); }} reconcile={async () => "not_done"} />);
      fireEvent.click(screen.getByRole("button", { name: "Go" }));
      expect((await screen.findByRole("alert")).textContent).toBe(AMBIGUOUS_NOT_DONE);
    });
    it("cannot be verified: told to check the current status, never told to simply retry", async () => {
      render(<Harness fn={async () => { throw new Error("x"); }} reconcile={async () => { throw new Error("read failed"); }} />);
      fireEvent.click(screen.getByRole("button", { name: "Go" }));
      const text = (await screen.findByRole("alert")).textContent ?? "";
      expect(text).toBe(AMBIGUOUS_UNKNOWN);
      expect(text).not.toMatch(/you can try again/i);
    });
    it("the control never stays stuck after a thrown error (the old hang)", async () => {
      render(<Harness fn={async () => { throw new Error("boom"); }} />);
      fireEvent.click(screen.getByRole("button", { name: "Go" }));
      await screen.findByRole("alert");
      await waitFor(() => expect((screen.getByRole("button", { name: "Go" }) as HTMLButtonElement).disabled).toBe(false));
    });
  });

  it("the floating backstop pins the message inside the viewport and keeps its ARIA role", () => {
    render(<ActionFeedback floating state={{ kind: "error", message: "Nope" }} />);
    const el = screen.getByRole("alert");
    expect(el.className).toMatch(/\bfixed\b/);
    expect(el.textContent).toContain("Nope");
  });
});
