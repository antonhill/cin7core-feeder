import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { resolveActing } from "@/lib/demo-mode/context";
import { sendEmail } from "@/lib/email/resend";

// The REAL Approvals -> Delivery server actions over an in-memory database; only the session, Demo Mode resolution and the provider call are replaced.
// Proves: every Delivery action is refused while a Demo identity is active; the test send obeys the Preview policy; retry / send-pending are manager-only.
let db: FakeDb;
vi.mock("server-only", () => ({}));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/lib/projects/newquip-gate", () => ({ assertNewquipOrg: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/email/resend", () => ({ sendEmail: vi.fn(async () => ({ ok: true, messageId: "msg-1" })), emailConfigStatus: () => ({ configured: true, missing: [], senderDomain: "example.test" }) }));
vi.mock("@/lib/demo-mode/context", async (orig) => ({ ...(await orig<typeof import("@/lib/demo-mode/context")>()), resolveActing: vi.fn() }));
import * as approvals from "../actions";

const ORG = "org-nq";
const real = (email: string) => vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: ORG, userId: "u1", email } as never);
const acting = (email: string, demo: boolean, tier: "admin" | "member" = "admin") => vi.mocked(resolveActing).mockResolvedValue({ orgId: ORG, userId: "u1", email, tier: demo ? tier : null, demo: demo ? { ownerUserId: "owner", ownerEmail: "testing@sparkconsulting.co.za", actorName: "[DEMO] Rep", slot: "rep" } : null } as never);
const admin = (yes: boolean) => vi.mocked(requireOrgAdmin).mockImplementation(async () => { if (!yes) throw new Error("not admin"); return undefined as never; });
const failedRow = () => { (db.rows("approval_notifications") as unknown[]).push({ id: "n1", org_id: ORG, request_id: "r1", kind: "SUBMITTED", recipient_email: "manager@sparkconsulting.co.za", channel: "EMAIL", subject: "S", body: "B", dedupe_key: "k1", status: "FAILED", attempts: 1, last_error: "x", created_at: "2026-10-29T08:00:00Z" }); };

beforeEach(() => { db = new FakeDb(); db.approvalsApplied = true; vi.mocked(sendEmail).mockClear(); vi.stubEnv("VERCEL_ENV", "preview"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("Demo Mode cannot operate email delivery", () => {
  it("every Delivery action is refused for a demo identity, even a demo Manager, and nothing is sent or changed", async () => {
    failedRow(); real("testing@sparkconsulting.co.za"); acting("manager@sparkconsulting.co.za", true, "admin"); admin(true);
    for (const r of [await approvals.retryEmailAction("n1"), await approvals.sendPendingNowAction(), await approvals.sendTestEmailAction(), await approvals.getEmailStatusAction()]) expect(r.error).toMatch(/not available in Demo Mode/);
    expect(sendEmail).not.toHaveBeenCalled();
    expect((db.rows("approval_notifications") as Array<Record<string, unknown>>)[0]).toMatchObject({ status: "FAILED", attempts: 1 });
  });
});

describe("Delivery actions (real session, no Demo Mode)", () => {
  it("the test send goes only to an allowlisted manager, marked [PREVIEW]; a non-listed manager's test is suppressed and reaches no provider", async () => {
    real("adm@a"); acting("adm@a", false); admin(true);
    const blocked = await approvals.sendTestEmailAction();
    expect(blocked).toMatchObject({ ok: true, data: { accepted: false, suppressed: true, to: "adm@a" } });
    expect(sendEmail).not.toHaveBeenCalled();
    real("manager@sparkconsulting.co.za"); acting("manager@sparkconsulting.co.za", false);
    const sent = await approvals.sendTestEmailAction();
    expect(sent).toMatchObject({ ok: true, data: { accepted: true, to: "manager@sparkconsulting.co.za" } });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendEmail).mock.calls[0][0]).toMatchObject({ to: ["manager@sparkconsulting.co.za"] });
    expect(vi.mocked(sendEmail).mock.calls[0][0].subject.startsWith("[PREVIEW] ")).toBe(true);
  });
  it("Retry dispatches the selected email once and reports the outcome; Send pending now sends only queued mail", async () => {
    failedRow(); real("manager@sparkconsulting.co.za"); acting("manager@sparkconsulting.co.za", false); admin(true);
    const r = await approvals.retryEmailAction("n1");
    expect(r).toMatchObject({ ok: true, data: { sent: 1, failed: 0, suppressed: 0 } });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((await approvals.retryEmailAction("n1")).error).toMatch(/not a failed email/);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(await approvals.sendPendingNowAction()).toMatchObject({ ok: true, data: { sent: 0, failed: 0, suppressed: 0 } });
  });
  it("a non-manager can neither retry nor send pending nor read the delivery status", async () => {
    failedRow(); real("rep@sparkconsulting.co.za"); acting("rep@sparkconsulting.co.za", false); admin(false);
    expect((await approvals.retryEmailAction("n1")).error).toMatch(/Only a manager/);
    expect((await approvals.sendPendingNowAction()).error).toMatch(/Only a manager/);
    expect((await approvals.getEmailStatusAction()).error).toMatch(/Only a manager/);
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it("the status reports the policy, the allowlist and the link base, never a secret", async () => {
    real("manager@sparkconsulting.co.za"); acting("manager@sparkconsulting.co.za", false); admin(true);
    vi.stubEnv("VERCEL_BRANCH_URL", "branch.vercel.app"); vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    const s = await approvals.getEmailStatusAction();
    expect(s.data).toMatchObject({ configured: true, restricted: true, linkBase: "https://branch.vercel.app" });
    expect(s.data!.allowlist).toEqual(["testing@sparkconsulting.co.za", "rep@sparkconsulting.co.za", "estimator@sparkconsulting.co.za", "manager@sparkconsulting.co.za"]);
    expect(JSON.stringify(s)).not.toMatch(/re_[A-Za-z0-9]{8,}/);
  });
});

describe("existing Toolbox email workflows are unaffected", () => {
  it("the shared sender knows nothing of the NewQuip policy, and the ship-by and BOM senders call it directly", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (f: string) => readFileSync(`${process.cwd()}/${f}`, "utf8");
    expect(read("src/lib/email/resend.ts")).not.toMatch(/email-policy|PREVIEW|allowlist/i);
    for (const f of ["src/lib/ship-by-notifications.ts", "src/lib/bom-alerts.ts"]) {
      expect(read(f)).toMatch(/from "@\/lib\/email\/resend"/);
      expect(read(f)).not.toMatch(/email-policy/);
    }
  });
});
