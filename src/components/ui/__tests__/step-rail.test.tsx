// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen, act } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StepPanel, StepRail } from "../StepRail";
import { nextIncompleteStepId, parseStepParam, type RailStep } from "../step-rail-model";
import { useShowAllSteps } from "../use-show-all-steps";

const steps: RailStep[] = [
  { id: "a", label: "Alpha", status: "complete" },
  { id: "b", label: "Bravo", status: "attention", note: "Fix the thing" },
  { id: "c", label: "Charlie", status: "incomplete" },
  { id: "d", label: "Delta", status: "unavailable" },
];
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("step-rail-model (pure)", () => {
  it("nextIncompleteStepId skips complete, unavailable and the current step, and wraps to earlier ones", () => {
    expect(nextIncompleteStepId(steps, "a")).toBe("b");
    expect(nextIncompleteStepId(steps, "b")).toBe("c");
    expect(nextIncompleteStepId(steps, "c")).toBe("b"); // nothing later: back to the first earlier one
    expect(nextIncompleteStepId(steps.map((s) => ({ ...s, status: "complete" as const })), "a")).toBeNull();
  });
  it("parseStepParam clamps: only whole numbers 1..N are accepted, everything else is 1", () => {
    expect(parseStepParam("3", 5)).toBe(3);
    for (const bad of [null, undefined, "", "0", "6", "-1", "2.5", "abc", "1e1"]) expect(parseStepParam(bad as string | null, 5)).toBe(1);
  });
});

describe("StepRail a11y and behaviour", () => {
  it("the compact summary names how many steps need attention (only when any), and a Review step shows its text without a check", () => {
    render(<StepRail id="t" ariaLabel="S" steps={steps} currentId="a" onSelect={vi.fn()} />);
    expect(screen.getByTestId("step-rail-toggle").textContent).toContain("Step 1 of 4 · Alpha · 1 complete · 1 need attention");
    cleanup();
    const ok: RailStep[] = [{ id: "a", label: "Alpha", status: "complete" }, { id: "r", label: "Rho", status: "review" }];
    render(<StepRail id="t" ariaLabel="S" steps={ok} currentId="a" onSelect={vi.fn()} />);
    expect(screen.getByTestId("step-rail-toggle").textContent).not.toContain("attention");
    expect(screen.getByTestId("step-status-r").textContent).toBe("Review");
    expect(document.querySelector('[data-step="r"]')!.textContent).not.toContain("✓");
  });
  const view = (current = "b", onSelect = vi.fn()) => render(<StepRail id="t" ariaLabel="Test steps" steps={steps} currentId={current} onSelect={onSelect} />);
  it("is an ordered list of buttons with aria-current=step on the current one only, and status shown as text", () => {
    view();
    const list = screen.getByRole("navigation", { name: "Test steps" }).querySelector("ol")!;
    expect(list.tagName).toBe("OL");
    expect(list.querySelectorAll("li > button").length).toBe(4);
    expect(list.querySelectorAll('[aria-current="step"]').length).toBe(1);
    expect(list.querySelector('[aria-current="step"]')!.textContent).toContain("Bravo");
    expect(screen.getByTestId("step-status-a").textContent).toBe("Complete");
    expect(screen.getByTestId("step-status-b").textContent).toBe("Needs attention");
    expect(screen.getByTestId("step-status-c").textContent).toBe("Not complete");
    expect(screen.getByTestId("step-status-d").textContent).toBe("Not available");
    expect(list.textContent).toContain("Fix the thing");
  });
  it("shows a check for a complete step and the number otherwise", () => {
    view();
    const icons = Array.from(document.querySelectorAll("li > button > span[aria-hidden]")).map((e) => e.textContent);
    expect(icons).toEqual(["✓", "2", "3", "4"]);
  });
  it("selecting a step calls onSelect with its id (no completion required)", () => {
    const onSelect = vi.fn();
    view("a", onSelect);
    fireEvent.click(screen.getByRole("button", { name: /Charlie/ }));
    expect(onSelect).toHaveBeenCalledWith("c");
  });
  it("mobile disclosure: summary 'Step n of N · name · k complete', aria-expanded toggles, and choosing a step collapses it", () => {
    view("b");
    const toggle = screen.getByTestId("step-rail-toggle");
    expect(toggle.textContent).toContain("Step 2 of 4 · Bravo · 1 complete");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("t-list")!.className).toMatch(/(^|\s)hidden(\s|$)/);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("t-list")!.className).toMatch(/(^|\s)flex(\s|$)/);
    fireEvent.click(screen.getByRole("button", { name: /Charlie/ }));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
  it("has no duplicate live region (aria-current plus the focus move announce the step) and targets are at least 44px tall by class", () => {
    view("c");
    expect(screen.queryByTestId("step-rail-live")).toBeNull();
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(document.querySelector("li > button")!.className).toContain("min-h-11");
  });
});

