import { describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { applyEmailPolicy, PRODUCTION_EMAIL_FLAG, PRODUCTION_EMAIL_OFF, PREVIEW_EMAIL_ALLOWLIST, productionEmailBlocked, productionEmailEnabled } from "../email-policy";
import { deliverForQuote, deliverPendingEmails, retryAndDispatchEmail, sendPendingNow } from "../approval-store";

vi.mock("server-only", () => ({}));

// NewQuip email in Production needs an EXPLICIT opt-in. A configured provider key alone must never be enough, because Preview and Production share one database and queue.
const ORG = "org-nq";
const PROD = { VERCEL_ENV: "production" };                       // key configured, opt-in absent
const PROD_ON = { VERCEL_ENV: "production", [PRODUCTION_EMAIL_FLAG]: "true" };
const PREVIEW = { VERCEL_ENV: "preview" };
const mail = (db: FakeDb, id: string, to: string, over: Record<string, unknown> = {}) => {
  const r = { id, org_id: ORG, request_id: "rq-1", event_id: null, kind: "SUBMITTED", recipient_email: to, channel: "EMAIL", subject: "NewQuip Quotation NQ-Q-1: submitted", body: "Open it.", dedupe_key: id, status: "PENDING", attempts: 0, last_error: null, provider_message_id: null, sent_at: null, read_at: null, created_at: "2026-10-29T07:00:00Z", quote_id: "q1", ...over };
  (db.rows("approval_notifications") as unknown[]).push(r); return r;
};
const ok = () => vi.fn(async (_i: unknown) => ({ ok: true, messageId: "msg-1" }));
const status = (db: FakeDb, id: string) => (db.rows("approval_notifications") as Array<Record<string, any>>).find((r) => r.id === id)!; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("the policy decision", () => {
  it("only the exact string 'true' enables Production email; every other value, and absence, is OFF", () => {
    expect(productionEmailEnabled({ [PRODUCTION_EMAIL_FLAG]: "true" })).toBe(true);
    for (const v of [undefined, "", "TRUE", "True", "1", "yes", "on", " true", "true ", "false"]) expect(productionEmailEnabled({ [PRODUCTION_EMAIL_FLAG]: v }), String(v)).toBe(false);
  });
  it("Production without the opt-in SUPPRESSES every address (a real customer, an internal user, even an allowlisted tester); with it Production behaves as before", () => {
    for (const to of ["customer@farm.example", "rep@sparkconsulting.co.za", ...PREVIEW_EMAIL_ALLOWLIST]) {
      expect(applyEmailPolicy(PROD, { to, subject: "S", text: "T" })).toEqual({ action: "SUPPRESS", reason: PRODUCTION_EMAIL_OFF });
      expect(applyEmailPolicy(PROD_ON, { to, subject: "S", text: "T" })).toEqual({ action: "SEND", subject: "S", text: "T" });
    }
  });
  it("the opt-in does nothing outside Production: Preview, local and unknown environments keep the allowlist, [PREVIEW] marking and banner", () => {
    for (const env of [PREVIEW, { ...PREVIEW, [PRODUCTION_EMAIL_FLAG]: "true" }, {}, { VERCEL_ENV: "development", [PRODUCTION_EMAIL_FLAG]: "true" }, { VERCEL_ENV: "Production" }]) {
      expect(productionEmailBlocked(env)).toBe(false);
      expect(applyEmailPolicy(env, { to: "customer@farm.example", subject: "S", text: "T" }).action).toBe("SUPPRESS");              // not on the allowlist
      const d = applyEmailPolicy(env, { to: "anton@sparkconsulting.co.za", subject: "S", text: "T" });
      expect(d.action).toBe("SEND"); if (d.action === "SEND") expect(d.subject.startsWith("[PREVIEW] ")).toBe(true);
    }
  });
});

describe("approval notification delivery (inline, scheduled worker, manager send-pending, manager retry)", () => {
  it("with the provider configured but NO opt-in, nothing reaches the provider on any path, and queued rows are terminally suppressed (never left to be sent later by a keyed Production)", async () => {
    const db = new FakeDb(); db.approvalsApplied = true; db.notificationStatuses.push("SUPPRESSED");
    mail(db, "a", "customer@farm.example"); mail(db, "b", "rep@sparkconsulting.co.za"); mail(db, "c", "anton@sparkconsulting.co.za", { status: "FAILED", attempts: 1 });
    const send = ok();
    const ctx = { orgId: ORG, userId: "u", email: "mgr@a", name: "M", isManager: true, baseUrl: "https://x" } as never;
    expect(await deliverPendingEmails(db as never, send as never, 50, { env: PROD })).toEqual({ sent: 0, failed: 0, suppressed: 3 });
    mail(db, "d", "customer@farm.example", { quote_id: "q2" }); mail(db, "e", "customer@farm.example", { status: "FAILED", attempts: 2 });
    expect(await deliverForQuote(db as never, ORG, "q2", send as never, PROD)).toEqual({ sent: 0, failed: 0, suppressed: 1 });
    expect(await sendPendingNow(db as never, ctx, send as never, PROD)).toMatchObject({ sent: 0 });
    expect(await retryAndDispatchEmail(db as never, ctx, "e", send as never, PROD)).toMatchObject({ sent: 0, suppressed: 1 });
    expect(send).not.toHaveBeenCalled();
    for (const id of ["a", "b", "c", "d", "e"]) expect(status(db, id).status, id).toBe("SUPPRESSED");
    expect(status(db, "a").last_error).toBe(PRODUCTION_EMAIL_OFF);
    // Now Production is opted in: the earlier rows are NOT revived (terminal), so a stale Preview-made row cannot leak out later
    expect(await deliverPendingEmails(db as never, send as never, 50, { env: PROD_ON })).toEqual({ sent: 0, failed: 0, suppressed: 0 });
    expect(send).not.toHaveBeenCalled();
  });
  it("with the explicit opt-in Production delivers as it did before (no prefix, no allowlist)", async () => {
    const db = new FakeDb(); db.approvalsApplied = true; mail(db, "a", "customer@farm.example");
    const send = ok(); expect(await deliverPendingEmails(db as never, send as never, 50, { env: PROD_ON })).toEqual({ sent: 1, failed: 0, suppressed: 0 });
    expect((send.mock.calls[0][0] as { subject: string }).subject).toBe("NewQuip Quotation NQ-Q-1: submitted"); expect(status(db, "a").status).toBe("SENT");
  });
  it("Preview delivery is unchanged by the new control", async () => {
    const db = new FakeDb(); db.approvalsApplied = true; db.notificationStatuses.push("SUPPRESSED");
    mail(db, "a", "anton@sparkconsulting.co.za"); mail(db, "b", "customer@farm.example");
    const send = ok(); expect(await deliverPendingEmails(db as never, send as never, 50, { env: { ...PREVIEW, [PRODUCTION_EMAIL_FLAG]: "true" } })).toEqual({ sent: 1, failed: 0, suppressed: 1 });
    expect((send.mock.calls[0][0] as { subject: string }).subject.startsWith("[PREVIEW] ")).toBe(true);
  });
});
