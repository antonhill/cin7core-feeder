import crypto from "node:crypto";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { buildCheckoutUrl, verifyWebhookSignature, mapSubscriptionStatus } from "@/lib/lemonsqueezy";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.LEMONSQUEEZY_STORE_SLUG = "cin7toolbox";
  process.env.LEMONSQUEEZY_VARIANT_ID = "12345";
  process.env.LEMONSQUEEZY_WEBHOOK_SECRET = "test-secret";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("buildCheckoutUrl", () => {
  it("points at the store's hosted checkout for the configured variant", () => {
    const url = buildCheckoutUrl("org-1", "anton@sparkconsulting.co.za");
    expect(url).toBe(
      "https://cin7toolbox.lemonsqueezy.com/buy/12345?checkout%5Bcustom%5D%5Borg_id%5D=org-1&checkout%5Bemail%5D=anton%40sparkconsulting.co.za"
    );
  });

  it("omits the email param when none is known", () => {
    const url = buildCheckoutUrl("org-1", null);
    expect(url).not.toContain("checkout%5Bemail%5D");
    expect(url).toContain("org_id%5D=org-1");
  });
});

describe("verifyWebhookSignature", () => {
  function sign(body: string): string {
    return crypto.createHmac("sha256", "test-secret").update(body).digest("hex");
  }

  it("accepts a signature that matches the body", () => {
    const body = JSON.stringify({ meta: { event_name: "subscription_created" } });
    expect(verifyWebhookSignature(body, sign(body))).toBe(true);
  });

  it("rejects a signature computed over a different body", () => {
    const body = JSON.stringify({ meta: { event_name: "subscription_created" } });
    const tamperedBody = JSON.stringify({ meta: { event_name: "subscription_cancelled" } });
    expect(verifyWebhookSignature(tamperedBody, sign(body))).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyWebhookSignature("{}", null)).toBe(false);
  });

  it("rejects a signature of the wrong length rather than throwing", () => {
    expect(verifyWebhookSignature("{}", "abcd")).toBe(false);
  });
});

describe("mapSubscriptionStatus", () => {
  it("treats active and on_trial as active", () => {
    expect(mapSubscriptionStatus("active")).toBe("active");
    expect(mapSubscriptionStatus("on_trial")).toBe("active");
  });

  it("treats past_due and unpaid as past_due", () => {
    expect(mapSubscriptionStatus("past_due")).toBe("past_due");
    expect(mapSubscriptionStatus("unpaid")).toBe("past_due");
  });

  it("treats cancelled, expired, and paused as canceled", () => {
    expect(mapSubscriptionStatus("cancelled")).toBe("canceled");
    expect(mapSubscriptionStatus("expired")).toBe("canceled");
    expect(mapSubscriptionStatus("paused")).toBe("canceled");
  });
});