describe("StepPanel", () => {
  it("keeps non-current steps MOUNTED but hidden and inert; show-all reveals every step", () => {
    const { rerender } = render(<><StepPanel railId="t" stepId="a" number={1} title="Alpha" current showAll={false}><input aria-label="in-a" /></StepPanel><StepPanel railId="t" stepId="b" number={2} title="Bravo" current={false} showAll={false}><input aria-label="in-b" /></StepPanel></>);
    const b = document.querySelector('[data-step-panel="b"]')!;
    expect(screen.getByLabelText("in-b")).toBeTruthy(); // still mounted
    expect(b.hasAttribute("hidden")).toBe(true);
    expect(b.hasAttribute("inert")).toBe(true);
    expect(document.querySelector('[data-step-panel="a"]')!.hasAttribute("hidden")).toBe(false);
    rerender(<><StepPanel railId="t" stepId="a" number={1} title="Alpha" current showAll><input aria-label="in-a" /></StepPanel><StepPanel railId="t" stepId="b" number={2} title="Bravo" current={false} showAll><input aria-label="in-b" /></StepPanel></>);
    expect(b.hasAttribute("hidden")).toBe(false);
    expect(b.hasAttribute("inert")).toBe(false);
  });
  it("moves focus to the step heading when the step becomes current, and not on first render", () => {
    const panels = (cur: string) => <><StepPanel railId="t" stepId="a" number={1} title="Alpha" current={cur === "a"} showAll={false}>x</StepPanel><StepPanel railId="t" stepId="b" number={2} title="Bravo" current={cur === "b"} showAll={false}>y</StepPanel></>;
    const { rerender } = render(panels("a"));
    expect(document.activeElement).toBe(document.body);
    rerender(panels("b"));
    expect(document.activeElement).toBe(document.getElementById("t-b-heading"));
    expect(document.getElementById("t-b-heading")!.textContent).toBe("Step 2 · Bravo");
  });
});

describe("a hidden step stays display:none even with a grid class", () => {
  it("the panel carries the hidden attribute AND a grid class, and the Tailwind preflight hides [hidden] with !important", () => {
    render(<StepPanel railId="t" stepId="a" number={1} title="Alpha" current={false} showAll={false} className="col-span-full grid xl:grid-cols-2">x</StepPanel>);
    const el = document.querySelector('[data-step-panel="a"]')!;
    expect(el.hasAttribute("hidden")).toBe(true);
    expect(el.className).toContain("grid");
    const css = readFileSync(`${process.cwd()}/node_modules/tailwindcss/preflight.css`, "utf8");
    expect(css).toMatch(/\[hidden\]:where\(:not\(\[hidden='until-found'\]\)\)\s*\{\s*display:\s*none\s*!important/);
  });
  it("show-all never hides a step, so a `contents` layout is never applied to a hidden one", () => {
    render(<StepPanel railId="t" stepId="a" number={1} title="Alpha" current={false} showAll className="contents">x</StepPanel>);
    expect(document.querySelector('[data-step-panel="a"]')!.hasAttribute("hidden")).toBe(false);
  });
});

describe("useShowAllSteps (per-viewer convenience)", () => {
  const store = (initial: Record<string, string> = {}) => {
    const data = { ...initial };
    vi.stubGlobal("localStorage", { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v; } });
    return data;
  };
  it("defaults to the guided view, remembers the choice and restores it", () => {
    const data = store();
    const first = renderHook(() => useShowAllSteps("k"));
    expect(first.result.current[0]).toBe(false);
    act(() => first.result.current[1](true));
    expect(first.result.current[0]).toBe(true);
    expect(data.k).toBe("1");
    first.unmount();
    expect(renderHook(() => useShowAllSteps("k")).result.current[0]).toBe(true);
  });
  it("still works, in the guided default, when storage throws on read and write", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    const h = renderHook(() => useShowAllSteps("k"));
    expect(h.result.current[0]).toBe(false);
    act(() => h.result.current[1](true));
    expect(h.result.current[0]).toBe(true);
  });
});

describe("presentation/derivation modules import no server action or store", () => {
  const files = [
    "src/components/ui/StepRail.tsx", "src/components/ui/step-rail-model.ts", "src/components/ui/use-show-all-steps.ts", "src/newquip/quote/stage1-steps.ts", "src/newquip/quote/stage2-steps.ts", "src/app/newquip-grower/[id]/Stage1Review.tsx",
  ];
  it.each(files)("%s", (f) => {
    const src = readFileSync(`${process.cwd()}/${f}`, "utf8");
    const specs = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    for (const s of specs) expect(s, `${f} imports ${s}`).not.toMatch(/actions|-store|supabase|server-only|\/lib\/newquip-quotes\/quote-store/);
    expect(src).not.toMatch(/^"use server"/m);
  });
  it("the directory listing is real (guards against a path typo making the loop vacuous)", () => { expect(readdirSync(`${process.cwd()}/src/components/ui`)).toContain("StepRail.tsx"); });
});
