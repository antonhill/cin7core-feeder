import { describe, expect, it, vi, beforeEach } from "vitest";
import { listInstances, upsertInstance, deleteInstance, testInstanceConnection } from "@/app/settings/instances/actions";
import { requireModuleAccess } from "@/lib/authorization";
import { requirePrivilegedOrgAdmin, requireAal2 } from "@/lib/require-privileged";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireWriteAllowed, getBillingStatus } from "@/lib/billing";
import { createServiceRoleClient } from "@/supabase/server";
import { encrypt } from "@/cin7/crypto";
import { testConnection } from "@/cin7/client";
import { logActivity } from "@/lib/activity-log";

vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-privileged", () => ({ requirePrivilegedOrgAdmin: vi.fn(), requirePrivilegedSuperAdmin: vi.fn(), requireAal2: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/lib/billing", () => ({ requireWriteAllowed: vi.fn(), getBillingStatus: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/cin7/crypto", () => ({ encrypt: vi.fn(() => "enc"), decrypt: vi.fn(() => "dec") }));
vi.mock("@/cin7/client", () => ({ testConnection: vi.fn() }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn() }));

const ORG = { orgId: "org1", userId: "u1", email: "a@b.c" };
const MODULE_DENIED = "This module is not enabled for your organization.";

beforeEach(() => {
  vi.mocked(requireModuleAccess).mockReset().mockResolvedValue(ORG as never);
  vi.mocked(requirePrivilegedOrgAdmin).mockReset().mockResolvedValue(ORG as never);
  vi.mocked(requireOrgAdmin).mockReset().mockResolvedValue(ORG as never);
  vi.mocked(requireWriteAllowed).mockReset();
  vi.mocked(requireAal2).mockReset();
  vi.mocked(getBillingStatus).mockReset().mockResolvedValue({ maxInstances: 5 } as never);
  vi.mocked(createServiceRoleClient).mockReset();
  vi.mocked(encrypt).mockClear();
  vi.mocked(testConnection).mockReset();
  vi.mocked(logActivity).mockReset().mockResolvedValue(undefined);
});

/** Every action is exercised with the module gate denied while every other guard is left passing, so only the module gate can stop it. */
describe("Cin7 Instances actions require the Instances module before any protected work", () => {
  beforeEach(() => {
    vi.mocked(requireModuleAccess).mockRejectedValue(new Error(MODULE_DENIED));
  });

  it("LIST: module denied → no DB read, and the privileged role helper is never reached", async () => {
    const result = await listInstances();
    expect(result.ok).toBe(false);
    expect(result.error).toBe(MODULE_DENIED);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(requirePrivilegedOrgAdmin).not.toHaveBeenCalled();
  });

  it("UPSERT: module denied → no DB write, no credential encryption, no activity write", async () => {
    const result = await upsertInstance({ name: "X", accountId: "A", applicationKey: "K", active: true });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(MODULE_DENIED);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(encrypt).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
    expect(requirePrivilegedOrgAdmin).not.toHaveBeenCalled();
  });

  it("DELETE: module denied → no DB delete, no activity write", async () => {
    const result = await deleteInstance("inst-1");
    expect(result.ok).toBe(false);
    expect(result.error).toBe(MODULE_DENIED);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
    expect(requirePrivilegedOrgAdmin).not.toHaveBeenCalled();
  });

  it("TEST CONNECTION: module denied → no credential DB read, no live Cin7 call", async () => {
    const result = await testInstanceConnection("inst-1");
    expect(result.ok).toBe(false);
    expect(result.message).toContain(MODULE_DENIED);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(testConnection).not.toHaveBeenCalled();
    // The role check lives inside loadInstanceCreds, which is never reached.
    expect(requireOrgAdmin).not.toHaveBeenCalled();
  });
});

describe("existing role and assurance semantics are preserved", () => {
  it("the three privileged actions still require privileged org-admin once the module passes", async () => {
    vi.mocked(requirePrivilegedOrgAdmin).mockRejectedValue(new Error("Only an org owner or admin can manage Cin7 instances."));

    for (const call of [() => listInstances(), () => deleteInstance("i"), () => upsertInstance({ name: "X", accountId: "A", applicationKey: "K", active: true })]) {
      const r = await call();
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/owner or admin/);
    }
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("testInstanceConnection gains NO assurance requirement of its own", async () => {
    vi.mocked(testConnection).mockResolvedValue({ ok: true, status: 200, message: "ok" } as never);
    vi.mocked(createServiceRoleClient).mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { account_id: "A", application_key_encrypted: "E" }, error: null }) }) }) }) }),
    } as never);

    const r = await testInstanceConnection("inst-1");

    expect(r.ok).toBe(true);
    expect(requireModuleAccess).toHaveBeenCalledWith("/settings/instances");
    expect(requireAal2).not.toHaveBeenCalled();
    expect(requireWriteAllowed).not.toHaveBeenCalled();
  });
});
