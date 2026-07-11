import { describe, expect, it, afterEach } from "vitest";
import { toBillingStatus, checkoutAvailableFor } from "@/lib/billing";

const ORIGINAL_STORE_ACTIVE = process.env.LEMONSQUEEZY_STORE_ACTIVE;

afterEach(() => {
  process.env.LEMONSQUEEZY_STORE_ACTIVE = ORIGINAL_STORE_ACTIVE;
});

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

describe("checkoutAvailableFor", () => {
  it("hides checkout for a never-subscribed trial while the LS store isn't active", () => {
    process.env.LEMONSQUEEZY_STORE_ACTIVE = "false";
    expect(checkoutAvailableFor("trialing")).toBe(false);
    expect(checkoutAvailableFor(null)).toBe(false);
  });

  it("shows checkout for a trial too once the store is active", () => {
    process.env.LEMONSQUEEZY_STORE_ACTIVE = "true";
    expect(checkoutAvailableFor("trialing")).toBe(true);
  });

  it("always shows checkout for an org that has ever had a real subscription, regardless of store activation", () => {
    process.env.LEMONSQUEEZY_STORE_ACTIVE = "false";
    expect(checkoutAvailableFor("active")).toBe(true);
    expect(checkoutAvailableFor("past_due")).toBe(true);
    expect(checkoutAvailableFor("canceled")).toBe(true);
  });
});
