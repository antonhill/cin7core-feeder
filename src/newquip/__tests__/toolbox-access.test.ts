import { describe, expect, it } from "vitest";
import { MODULES, computeEffectiveDisabledModules, findBlockedModule, newquipOnlyLinks } from "@/app/module-nav";
import { NEWQUIP_POC_ORG_IDS } from "../access";
import { isNewquipOnlyPathAllowed, newquipGuardRedirects } from "../route-guard";
import { isGrantedToolboxPath, newquipOnlyAllowList, normaliseModulesToSave, toolboxGrantsOf } from "../toolbox-access";

const REG = MODULES.map((m) => m.href);
const NQ = NEWQUIP_POC_ORG_IDS[0];

describe("toolboxGrantsOf: default-deny", () => {
  it("null and an empty list grant NOTHING (an empty list must never mean unrestricted for a NewQuip-only user)", () => {
    expect(toolboxGrantsOf(null, REG)).toEqual([]);
    expect(toolboxGrantsOf(undefined, REG)).toEqual([]);
    expect(toolboxGrantsOf([], REG)).toEqual([]);
  });
  it("keeps only real, grantable modules; NewQuip's own Projects key and unknown values are never a grant", () => {
    expect(toolboxGrantsOf(["/quotes", "/projects", "/nope", "/quotes"], REG)).toEqual(["/quotes"]);
  });
});

describe("isGrantedToolboxPath", () => {
  it("matches the module and its nested routes on a segment boundary only", () => {
    expect(isGrantedToolboxPath("/quotes", ["/quotes"])).toBe(true);
    expect(isGrantedToolboxPath("/quotes/abc", ["/quotes"])).toBe(true);
    expect(isGrantedToolboxPath("/quotes-x", ["/quotes"])).toBe(false);
    expect(isGrantedToolboxPath("/reports", ["/quotes"])).toBe(false);
    expect(isGrantedToolboxPath("/quotes/../reports", ["/quotes"])).toBe(false);
    expect(isGrantedToolboxPath("/quotes", [])).toBe(false);
  });
});

describe("route guard with an individual grant", () => {
  it("is unchanged by default: /quotes and every Toolbox module stay refused", () => {
    for (const p of ["/quotes", "/reports", "/import", "/replenish"]) {
      expect(isNewquipOnlyPathAllowed(p), p).toBe(false);
      expect(newquipGuardRedirects({ pathname: p, orgId: NQ, isSuperAdmin: false }), p).toBe(true);
    }
  });
  it("a grant opens ONLY that module, by navigation and direct URL, and nothing else", () => {
    const g = ["/quotes"];
    expect(newquipGuardRedirects({ pathname: "/quotes", orgId: NQ, isSuperAdmin: false, toolboxGrants: g })).toBe(false);
    expect(newquipGuardRedirects({ pathname: "/quotes/123", orgId: NQ, isSuperAdmin: false, toolboxGrants: g })).toBe(false);
    for (const p of ["/reports", "/import", "/replenish", "/settings/instances", "/admin", "/quotes-x"]) expect(newquipGuardRedirects({ pathname: p, orgId: NQ, isSuperAdmin: false, toolboxGrants: g }), p).toBe(true);
  });
  it("the NewQuip workspace stays reachable with or without a grant", () => {
    for (const p of ["/newquip-grower", "/projects", "/approvals", "/claims", "/settings/members"]) {
      expect(newquipGuardRedirects({ pathname: p, orgId: NQ, isSuperAdmin: false, toolboxGrants: [] }), p).toBe(false);
      expect(newquipGuardRedirects({ pathname: p, orgId: NQ, isSuperAdmin: false, toolboxGrants: ["/quotes"] }), p).toBe(false);
    }
  });
  it("an uncertain identity still fails closed for a Toolbox path (a grant cannot be read when the lookup failed)", () => {
    expect(newquipGuardRedirects({ pathname: "/quotes", orgId: NQ, isSuperAdmin: false, uncertain: true, toolboxGrants: [] })).toBe(true);
  });
});

