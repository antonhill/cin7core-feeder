import { describe, it, expect } from "vitest";
import { writeAllowedFor } from "@/lib/billing-status";

describe("writeAllowedFor", () => {
  it("permits Cin7 writes only on an active subscription", () => {
    expect(writeAllowedFor("active")).toBe(true);
  });

  it("denies writes on trial / lapsed states (which the MFA rule treats as exempt)", () => {
    expect(writeAllowedFor("trialing")).toBe(false);
    expect(writeAllowedFor("past_due")).toBe(false);
    expect(writeAllowedFor("canceled")).toBe(false);
  });
});
