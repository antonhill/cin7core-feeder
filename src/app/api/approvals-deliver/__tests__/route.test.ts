import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const deliver = vi.fn(async () => ({ sent: 0, failed: 0, suppressed: 0 })); const remind = vi.fn(async () => ({ reminders: 0 }));
let configured = true;
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => ({}) }));
vi.mock("@/lib/internal-auth", () => ({ assertInternalAuth: vi.fn(), UnauthorizedError: class extends Error {} }));
vi.mock("@/lib/approvals/approval-store", () => ({ deliverPendingEmails: (...a: unknown[]) => (deliver as (...x: unknown[]) => unknown)(...a), sendOverdueReminders: (...a: unknown[]) => (remind as (...x: unknown[]) => unknown)(...a) }));
vi.mock("@/lib/email/resend", () => ({ emailConfigStatus: () => ({ configured, missing: configured ? [] : ["RESEND_API_KEY"], senderDomain: null }) }));
vi.mock("@/lib/approvals/email-policy", () => ({ approvalBaseUrl: () => "https://x.test" }));

describe("the approvals delivery route fails safe", () => {
  beforeEach(() => { deliver.mockClear(); remind.mockClear(); configured = true; vi.resetModules(); });
  it("without an email provider it does nothing: no queue read, no attempt claimed, no reminder created", async () => {
    configured = false; const { GET } = await import("../route");
    const res = await GET(new Request("https://x.test/api/approvals-deliver"));
    expect(await res.json()).toMatchObject({ skipped: "email provider not configured" });
    expect(deliver).not.toHaveBeenCalled(); expect(remind).not.toHaveBeenCalled();
  });
  it("with a provider configured it still runs (the route is unchanged for a deliberately enabled deployment)", async () => {
    const { GET } = await import("../route"); const res = await GET(new Request("https://x.test/api/approvals-deliver"));
    expect(res.status).toBe(200); expect(deliver).toHaveBeenCalledTimes(1); expect(remind).toHaveBeenCalledTimes(1);
  });
  it("the kill switch stops it before anything runs", async () => {
    vi.stubEnv("NEXT_PUBLIC_NEWQUIP_APPROVALS_DISABLED", "1"); const { GET } = await import("../route");
    expect(await (await GET(new Request("https://x.test/api/approvals-deliver"))).json()).toMatchObject({ skipped: "approvals are switched off" });
    expect(deliver).not.toHaveBeenCalled(); vi.unstubAllEnvs();
  });
});

describe("scheduling guard", () => {
  it("/api/approvals-deliver is NOT scheduled in vercel.json: Preview and Production share one notification queue with no environment tag, so a Production cron would deliver, retry or abandon Preview-created mail", () => {
    const crons = (JSON.parse(readFileSync("vercel.json", "utf8")).crons ?? []) as Array<{ path: string }>;
    expect(crons.map((c) => c.path)).not.toContain("/api/approvals-deliver");
  });
});
