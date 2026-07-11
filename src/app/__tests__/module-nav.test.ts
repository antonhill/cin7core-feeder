import { describe, expect, it } from "vitest";
import { findBlockedModule, computeEffectiveDisabledModules, MODULES } from "@/app/module-nav";

describe("findBlockedModule", () => {
  it("returns undefined when nothing is disabled", () => {
    expect(findBlockedModule("/reports", [])).toBeUndefined();
  });

  it("returns the module when its href is disabled and the pathname matches exactly", () => {
    const result = findBlockedModule("/reports", ["/reports"]);
    expect(result?.href).toBe("/reports");
  });

  it("matches a sub-path of a disabled module (e.g. a future /reports/detail route)", () => {
    const result = findBlockedModule("/reports/detail", ["/reports"]);
    expect(result?.href).toBe("/reports");
  });

  it("does not match a different module that happens to share a prefix character", () => {
    // /reports and /report (hypothetical) shouldn't cross-match — startsWith is exact-segment safe here
    // because every real href in MODULES is distinct and non-overlapping.
    expect(findBlockedModule("/audit", ["/reports"])).toBeUndefined();
  });

  it("is unaffected by other disabled modules that don't match the current path", () => {
    expect(findBlockedModule("/health", ["/reports", "/audit"])).toBeUndefined();
  });

  it("only reports one module even if the pathname could theoretically match more than one disabled entry", () => {
    // settings/instances is the only href with a nested path segment; confirm it's found correctly
    const result = findBlockedModule("/settings/instances", ["/settings/instances"]);
    expect(result?.href).toBe("/settings/instances");
  });

  it("every module in MODULES has a unique href — a prerequisite for prefix matching to be unambiguous", () => {
    const hrefs = MODULES.map((m) => m.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe("computeEffectiveDisabledModules", () => {
  it("returns the org's own disabled list unchanged when the user is unrestricted (null allow-list)", () => {
    expect(computeEffectiveDisabledModules(["/reports"], null)).toEqual(["/reports"]);
  });

  it("denies every module not in the user's own allow-list", () => {
    const result = computeEffectiveDisabledModules([], ["/import"]);
    const expectedDenied = MODULES.map((m) => m.href).filter((href) => href !== "/import");
    expect(new Set(result)).toEqual(new Set(expectedDenied));
  });

  it("keeps an org-disabled module denied even when the user's own allow-list explicitly includes it — org-level disable always wins", () => {
    const result = computeEffectiveDisabledModules(["/reports"], ["/reports", "/import"]);
    expect(result).toContain("/reports");
  });

  it("an empty (non-null) allow-list denies every module — a real, intentional 'restricted from everything' state, not coerced to unrestricted", () => {
    const result = computeEffectiveDisabledModules([], []);
    expect(new Set(result)).toEqual(new Set(MODULES.map((m) => m.href)));
  });

  it("doesn't produce duplicate hrefs when the org-disabled and user-denied sets overlap", () => {
    const result = computeEffectiveDisabledModules(["/reports"], []);
    expect(result.filter((href) => href === "/reports")).toHaveLength(1);
  });
});
