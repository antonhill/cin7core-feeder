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

import { buildNavLinks, isNavLinkActive, SOLUTION_BUILDER_MODULE, ADMIN_MODULE } from "@/app/module-nav";
import { NEWQUIP_POC_ORG_IDS } from "@/newquip/access";

describe("Solution Builder navigation (NewQuip Grower)", () => {
  const NEWQUIP = NEWQUIP_POC_ORG_IDS[0];
  const OTHER = "0242e481-0f2b-4bd9-a8ef-2d4a9554bc09";
  const labels = (orgId: string | null, disabled: string[] = [], admin = false) => buildNavLinks(orgId, disabled, admin).map((l) => l.label);

  it("the NewQuip org sees Solution Builder, pointing at /newquip-grower", () => {
    const link = buildNavLinks(NEWQUIP, [], false).find((l) => l.label === "Solution Builder");
    expect(link?.href).toBe("/newquip-grower");
    expect(link).toBe(SOLUTION_BUILDER_MODULE);
  });
  it("an unrelated org, a missing org, and a super-admin on another org do not", () => {
    expect(labels(OTHER)).not.toContain("Solution Builder");
    expect(labels(null)).not.toContain("Solution Builder");
    expect(labels(OTHER, [], true)).not.toContain("Solution Builder");
  });
  it("sits straight after Quotes, and is not a MODULES entry (so it can never leak to other orgs by default)", () => {
    const l = labels(NEWQUIP);
    expect(l[l.indexOf("Quotes") + 1]).toBe("Solution Builder");
    expect(MODULES.map((m) => m.href)).not.toContain("/newquip-grower");
  });
  it("leaves every other link and its order untouched", () => {
    expect(labels(NEWQUIP).filter((x) => x !== "Solution Builder" && x !== "Approvals")).toEqual(labels(OTHER));
  });
  it("follows the same access rule as its routes: hidden when the Quotes module is disabled", () => {
    expect(labels(NEWQUIP, ["/quotes"])).not.toContain("Solution Builder");
  });
  it("other disabled modules do not hide it; Projects can still follow", () => {
    expect(labels(NEWQUIP, ["/reports"])).toContain("Solution Builder");
    expect(labels(NEWQUIP)).toContain("Projects");
  });
  it("NewQuip also gets Approvals (straight after Projects, hidden with Projects, never for other orgs, not a MODULES entry)", () => {
    const l = labels(NEWQUIP);
    expect(l[l.indexOf("Projects") + 1]).toBe("Approvals");
    expect(buildNavLinks(NEWQUIP, [], false).find((x) => x.label === "Approvals")?.href).toBe("/approvals");
    expect(labels(OTHER)).not.toContain("Approvals");
    expect(labels(NEWQUIP, ["/projects"])).not.toContain("Approvals");
    expect(MODULES.map((m) => m.href)).not.toContain("/approvals");
  });
  it("super-admin still gets Admin appended", () => {
    expect(buildNavLinks(NEWQUIP, [], true).at(-1)).toBe(ADMIN_MODULE);
  });
  it("is active for /newquip-grower and every nested route (template detail, quote editor) — and nothing else", () => {
    const h = SOLUTION_BUILDER_MODULE.href;
    for (const p of ["/newquip-grower", "/newquip-grower/template", "/newquip-grower/9d1f-quote-id"]) expect(isNavLinkActive(p, h)).toBe(true);
    for (const p of ["/quotes", "/projects", "/newquip-growers", "/"]) expect(isNavLinkActive(p, h)).toBe(false);
    expect(isNavLinkActive("/projects/abc", "/projects")).toBe(true);
  });
});

import { buildNavItems } from "@/app/module-nav";

describe("NewQuip group in the left navigation", () => {
  const NEWQUIP = NEWQUIP_POC_ORG_IDS[0];
  const OTHER = "0242e481-0f2b-4bd9-a8ef-2d4a9554bc09";
  const shape = (orgId: string | null, disabled: string[] = [], admin = false) =>
    buildNavItems(orgId, disabled, admin).map((i) => (i.kind === "group" ? `${i.label}[${i.children.map((c) => c.label).join(",")}]` : i.link.label));

  it("nests Solution Builder, Projects and Approvals under one NewQuip heading, in that order, and removes them from the top level", () => {
    const s = shape(NEWQUIP);
    expect(s.filter((x) => x.startsWith("NewQuip["))).toEqual(["NewQuip[Solution Builder,Projects,Approvals]"]);
    for (const top of ["Solution Builder", "Projects", "Approvals"]) expect(s).not.toContain(top);
  });
  it("keeps every other module as an ordinary link, in its place", () => {
    const flat = buildNavLinks(NEWQUIP, [], false).map((l) => l.label).filter((l) => !["Solution Builder", "Projects", "Approvals"].includes(l));
    expect(shape(NEWQUIP).filter((x) => !x.startsWith("NewQuip["))).toEqual(flat);
  });
  it("other organisations and a signed-out view get no group", () => {
    expect(shape(OTHER).some((x) => x.startsWith("NewQuip["))).toBe(false);
    expect(shape(null).some((x) => x.startsWith("NewQuip["))).toBe(false);
    expect(buildNavItems(OTHER, [], false).every((i) => i.kind === "link")).toBe(true);
  });
  it("respects module visibility: disabling Projects removes it (and Approvals, which follows Projects) from the group; with everything hidden there is no group", () => {
    expect(shape(NEWQUIP, ["/projects"]).find((x) => x.startsWith("NewQuip["))).toBe("NewQuip[Solution Builder]");
    const none = shape(NEWQUIP, ["/quotes", "/projects"]);
    expect(none.some((x) => x.startsWith("NewQuip["))).toBe(false);
  });
  it("the super-admin Admin link stays last and outside the group", () => {
    const items = buildNavItems(NEWQUIP, [], true);
    const last = items.at(-1)!;
    expect(last.kind === "link" && last.link === ADMIN_MODULE).toBe(true);
  });
});
