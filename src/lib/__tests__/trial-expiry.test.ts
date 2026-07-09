import { describe, expect, it } from "vitest";
import { isEligibleForTrialAutoDeletion, trialAutoDeletionDate } from "@/lib/trial-expiry";

describe("isEligibleForTrialAutoDeletion", () => {
  const now = new Date("2026-07-09T00:00:00Z");

  it("is not eligible before the 14-day grace period has passed", () => {
    const trialEndsAt = "2026-06-26T00:00:00Z"; // 13 days before `now`
    expect(isEligibleForTrialAutoDeletion("trialing", trialEndsAt, now)).toBe(false);
  });

  it("is eligible once the 14-day grace period has passed", () => {
    const trialEndsAt = "2026-06-24T00:00:00Z"; // 15 days before `now`
    expect(isEligibleForTrialAutoDeletion("trialing", trialEndsAt, now)).toBe(true);
  });

  it("is never eligible for active/past_due/canceled orgs, no matter how old trial_ends_at is", () => {
    const longExpired = "2020-01-01T00:00:00Z";
    expect(isEligibleForTrialAutoDeletion("active", longExpired, now)).toBe(false);
    expect(isEligibleForTrialAutoDeletion("past_due", longExpired, now)).toBe(false);
    expect(isEligibleForTrialAutoDeletion("canceled", longExpired, now)).toBe(false);
  });

  it("is not eligible when trial_ends_at is null", () => {
    expect(isEligibleForTrialAutoDeletion("trialing", null, now)).toBe(false);
  });
});

describe("trialAutoDeletionDate", () => {
  it("is exactly 14 days after trial_ends_at", () => {
    const result = trialAutoDeletionDate("2026-06-24T00:00:00Z");
    expect(result.toISOString()).toBe("2026-07-08T00:00:00.000Z");
  });
});
