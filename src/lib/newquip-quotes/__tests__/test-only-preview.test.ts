import { describe, expect, it } from "vitest";
import { describeProfileProblems, emptyProfile, missingProfileFields, profileProblems, type CompanyProfile } from "../company-profile";

const demo: CompanyProfile = {
  brandName: "NewQuip", legalName: "NewQuip Agri Supplies (Pty) Ltd", registrationNumber: "22/222222/22", vatNumber: "12121212121", addressLines: ["34 Renico Crescent", "Stormill"],
  phone: "011-45454545", email: "a@b.co.za", website: "", validityDays: 10, paymentTerms: "Test", deliveryInstallationConditions: "Test", termsAndConditions: "Terms", acceptanceInstructions: "Please do this",
};

describe("profile problems: precise reasons", () => {
  it("the demo profile fails the STRICT gate on the four terms (placeholder) and the repeated-digit registration number (invalid), never as 'missing'", () => {
    const p = profileProblems(demo);
    expect(p.map((x) => x.field).sort()).toEqual(["acceptanceInstructions", "deliveryInstallationConditions", "paymentTerms", "registrationNumber", "termsAndConditions"]);
    expect(p.find((x) => x.field === "registrationNumber")?.reason).toBe("invalid");
    expect(p.filter((x) => x.field !== "registrationNumber").every((x) => x.reason === "placeholder")).toBe(true);
    expect(describeProfileProblems(p).join(" ")).not.toMatch(/missing/);
    expect(missingProfileFields(demo)).toHaveLength(5);
  });
  it("a real but short value is 'too short', a blank value is 'missing'", () => {
    expect(profileProblems({ ...demo, paymentTerms: "Net 30 days" }).find((x) => x.field === "paymentTerms")?.reason).toBe("too_short");
    expect(profileProblems({ ...demo, paymentTerms: "" }).find((x) => x.field === "paymentTerms")?.reason).toBe("missing");
  });
  it("the lenient (preview) check tolerates placeholder text but still needs a buildable profile; the strict check is unchanged", () => {
    expect(profileProblems(demo, { lenient: true })).toEqual([]);
    expect(profileProblems(emptyProfile(), { lenient: true }).length).toBeGreaterThan(0);
    expect(profileProblems({ ...demo, email: "nope" }, { lenient: true }).map((x) => x.field)).toEqual(["email"]);
    expect(missingProfileFields(demo).length).toBe(5); // strict still blocks issuing
  });
});
