// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { PackageConfirm } from "../[id]/WorkspaceEditors";

// Regression (UAT acceptance NQ-Q-0013): the Estimator's confirm text for a LAYOUT-DRIVEN package (pad cooling) said "7 components below ()" because `packageFor` has no fixed definition for it. The
// components of the saved Budget line must be listed and counted instead, so the Estimator knows what is being confirmed.
afterEach(() => cleanup());
const lines = [{ description: "Basic gutter kit (3m)", qtyPerUnit: 1 }, { description: "Cooling paper pad 1500x600x150 mm", qtyPerUnit: 34 }, { description: "Pump", qtyPerUnit: 1 }];
const mount = (over: Record<string, unknown> = {}) => render(createElement(PackageConfirm, { templateRevision: "grower-2026-11" as never, itemKey: "pad_cooling", confirmed: false, canEdit: true, busy: false, onConfirm: () => {}, ...over }));

describe("PackageConfirm for a layout-driven package", () => {
  it("lists and counts the saved line's components", () => {
    mount({ lineComponents: lines });
    const text = document.body.textContent ?? "";
    expect(text).toContain("3 components below");
    expect(text).toContain("34 Cooling paper pad 1500x600x150 mm");
    expect(text).not.toContain("()");
    expect(screen.getByRole("heading", { name: /3-component package/ })).toBeTruthy();
  });
  it("a fixed package still lists its own definition", () => {
    mount({ itemKey: "cup_drinker", lineComponents: undefined });
    expect(document.body.textContent ?? "").toMatch(/7 components below \(.+\)/);
  });
});
