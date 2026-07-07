import { describe, expect, it } from "vitest";
import { toBillingStatus } from "@/lib/billing";

describe("toBillingStatus", () => {
  it("blocks writes for the entire trial, not just once trial_ends_at passes", () => {
    const future = toBillingStatus({ subscription_status: "trialing", trial_ends_at: "2099-01-01T00:00:00Z", max_instances: 1 });
    const past = toBillingStatus({ subscription_status: "trialing", trial_ends_at: "2000-01-01T00:00:00Z", max_instances: 1 });
    expect(future.canWrite).toBe(false);
    expect(past.canWrite).toBe(false);
  });

  it("allows writes only when status is active", () => {
    const status = toBillingStatus({ subscription_status: "active", trial_ends_at: "2000-01-01T00:00:00Z", max_instances: 2147483647 });
    expect(status.canWrite).toBe(true);
  });

  it("blocks writes for past_due and canceled — same read-only degradation as a trial", () => {
    expect(toBillingStatus({ subscription_status: "past_due", trial_ends_at: "2000-01-01T00:00:00Z", max_instances: 5 }).canWrite).toBe(false);
    expect(toBillingStatus({ subscription_status: "canceled", trial_ends_at: "2000-01-01T00:00:00Z", max_instances: 5 }).canWrite).toBe(false);
  });

  it("passes through the raw fields unchanged", () => {
    const status = toBillingStatus({ subscription_status: "trialing", trial_ends_at: "2026-07-14T00:00:00Z", max_instances: 1 });
    expect(status.status).toBe("trialing");
    expect(status.trialEndsAt).toBe("2026-07-14T00:00:00Z");
    expect(status.maxInstances).toBe(1);
  });
});
