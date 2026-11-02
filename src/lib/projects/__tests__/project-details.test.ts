import { describe, expect, it } from "vitest";
import { parseIsoDate, validateProjectDetails } from "../project-details";

const MEMBERS = ["anton@sparkconsulting.co.za", "pm@newquip.co.za"];
const input = (over: Partial<Parameters<typeof validateProjectDetails>[0]> = {}) => ({ projectManager: null, startDate: null, targetCompletionDate: null, ...over });

describe("dates", () => {
  it.each(["2026-11-02", "2028-02-29", "2000-01-01", "2100-12-31"])("accepts the real date %s", (d) => expect(parseIsoDate(d)).toEqual({ ok: true, value: d }));
  it.each(["2026-02-30", "2026-13-01", "2026-00-10", "2027-02-29", "02/11/2026", "2026-1-5", "1999-12-31", "2101-01-01", "tomorrow", "2026-11-02T10:00"])("refuses %s", (d) => expect(parseIsoDate(d).ok).toBe(false));
  it("empty or blank means not set", () => { expect(parseIsoDate("")).toEqual({ ok: true, value: null }); expect(parseIsoDate("  ")).toEqual({ ok: true, value: null }); expect(parseIsoDate(null)).toEqual({ ok: true, value: null }); });
});

describe("validateProjectDetails", () => {
  it("accepts a manager of the organisation, stored as the member's canonical lower-case email", () => {
    const r = validateProjectDetails(input({ projectManager: "  PM@NewQuip.co.za ", startDate: "2026-11-03", targetCompletionDate: "2027-03-01" }), MEMBERS);
    expect(r).toEqual({ ok: true, patch: { project_manager: "pm@newquip.co.za", start_date: "2026-11-03", target_completion_date: "2027-03-01" } });
  });
  it("refuses a manager who is not a user of the organisation (no free text)", () => {
    const r = validateProjectDetails(input({ projectManager: "Fixture Project Manager" }), MEMBERS);
    expect(r).toEqual({ ok: false, error: "The project manager must be a user of this organisation." });
  });
  it("refuses a manager when the organisation has no users at all", () => {
    expect(validateProjectDetails(input({ projectManager: "pm@newquip.co.za" }), []).ok).toBe(false);
  });
  it("clearing everything is allowed", () => {
    expect(validateProjectDetails(input(), MEMBERS)).toEqual({ ok: true, patch: { project_manager: null, start_date: null, target_completion_date: null } });
  });
  it("the target cannot be before the start; the same day is fine; either alone is fine", () => {
    expect(validateProjectDetails(input({ startDate: "2026-11-03", targetCompletionDate: "2026-11-02" }), MEMBERS)).toEqual({ ok: false, error: "The target completion date cannot be before the start date." });
    expect(validateProjectDetails(input({ startDate: "2026-11-03", targetCompletionDate: "2026-11-03" }), MEMBERS).ok).toBe(true);
    expect(validateProjectDetails(input({ targetCompletionDate: "2026-11-02" }), MEMBERS).ok).toBe(true);
    expect(validateProjectDetails(input({ startDate: "2026-11-02" }), MEMBERS).ok).toBe(true);
  });
  it("names the field with the bad date", () => {
    expect((validateProjectDetails(input({ startDate: "2026-02-30" }), MEMBERS) as { error: string }).error).toMatch(/start date/);
    expect((validateProjectDetails(input({ targetCompletionDate: "soon" }), MEMBERS) as { error: string }).error).toMatch(/target completion/);
  });
  it("the patch carries exactly the three editable columns and nothing financial", () => {
    const r = validateProjectDetails(input(), MEMBERS);
    if (!r.ok) throw new Error("expected a valid result");
    expect(Object.keys(r.patch).sort()).toEqual(["project_manager", "start_date", "target_completion_date"]);
  });
  it("leaving the CURRENT manager unchanged is always allowed, even free text from before this edit existed (a date can be fixed without changing the manager)", () => {
    const r = validateProjectDetails(input({ projectManager: "Fixture Project Manager", startDate: "2026-11-03" }), MEMBERS, "Fixture Project Manager");
    expect(r).toEqual({ ok: true, patch: { project_manager: "Fixture Project Manager", start_date: "2026-11-03", target_completion_date: null } });
  });
  it("but a NEW manager must still be a user of the organisation, and the old free text is not a licence for another one", () => {
    expect(validateProjectDetails(input({ projectManager: "Someone Else" }), MEMBERS, "Fixture Project Manager").ok).toBe(false);
    expect(validateProjectDetails(input({ projectManager: "pm@newquip.co.za" }), MEMBERS, "Fixture Project Manager").ok).toBe(true);
  });
  it("refuses a value that is not text", () => {
    expect(validateProjectDetails({ projectManager: 5 as never, startDate: null, targetCompletionDate: null }, MEMBERS).ok).toBe(false);
    expect(validateProjectDetails({ projectManager: null, startDate: 20261102 as never, targetCompletionDate: null }, MEMBERS).ok).toBe(false);
  });
});
