import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/lemonsqueezy", () => ({
  verifyWebhookSignature: vi.fn(),
  mapSubscriptionStatus: vi.fn(),
}));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));

import { POST } from "@/app/api/webhooks/lemonsqueezy/route";
import { verifyWebhookSignature, mapSubscriptionStatus } from "@/lib/lemonsqueezy";
import { createServiceRoleClient } from "@/supabase/server";

const verifySig = vi.mocked(verifyWebhookSignature);
const mapStatus = vi.mocked(mapSubscriptionStatus);
const serviceClient = vi.mocked(createServiceRoleClient);

const VALID_TOKEN = "tok-abc123";
const ORG_ID = "org-1";

function makeDb(opts: { tokenRow?: { org_id: string } | null; tokenError?: { message: string }; updatedRows?: { id: string }[]; updateError?: { message: string } }) {
  const { tokenRow, tokenError, updatedRows = [{ id: ORG_ID }], updateError } = opts;
  const orGte = vi.fn().mockReturnValue({ select: vi.fn().mockResolvedValue({ data: updatedRows, error: updateError ?? null }) });
  const eqUpdate = vi.fn().mockReturnValue({ or: orGte });
  const update = vi.fn().mockReturnValue({ eq: eqUpdate });

  const maybeSingle = vi.fn().mockResolvedValue({ data: tokenRow ?? null, error: tokenError ?? null });
  const eqToken = vi.fn().mockReturnValue({ maybeSingle });
  const selectToken = vi.fn().mockReturnValue({ eq: eqToken });

  return {
    db: {
      from: (table: string) => {
        if (table === "billing_checkout_tokens") return { select: selectToken };
        if (table === "organizations") return { update };
        throw new Error(`unexpected table ${table}`);
      },
    } as unknown as ReturnType<typeof createServiceRoleClient>,
    update,
  };
}

function req(body: unknown, headers: Record<string, string> = { "x-signature": "sig" }): Request {
  return new Request("https://example.test/api/webhooks/lemonsqueezy", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers,
  });
}

function subscriptionPayload(overrides: Partial<{ event_name: string; token: string | undefined; status: string }> = {}) {
  const { event_name = "subscription_updated", token = VALID_TOKEN, status = "active" } = overrides;
  return {
    meta: { event_name, custom_data: token !== undefined ? { token } : undefined },
    data: {
      id: "sub_123",
      type: "subscriptions",
      attributes: {
        status,
        customer_id: 42,
        renews_at: "2027-01-01T00:00:00Z",
        ends_at: null,
        updated_at: "2026-08-17T00:00:00Z",
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  verifySig.mockReturnValue(true);
  mapStatus.mockReturnValue("active");
});

describe("Lemon Squeezy webhook — security re-audit P1-4", () => {
  it("rejects an invalid signature before touching anything", async () => {
    verifySig.mockReturnValue(false);
    const res = await POST(req(subscriptionPayload()));
    expect(res.status).toBe(401);
    expect(serviceClient).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON", async () => {
    const res = await POST(req("not json"));
    expect(res.status).toBe(400);
  });

  it("rejects a payload that fails schema validation (Zod)", async () => {
    // meta.event_name missing entirely — violates the base schema.
    const res = await POST(req({ meta: {}, data: { id: "x", type: "subscriptions" } }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid webhook payload");
  });

  it("ignores an event outside the known subscription vocabulary without needing a token", async () => {
    const res = await POST(req({ meta: { event_name: "order_created" }, data: { id: "x", type: "orders" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, ignored: "order_created" });
    expect(serviceClient).not.toHaveBeenCalled();
  });

  it("rejects a subscription-typed event with no token in custom_data", async () => {
    const payload = subscriptionPayload();
    payload.meta.custom_data = undefined;
    const res = await POST(req(payload));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("No token");
  });

  it("security re-audit P1-4: rejects an unrecognized token instead of trusting it as an org identifier", async () => {
    const { db } = makeDb({ tokenRow: null });
    serviceClient.mockReturnValue(db);
    const res = await POST(req(subscriptionPayload()));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Unrecognized checkout token");
  });

  it("resolves org_id from the token mapping and updates that org", async () => {
    const { db, update } = makeDb({ tokenRow: { org_id: ORG_ID } });
    serviceClient.mockReturnValue(db);
    const res = await POST(req(subscriptionPayload()));
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ subscription_status: "active", billing_subscription_id: "sub_123" }));
  });

  it("ignores a payment event (non subscription-typed) after resolving the org, without updating", async () => {
    const { db, update } = makeDb({ tokenRow: { org_id: ORG_ID } });
    serviceClient.mockReturnValue(db);
    const res = await POST(
      req({
        meta: { event_name: "subscription_payment_success", custom_data: { token: VALID_TOKEN } },
        data: { id: "inv_1", type: "subscription-invoices", attributes: { status: "paid" } },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.ignored).toContain("not a subscription-typed payload");
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a subscription-typed event whose attributes don't match the expected shape", async () => {
    const { db } = makeDb({ tokenRow: { org_id: ORG_ID } });
    serviceClient.mockReturnValue(db);
    const res = await POST(
      req({
        meta: { event_name: "subscription_updated", custom_data: { token: VALID_TOKEN } },
        data: { id: "sub_1", type: "subscriptions", attributes: { status: "active" /* missing customer_id/updated_at/etc */ } },
      })
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid subscription payload");
  });

  it("security re-audit P1-4: an unrecognized status leaves subscription_status untouched instead of defaulting to canceled", async () => {
    mapStatus.mockReturnValue(null);
    const { db, update } = makeDb({ tokenRow: { org_id: ORG_ID } });
    serviceClient.mockReturnValue(db);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(req(subscriptionPayload({ status: "some_brand_new_status" })));
    expect(res.status).toBe(200);
    const updatePayload = update.mock.calls[0][0];
    expect(updatePayload).not.toHaveProperty("subscription_status");
    // Everything else is still recorded.
    expect(updatePayload).toMatchObject({ billing_subscription_id: "sub_123", billing_customer_id: "42" });
  });

  it("reports a stale (out-of-order) event as skipped rather than an error", async () => {
    const { db } = makeDb({ tokenRow: { org_id: ORG_ID }, updatedRows: [] });
    serviceClient.mockReturnValue(db);
    const res = await POST(req(subscriptionPayload()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, skipped: "stale event" });
  });

  it("surfaces a token-lookup error as a 500", async () => {
    const { db } = makeDb({ tokenError: { message: "db down" } });
    serviceClient.mockReturnValue(db);
    const res = await POST(req(subscriptionPayload()));
    expect(res.status).toBe(500);
  });

  it("surfaces an update error as a 500", async () => {
    const { db } = makeDb({ tokenRow: { org_id: ORG_ID }, updateError: { message: "write failed" } });
    serviceClient.mockReturnValue(db);
    const res = await POST(req(subscriptionPayload()));
    expect(res.status).toBe(500);
  });
});
