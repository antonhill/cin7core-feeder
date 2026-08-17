import crypto from "node:crypto";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { buildCheckoutUrl, createCheckoutToken, verifyWebhookSignature, mapSubscriptionStatus } from "@/lib/lemonsqueezy";
import type { SupabaseClient } from "@supabase/supabase-js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.LEMONSQUEEZY_STORE_SLUG = "cin7toolbox";
  process.env.LEMONSQUEEZY_BUY_LINK_ID = "5e595f34-1efa-4025-8203-4789a221ec33";
  process.env.LEMONSQUEEZY_WEBHOOK_SECRET = "test-secret";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("buildCheckoutUrl — security re-audit P1-4: takes an opaque checkout token, not the raw org_id", () => {
  it("points at the store's hosted checkout for the configured buy link", () => {
    const url = buildCheckoutUrl("tok-1", "anton@sparkconsulting.co.za");
    expect(url).toBe(
      "https://cin7toolbox.lemonsqueezy.com/checkout/buy/5e595f34-1efa-4025-8203-4789a221ec33?checkout%5Bcustom%5D%5Btoken%5D=tok-1&checkout%5Bemail%5D=anton%40sparkconsulting.co.za"
    );
  });

  it("omits the email param when none is known", () => {
    const url = buildCheckoutUrl("tok-1", null);
    expect(url).not.toContain("checkout%5Bemail%5D");
    expect(url).toContain("token%5D=tok-1");
  });

  it("never puts a raw org_id param in the URL", () => {
    const url = buildCheckoutUrl("tok-1", null);
    expect(url).not.toContain("org_id");
  });
});

describe("createCheckoutToken — security re-audit P1-4", () => {
  function makeDb() {
    const insert = vi.fn().mockResolvedValue({ error: null });
    return { db: { from: () => ({ insert }) } as unknown as SupabaseClient, insert };
  }

  it("generates a long, random-looking token and persists it mapped to the org", async () => {
    const { db, insert } = makeDb();
    const token = await createCheckoutToken(db, "org-1");
    expect(token).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes, hex-encoded
    expect(insert).toHaveBeenCalledWith({ token, org_id: "org-1" });
  });

  it("generates a different token on every call", async () => {
    const { db } = makeDb();
    const a = await createCheckoutToken(db, "org-1");
    const b = await createCheckoutToken(db, "org-1");
    expect(a).not.toBe(b);
  });

  it("throws if the insert fails, rather than returning a token that was never persisted", async () => {
    const insert = vi.fn().mockResolvedValue({ error: { message: "db unavailable" } });
    const db = { from: () => ({ insert }) } as unknown as SupabaseClient;
    await expect(createCheckoutToken(db, "org-1")).rejects.toThrow("db unavailable");
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

  it("security re-audit P1-4: returns null (not 'canceled') for a status outside the known vocabulary", () => {
    expect(mapSubscriptionStatus("some_new_status_lemon_squeezy_added_later")).toBeNull();
    expect(mapSubscriptionStatus("")).toBeNull();
  });
});