describe("module visibility for a NewQuip-only user", () => {
  const disabledFor = (allowed: string[] | null, toolbox: boolean) => computeEffectiveDisabledModules([], newquipOnlyAllowList(allowed, REG, { toolbox }));
  it("Grower surface: NewQuip's own keys stay on whatever allowed_modules holds, so a Toolbox switch can never remove Grower access", () => {
    for (const allowed of [null, [], ["/quotes"], ["/reports"]]) {
      const d = disabledFor(allowed, false);
      expect(findBlockedModule("/quotes", d), JSON.stringify(allowed)).toBeUndefined();
      expect(findBlockedModule("/projects", d), JSON.stringify(allowed)).toBeUndefined();
    }
  });
  it("Toolbox surface: /quotes needs a real grant; null and [] are denied; /projects (NewQuip's own) is still on", () => {
    expect(findBlockedModule("/quotes", disabledFor(null, true))?.href).toBe("/quotes");
    expect(findBlockedModule("/quotes", disabledFor([], true))?.href).toBe("/quotes");
    expect(findBlockedModule("/quotes", disabledFor(["/reports"], true))?.href).toBe("/quotes");
    expect(findBlockedModule("/quotes", disabledFor(["/quotes"], true))).toBeUndefined();
    expect(findBlockedModule("/projects", disabledFor([], true))).toBeUndefined();
  });
  it("only the granted Toolbox module is on; every other Toolbox module stays blocked", () => {
    const d = disabledFor(["/quotes"], true);
    for (const m of MODULES.filter((x) => x.href !== "/quotes" && x.href !== "/projects")) expect(findBlockedModule(m.href, d), m.href).toBeDefined(); // (prefix-matched: /reports/picking-calendar reports as /reports)
  });
  it("an organisation-wide disable still wins over a grant", () => {
    const d = computeEffectiveDisabledModules(["/quotes"], newquipOnlyAllowList(["/quotes"], REG, { toolbox: true }));
    expect(findBlockedModule("/quotes", d)?.href).toBe("/quotes");
  });
});

describe("normaliseModulesToSave", () => {
  it("NewQuip: null is stored as an explicit empty list, never null", () => {
    expect(normaliseModulesToSave({ newquipOnly: true, modules: null, registryHrefs: REG })).toEqual({ ok: true, modules: [] });
  });
  it("other organisations keep null = unrestricted", () => {
    expect(normaliseModulesToSave({ newquipOnly: false, modules: null, registryHrefs: REG })).toEqual({ ok: true, modules: null });
    expect(normaliseModulesToSave({ newquipOnly: false, modules: ["/projects"], registryHrefs: REG })).toEqual({ ok: true, modules: ["/projects"] });
  });
  it("rejects unknown hrefs, and NewQuip's own key as a grant", () => {
    expect(normaliseModulesToSave({ newquipOnly: true, modules: ["/typo"], registryHrefs: REG }).ok).toBe(false);
    expect(normaliseModulesToSave({ newquipOnly: true, modules: ["/projects"], registryHrefs: REG }).ok).toBe(false);
  });
  it("collapses duplicates", () => {
    expect(normaliseModulesToSave({ newquipOnly: true, modules: ["/quotes", "/quotes"], registryHrefs: REG })).toEqual({ ok: true, modules: ["/quotes"] });
  });
});

describe("NewQuip-only navigation", () => {
  const labels = (grants: string[]) => newquipOnlyLinks(NQ, [], false, grants).map((l) => l.label);
  it("shows no Toolbox link by default", () => {
    expect(labels([]).some((l) => l.startsWith("Toolbox"))).toBe(false);
    expect(labels([])).toContain("Quotations");
  });
  it("a grant adds exactly that module's link and keeps the Grower links", () => {
    const l = labels(["/quotes"]);
    expect(l).toContain("Toolbox Quotes");
    expect(l).toContain("Quotations");
    expect(l.filter((x) => x.startsWith("Toolbox"))).toHaveLength(1);
  });
  it("a super-admin or another org gets no NewQuip-only links", () => {
    expect(newquipOnlyLinks(NQ, [], true, ["/quotes"])).toEqual([]);
  });
});
