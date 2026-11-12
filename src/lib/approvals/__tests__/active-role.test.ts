import { describe, expect, it, vi } from "vitest";
import { activeFor, activeSeesCosts, narrowToActive, parseSwitchEmails, switchHeldRoles } from "../active-role";
import type { FunctionalRole } from "../roles";

vi.mock("server-only", () => ({}));
const POC = "e1aea782-d095-47ad-90fb-4fa65c9bf855";
const allow = parseSwitchEmails(" Shirnel@Example.com, not-an-email, ,rene@example.com@x ");

describe("role switch eligibility (pure)", () => {
  it("parses only plain emails, lower-cased; unset or empty means nobody", () => {
    expect([...allow]).toEqual(["shirnel@example.com"]);
    expect(parseSwitchEmails(undefined).size).toBe(0);
    expect(parseSwitchEmails("").size).toBe(0);
  });
  it("offers a switch only to an allowlisted person with two or more explicit Rep/Estimator/Manager assignments in the NewQuip organisation", () => {
    const ok = { orgId: POC, email: "SHIRNEL@example.com", assigned: ["MANAGER", "REP", "ESTIMATOR"], allowlist: allow };
    expect(switchHeldRoles(ok)).toEqual(["REP", "ESTIMATOR", "MANAGER"]); // least privilege first, fixed order
    expect(switchHeldRoles({ ...ok, assigned: ["ESTIMATOR"] })).toBeNull();                       // René: one role, never a toggle
    expect(switchHeldRoles({ ...ok, assigned: ["ESTIMATOR", "ADMINISTRATOR"] })).toBeNull();      // Administrator is not a process role
    expect(switchHeldRoles({ ...ok, email: "rene@example.com" })).toBeNull();                      // not on the allowlist
    expect(switchHeldRoles({ ...ok, email: null })).toBeNull();
    expect(switchHeldRoles({ ...ok, orgId: "some-other-org" })).toBeNull();                        // another organisation
    expect(switchHeldRoles({ ...ok, allowlist: new Set() })).toBeNull();                           // default: nobody
  });
  it("two-role holders switch between exactly their two roles", () => {
    expect(switchHeldRoles({ orgId: POC, email: "shirnel@example.com", assigned: ["REP", "MANAGER"], allowlist: allow })).toEqual(["REP", "MANAGER"]);
  });
});

describe("active role", () => {
  const held = ["REP", "ESTIMATOR", "MANAGER"] as const;
  it("defaults to the least-privileged role; honours a selection only if it is held", () => {
    expect(activeFor(held, null)).toEqual({ active: "REP", selected: false });
    expect(activeFor(held, "MANAGER")).toEqual({ active: "MANAGER", selected: true });
    expect(activeFor(["REP", "ESTIMATOR"], "MANAGER")).toEqual({ active: "REP", selected: false }); // not held: ignored
    expect(activeFor(held, "ADMINISTRATOR")).toEqual({ active: "REP", selected: false });
    expect(activeFor(held, "rep")).toEqual({ active: "REP", selected: false });
  });
  it("narrows to ONE process role, keeps Administrator and unrelated roles, and only Estimator/Manager see costs", () => {
    const all = new Set<FunctionalRole>(["REP", "ESTIMATOR", "MANAGER", "ADMINISTRATOR", "PROCUREMENT"]);
    expect([...narrowToActive(all, "ESTIMATOR")].sort()).toEqual(["ADMINISTRATOR", "ESTIMATOR", "PROCUREMENT"]);
    expect([...narrowToActive(all, "REP")].sort()).toEqual(["ADMINISTRATOR", "PROCUREMENT", "REP"]);
    expect(activeSeesCosts("REP")).toBe(false);
    expect(activeSeesCosts("ESTIMATOR")).toBe(true);
    expect(activeSeesCosts("MANAGER")).toBe(true);
  });
});
