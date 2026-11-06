import { describe, expect, it } from "vitest";
import { hasAny, PROJECT_CREATE_ROLES, rolesFor } from "../roles";

describe("UAT-008: who may create a Project from an accepted quotation", () => {
  it("a plain member (Rep + Estimator) may not; an admin/Manager may", () => {
    expect(hasAny(rolesFor("member"), PROJECT_CREATE_ROLES)).toBe(false);
    expect(hasAny(rolesFor("none"), PROJECT_CREATE_ROLES)).toBe(false);
    expect(hasAny(rolesFor("admin"), PROJECT_CREATE_ROLES)).toBe(true);
  });
  it("a Rep alone and an Estimator alone may not", () => {
    expect(hasAny(new Set(["rep"] as const), PROJECT_CREATE_ROLES)).toBe(false);
    expect(hasAny(new Set(["estimator"] as const), PROJECT_CREATE_ROLES)).toBe(false);
    expect(hasAny(new Set(["manager"] as const), PROJECT_CREATE_ROLES)).toBe(true);
  });
});
