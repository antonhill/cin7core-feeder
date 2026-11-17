import { describe, expect, it } from "vitest";
import { INVITE_ROLES, inviteInstructions, isInviteRole, normaliseInviteEmail } from "../invite";
import { settingsEntries } from "../settings-entries";

describe("NewQuip invitations (pure)", () => {
  it("offers exactly Rep, Estimator and Manager; never Administrator or other roles", () => {
    expect([...INVITE_ROLES]).toEqual(["REP", "ESTIMATOR", "MANAGER"]);
    expect(isInviteRole("ADMINISTRATOR")).toBe(false); expect(isInviteRole("PROCUREMENT")).toBe(false); expect(isInviteRole("REP")).toBe(true);
  });
  it("accepts one plausible address, lower-cased, and rejects lists and junk", () => {
    expect(normaliseInviteEmail("  Jane@Farm.CO.za ")).toBe("jane@farm.co.za");
    for (const bad of ["", "a@b", "a@b.co, c@d.co", "a b@c.co", "a@b.co;c@d.co", null, 5]) expect(normaliseInviteEmail(bad)).toBeNull();
  });
  it("instructions point at the dedicated NewQuip login, mention the code and contain no password", () => {
    const t = inviteInstructions("https://x.example", "a@b.co", "ESTIMATOR");
    expect(t).toContain("https://x.example/newquip/login"); expect(t).toContain("Estimator"); expect(t).toMatch(/6-digit code/); expect(t).not.toMatch(/password:/i);
  });
  it("the Team entry shows for a Manager or org admin only", () => {
    const has = (v: Parameters<typeof settingsEntries>[0]) => settingsEntries(v).some((e) => e.href === "/newquip-grower/team");
    expect(has({ isOrgAdmin: false, canSeeCost: false, demo: false })).toBe(false);
    expect(has({ isOrgAdmin: false, canSeeCost: false, demo: false, isManager: true })).toBe(true);
    expect(has({ isOrgAdmin: true, canSeeCost: false, demo: false })).toBe(true);
  });
});
