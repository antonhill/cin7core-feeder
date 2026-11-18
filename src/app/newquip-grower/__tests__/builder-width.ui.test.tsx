// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// UX-005: the Solution Builder shares the dedicated data workspace width with its stage navigation (the page container was 1480px and Stage 1 added a further left-aligned 1152px box).
// Layout is Tailwind classes, which jsdom cannot measure, so this pins the class contract; the rendered widths were measured in a real browser (see the PR).
const page = readFileSync(`${__dirname}/../[id]/page.tsx`, "utf8");

describe("UX-005 Solution Builder width", () => {
  it("both page states use the data-workspace container, never the 1480px wide one", () => {
    expect(page.match(/<main className=\{pageContainerClass\("data"\)\}>/g)?.length).toBe(2);
    expect(page).not.toMatch(/pageContainerClass\("wide"\)/);
  });
  it("Stage 1 has no nested max-width box and is a two-column grid from xl", () => {
    const stage1 = page.slice(page.indexOf('data-testid="stage1-layout"') - 120, page.indexOf("2 · ESTIMATOR REVIEW"));
    // UX-006i1: Stage 1 is a five-step wizard; the equipment step lays Selections | Optional equipment side by side from xl and the site step is a two-column grid from xl.
    expect(stage1).toContain("xl:grid-cols-2");
    expect(stage1).toContain("xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]");
    expect(stage1).not.toContain("max-w-6xl");
    expect(stage1.match(/col-span-full/g)?.length).toBeGreaterThanOrEqual(4); // the wide panels (Quantities, Charges, Exclusions) span the row
  });
  it("free-text fields keep a comfortable maximum width", () => {
    // UX-006i1: the Assumptions field moved with the Rep's Charges & assumptions into the shared RepConfigSections.
    const sections = readFileSync(`${__dirname}/../[id]/RepConfigSections.tsx`, "utf8");
    expect(sections).toMatch(/max-w-3xl flex-col gap-1 text-sm">\s*<span[^>]*>Assumptions/);
  });
});
