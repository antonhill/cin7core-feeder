import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const update = vi.fn();
const eqChain = { eq: vi.fn() };
vi.mock("@/lib/require-privileged", () => ({ requirePrivilegedSuperAdmin: vi.fn(async () => ({ userId: "u1" })) }));
vi.mock("@/supabase/server-session", () => ({ createSessionClient: async () => ({ auth: { getUser: async () => ({ data: { user: { email: "a@x.test" } } }) } }) }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("@/cin7/crypto", () => ({ encrypt: (s: string) => `enc(${s.length})` }));
vi.mock("@/cin7/client", () => ({ testConnection: vi.fn(async () => ({ ok: true, status: 200, message: "Connected successfully." })) }));
vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: vi.fn(async () => ({ name: "n", accountId: "a", applicationKey: "k", baseUrl: "b" })) }));
vi.mock("@/supabase/server", () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      select: () => ({ eq: async () => ({ data: [{ id: "i1", name: "NewQuip POC", account_id: "acc", application_key_encrypted_uat: null }], error: null }) }),
      update: (v: unknown) => { update(v); return { eq: () => ({ eq: async () => ({ error: null }) }) }; },
    }),
  }),
}));

import { saveUatCin7Key, getUatCredentialStatus, testUatCin7Connection } from "../actions";
import { requirePrivilegedSuperAdmin } from "@/lib/require-privileged";
import { logActivity } from "@/lib/activity-log";

const original = process.env.CIN7_CREDENTIAL_STORE;
beforeEach(() => { vi.clearAllMocks(); process.env.CIN7_CREDENTIAL_STORE = "uat"; void eqChain; });
afterEach(() => { if (original === undefined) delete process.env.CIN7_CREDENTIAL_STORE; else process.env.CIN7_CREDENTIAL_STORE = original; });

describe("UAT-only Cin7 credential administration", () => {
  it("is unavailable outside the UAT deployment and writes nothing", async () => {
    delete process.env.CIN7_CREDENTIAL_STORE;
    const r = await saveUatCin7Key("abcdefgh12345678");
    expect(r.ok).toBe(false);
    expect(update).not.toHaveBeenCalled();
    expect((await getUatCredentialStatus()).ok).toBe(false);
  });

  it("requires a privileged super-admin (two-factor)", async () => {
    vi.mocked(requirePrivilegedSuperAdmin).mockRejectedValueOnce(new Error("Two-factor authentication is required"));
    const r = await saveUatCin7Key("abcdefgh12345678");
    expect(r.ok).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it("writes only the UAT column, never the Toolbox one, and never audits the key", async () => {
    const key = "SECRET-APPLICATION-KEY-123";
    const r = await saveUatCin7Key(`  ${key}  `);
    expect(r.ok).toBe(true);
    const written = update.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(["application_key_encrypted_uat", "updated_at"]);
    expect(JSON.stringify(vi.mocked(logActivity).mock.calls)).not.toContain(key);
    expect(JSON.stringify(r)).not.toContain(key);
  });

  it("rejects an implausible key without writing", async () => {
    expect((await saveUatCin7Key("short")).ok).toBe(false);
    expect((await saveUatCin7Key("has space inside key")).ok).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });

  it("status never includes the key", async () => {
    const s = await getUatCredentialStatus();
    expect(s).toEqual({ ok: true, instanceName: "NewQuip POC", accountId: "acc", configured: false });
  });

  it("connection test refuses when no UAT key is saved", async () => {
    expect((await testUatCin7Connection()).ok).toBe(false);
  });
});
