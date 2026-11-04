import { describe, expect, it } from "vitest";
import { DEMO_TERMS, applyDemoTerms } from "../demo-terms";
import type { CompanyProfile } from "../company-profile";

const ORG = "e1aea782-d095-47ad-90fb-4fa65c9bf855";
const profile = { brandName: "NewQuip", legalName: "NewQuip Agri Supplies (Pty) Ltd", vatNumber: "1", paymentTerms: "Real", deliveryInstallationConditions: "Real", termsAndConditions: "Real", acceptanceInstructions: "Real" } as unknown as CompanyProfile;

describe("demonstration-only quotation wording", () => {
  it("replaces only the four texts, only for NQ-Q-0025 in the NewQuip organisation", () => {
    const p = applyDemoTerms(profile, ORG, "NQ-Q-0025");
    expect(p).toMatchObject(DEMO_TERMS);
    expect(p.legalName).toBe(profile.legalName);
    expect(p.vatNumber).toBe("1");
  });
  it("also covers the Rep-start demonstration quotation NQ-Q-0026", () => {
    expect(applyDemoTerms(profile, ORG, "NQ-Q-0026")).toMatchObject(DEMO_TERMS);
  });
  it.each([["NQ-Q-0024", ORG], ["NQ-Q-0017", ORG], ["NQ-Q-0025", "00000000-0000-4000-8000-000000000000"]])("leaves %s in %s untouched", (ref, org) => {
    expect(applyDemoTerms(profile, org, ref)).toBe(profile);
  });
  it("does not mutate the shared profile", () => {
    applyDemoTerms(profile, ORG, "NQ-Q-0025");
    expect(profile.paymentTerms).toBe("Real");
  });
});
