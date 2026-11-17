import { describe, expect, it } from "vitest";
import { isNewquipPublicPath, isNewquipSignInRoute, safeNewquipNext } from "../entry";
import { isNewquipOnlyPathAllowed } from "../route-guard";

describe("NewQuip entry helpers", () => {
  it("public paths are exact: /newquip-grower is not public", () => {
    expect(isNewquipPublicPath("/newquip")).toBe(true);
    expect(isNewquipPublicPath("/newquip/login")).toBe(true);
    expect(isNewquipPublicPath("/newquip-grower")).toBe(false);
    expect(isNewquipPublicPath("/newquip/other")).toBe(false);
  });
  it("sign-in routes: NewQuip prefixes always; root only with the entry cookie", () => {
    for (const p of ["/newquip-grower", "/newquip-grower/abc", "/projects", "/projects/1", "/claims", "/approvals"]) expect(isNewquipSignInRoute(p, false), p).toBe(true);
    expect(isNewquipSignInRoute("/", false)).toBe(false);
    expect(isNewquipSignInRoute("/", true)).toBe(true);
    for (const p of ["/reports", "/settings/instances", "/projects-x", "/login"]) expect(isNewquipSignInRoute(p, true), p).toBe(false);
  });
  it("next accepts only same-origin NewQuip paths", () => {
    expect(safeNewquipNext("/newquip-grower/abc?x=1")).toBe("/newquip-grower/abc?x=1");
    expect(safeNewquipNext("/projects")).toBe("/projects");
    for (const bad of ["https://evil.example/projects", "//evil.example/projects", "/\\evil.example", "/projects/../reports", "/projects/%2e%2e/reports", "/reports", "/", "javascript:alert(1)", "/projects#x", "/projects\n", "", null, undefined, "/projects//x", "/%2F%2Fevil.example"]) {
      expect(safeNewquipNext(bad as string | null | undefined), String(bad)).toBeNull();
    }
  });
  it("NewQuip-only users may reach the sign-in page paths", () => {
    expect(isNewquipOnlyPathAllowed("/newquip/login")).toBe(true);
    expect(isNewquipOnlyPathAllowed("/newquip")).toBe(true);
  });
});
