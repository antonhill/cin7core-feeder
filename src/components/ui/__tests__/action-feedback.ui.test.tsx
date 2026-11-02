// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ActionFeedback, AMBIGUOUS_NOT_DONE, AMBIGUOUS_NOT_DONE_CIN7, AMBIGUOUS_UNKNOWN, AMBIGUOUS_UNREADABLE, useKeyedActions, type ActionOutcome, type Reconciled } from "../action-feedback";

afterEach(() => cleanup());

type Fn = () => Promise<ActionOutcome>;
function Harness({ fn, reconcile, twice = false, cin7 = false }: { fn: Fn; reconcile?: () => Promise<Reconciled>; twice?: boolean; cin7?: boolean }) {
  const acts = useKeyedActions();
  const go = () => acts.run("k", fn, { pending: "Saving…", success: "Saved.", reconcile, cin7 });
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
    it("the re-read itself failed: says so (never 'refreshed'), and never says to simply retry", async () => {
      render(<Harness fn={async () => { throw new Error("x"); }} reconcile={async () => { throw new Error("read failed"); }} />);
      fireEvent.click(screen.getByRole("button", { name: "Go" }));
      const text = (await screen.findByRole("alert")).textContent ?? "";
      expect(text).toBe(AMBIGUOUS_UNREADABLE);
      expect(text).toMatch(/could not refresh the status/);
      expect(text).not.toMatch(/has been refreshed|you can try again/i);
    });
    it("there is no re-read at all: the same honest 'could not refresh' wording", async () => {
      render(<Harness fn={async () => { throw new Error("x"); }} />);
      fireEvent.click(screen.getByRole("button", { name: "Go" }));
      expect((await screen.findByRole("alert")).textContent).toBe(AMBIGUOUS_UNREADABLE);
    });
    it("the re-read worked but cannot tell: points at the fresh status shown on the page", async () => {
      render(<Harness fn={async () => { throw new Error("x"); }} reconcile={async () => "unknown"} />);
      fireEvent.click(screen.getByRole("button", { name: "Go" }));
      const text = (await screen.findByRole("alert")).textContent ?? "";
      expect(text).toBe(AMBIGUOUS_UNKNOWN);
      expect(text).not.toMatch(/try again/i);
    });
    it("a Cin7 action that verifiably left no record never says 'try again'", async () => {
      render(<Harness cin7 fn={async () => { throw new Error("x"); }} reconcile={async () => "not_done"} />);
      fireEvent.click(screen.getByRole("button", { name: "Go" }));
      const text = (await screen.findByRole("alert")).textContent ?? "";
      expect(text).toBe(AMBIGUOUS_NOT_DONE_CIN7);
      expect(text).not.toMatch(/try again/i);
    });
    it("the control never stays stuck after a thrown error (the old hang)", async () => {
      render(<Harness fn={async () => { throw new Error("boom"); }} />);
      fireEvent.click(screen.getByRole("button", { name: "Go" }));
      await screen.findByRole("alert");
      await waitFor(() => expect((screen.getByRole("button", { name: "Go" }) as HTMLButtonElement).disabled).toBe(false));
    });
  });

  it("two DIFFERENT exclusive (financial) actions cannot both fire in the same tick; non-exclusive ones are unaffected", async () => {
    const a = vi.fn(async () => ({ ok: true })); const b = vi.fn(async () => ({ ok: true })); const c = vi.fn(async () => ({ ok: true }));
    function Two() {
      const acts = useKeyedActions();
      return <button onClick={() => { void acts.run("a", a, { exclusive: true }); void acts.run("b", b, { exclusive: true }); void acts.run("c", c); }}>Fire</button>;
    }
    render(<Two />);
    fireEvent.click(screen.getByRole("button", { name: "Fire" }));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled(); // blocked by the other financial action in flight
    expect(c).toHaveBeenCalledTimes(1); // not exclusive
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Fire" })); // the lock is released afterwards
    expect(a).toHaveBeenCalledTimes(2);
    await act(async () => undefined);
  });

  it("the floating backstop pins the message inside the viewport and keeps its ARIA role", () => {
    render(<ActionFeedback floating state={{ kind: "error", message: "Nope" }} />);
    const el = screen.getByRole("alert");
    expect(el.className).toMatch(/\bfixed\b/);
    expect(el.textContent).toContain("Nope");
  });
});
