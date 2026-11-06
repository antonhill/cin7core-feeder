import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// UX-004: the page's own scroll container must be a containing block (`relative`). If it is not, absolutely positioned descendants such as the
// `sr-only` labels are positioned against the page, are not clipped by the container, and extend the DOCUMENT height: a blank band of several
// screens under the last panel (measured: +893px at 1440, +2,328px at 390 on the Commercial tab). jsdom cannot measure layout, so this pins the
// class; scripts/check-scroll-height.mjs measures it in a real browser.
const layout = readFileSync(join(__dirname, "..", "layout.tsx"), "utf8");

describe("root layout scroll container", () => {
  const m = /<div className="([^"]*overflow-y-auto[^"]*)">/.exec(layout);
  it("exists exactly once", () => {
    expect(m).not.toBeNull();
    expect(layout.match(/overflow-y-auto/g)?.length).toBe(1);
  });
  it("is a containing block for absolutely positioned descendants", () => {
    expect(m![1].split(/\s+/)).toContain("relative");
  });
  it("still scrolls vertically inside the viewport-height body (no min-height or fixed height on the scroller)", () => {
    const cls = m![1].split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(["flex-1", "overflow-y-auto"]));
    expect(cls.some((c) => /^(min-)?h-/.test(c))).toBe(false);
  });
});
