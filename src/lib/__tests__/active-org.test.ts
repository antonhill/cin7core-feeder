import { describe, it, expect } from "vitest";
import { resolveActiveOrgId } from "@/lib/active-org";

describe("resolveActiveOrgId — security re-audit P1-8", () => {
  it("uses the cookie org when it's a real membership", () => {
    expect(resolveActiveOrgId("org-2", ["org-1", "org-2", "org-3"])).toBe("org-2");
  });

  it("falls back to the first membership when there's no cookie", () => {
    expect(resolveActiveOrgId(null, ["org-1", "org-2"])).toBe("org-1");
  });

  it("falls back to the first membership when the cookie org isn't a real membership (stale/tampered)", () => {
    expect(resolveActiveOrgId("org-not-a-member-of", ["org-1", "org-2"])).toBe("org-1");
  });

  it("returns the sole membership regardless of the cookie", () => {
    expect(resolveActiveOrgId(null, ["org-1"])).toBe("org-1");
    expect(resolveActiveOrgId("org-1", ["org-1"])).toBe("org-1");
  });

  it("returns null when there are no memberships at all", () => {
    expect(resolveActiveOrgId("org-1", [])).toBeNull();
    expect(resolveActiveOrgId(null, [])).toBeNull();
  });
});
