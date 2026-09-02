import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  mergeCategoryAction,
  mergeBrandAction,
  mergeUOMAction,
  mergeTagAction,
  applyProductFixesAction,
  applyAttributeTemplateAction,
  applySupplierAssignmentAction,
  applyPartyFixesAction,
  runProductAuditAction,
} from "@/app/audit/actions";
import { requireModuleAccess } from "@/lib/authorization";
import { requireWriteAllowed } from "@/lib/billing";
import { requireAal2 } from "@/lib/require-privileged";
import { createServiceRoleClient } from "@/supabase/server";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import {
  applyProductFixes,
  mergeCategoryNames,
  mergeBrandNames,
  mergeUOMNames,
  mergeTagNames,
  applyAttributeTemplate,
  applySupplierAssignment,
} from "@/audit/apply-fixes";
import { applyPartyFixes } from "@/audit/apply-party-fixes";
import { logActivity } from "@/lib/activity-log";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { fetchAllProductsWithBom } from "@/cin7/products";
import { fetchAllSuppliers } from "@/cin7/suppliers";
import { runProductAudit } from "@/audit/product-audit";

vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/billing", () => ({ requireWriteAllowed: vi.fn() }));
vi.mock("@/lib/require-privileged", () => ({ requireAal2: vi.fn(), requirePrivilegedOrgAdmin: vi.fn(), requirePrivilegedSuperAdmin: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: vi.fn() }));
vi.mock("@/cin7/products", () => ({ fetchAllProductsWithBom: vi.fn() }));
vi.mock("@/cin7/customers", () => ({ fetchAllCustomers: vi.fn() }));
vi.mock("@/cin7/suppliers", () => ({ fetchAllSuppliers: vi.fn() }));
vi.mock("@/audit/product-audit", () => ({ runProductAudit: vi.fn() }));
vi.mock("@/audit/party-audit", () => ({ runPartyAudit: vi.fn() }));
vi.mock("@/audit/apply-fixes", () => ({
  applyProductFixes: vi.fn(),
  mergeCategoryNames: vi.fn(),
  mergeBrandNames: vi.fn(),
  mergeUOMNames: vi.fn(),
  mergeTagNames: vi.fn(),
  applyAttributeTemplate: vi.fn(),
  applySupplierAssignment: vi.fn(),
}));
vi.mock("@/audit/apply-party-fixes", () => ({ applyPartyFixes: vi.fn() }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn() }));

const CURRENT_ORG = { orgId: "org1", userId: "u1", email: "a@b.c" };
const OK_RESULT = { succeeded: 3, failed: [] };

/** The four actions that make up the "merge near-duplicates" write family. */
const MERGE_ACTIONS = [
  { label: "category", action: mergeCategoryAction, merge: mergeCategoryNames, logAction: "audit.merge_category" },
  { label: "brand", action: mergeBrandAction, merge: mergeBrandNames, logAction: "audit.merge_brand" },
  { label: "UOM", action: mergeUOMAction, merge: mergeUOMNames, logAction: "audit.merge_uom" },
  { label: "tag", action: mergeTagAction, merge: mergeTagNames, logAction: "audit.merge_tag" },
];

/**
 * The other four Data Audit write families. ADR-0015 classifies every one of
 * these as member-permitted with NO added assurance — each acts on an
 * explicit, already-displayed target list, unlike merge.
 */
const NON_AAL2_WRITE_FAMILIES = [
  { name: "bulk product field set", run: () => applyProductFixesAction("inst-1", [{ productId: "p1", fields: { Brand: "Acme" } }]), cin7: applyProductFixes },
  { name: "attribute template copy", run: () => applyAttributeTemplateAction("inst-1", "tpl-1", ["p1", "p2"]), cin7: applyAttributeTemplate },
  { name: "supplier assignment", run: () => applySupplierAssignmentAction("inst-1", "Box Shop", ["p1"]), cin7: applySupplierAssignment },
  { name: "bulk party field set", run: () => applyPartyFixesAction("inst-1", "customer", [{ partyId: "c1", fields: { Tags: "vip" } }] as never), cin7: applyPartyFixes },
];

beforeEach(() => {
  vi.mocked(requireModuleAccess).mockReset().mockResolvedValue(CURRENT_ORG as never);
  vi.mocked(requireWriteAllowed).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(requireAal2).mockReset().mockResolvedValue(undefined);
  vi.mocked(requireOrgAdmin).mockReset();
  vi.mocked(createServiceRoleClient).mockReset().mockReturnValue({} as never);
  vi.mocked(loadCin7Credentials).mockReset().mockResolvedValue({ accountId: "acct" } as never);
  vi.mocked(logActivity).mockReset().mockResolvedValue(undefined);
  for (const fn of [applyProductFixes, mergeCategoryNames, mergeBrandNames, mergeUOMNames, mergeTagNames, applyAttributeTemplate, applySupplierAssignment]) {
    vi.mocked(fn).mockReset().mockResolvedValue(OK_RESULT as never);
  }
  vi.mocked(applyPartyFixes).mockReset().mockResolvedValue({ succeeded: 1, failed: [] } as never);
  vi.mocked(fetchAllProductsWithBom).mockReset().mockResolvedValue([] as never);
  vi.mocked(fetchAllSuppliers).mockReset().mockResolvedValue([] as never);
  vi.mocked(runProductAudit).mockReset().mockReturnValue({ issues: [] } as never);
});

describe("CCT-ADR-0015: Data Audit merge near-duplicates requires AAL2", () => {
  it.each(MERGE_ACTIONS)("1+2. $label merge reaches the AAL2 boundary and a member with AAL2 may proceed", async ({ label, action, merge }) => {
    const result = await action("inst-1", ["Old"], "New");

    expect(result.ok).toBe(true);
    expect(requireAal2).toHaveBeenCalledTimes(1);
    expect(requireAal2).toHaveBeenCalledWith(`merge ${label} values`);
    expect(merge).toHaveBeenCalledTimes(1);
    expect(requireOrgAdmin).not.toHaveBeenCalled();
  });

  it.each(MERGE_ACTIONS)("3. $label merge without AAL2 is blocked BEFORE any live mutation", async ({ action, merge }) => {
    vi.mocked(requireAal2).mockRejectedValue(new Error("Two-factor authentication is required to merge category values."));

    const result = await action("inst-1", ["Old"], "New");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Two-factor authentication is required/);
    expect(merge).not.toHaveBeenCalled();
    // ...and before credentials were even loaded.
    expect(loadCin7Credentials).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it.each(MERGE_ACTIONS)("4. $label merge fails CLOSED when assurance cannot be read", async ({ action, merge }) => {
    vi.mocked(requireAal2).mockRejectedValue(new Error("Could not verify two-factor authentication status: network"));

    const result = await action("inst-1", ["Old"], "New");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Could not verify two-factor authentication status/);
    expect(merge).not.toHaveBeenCalled();
    expect(loadCin7Credentials).not.toHaveBeenCalled();
  });

  it.each(MERGE_ACTIONS)("5. $label merge does NOT require an admin role", async ({ action }) => {
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("Only owners and admins can do this."));

    const result = await action("inst-1", ["Old"], "New");

    expect(result.ok).toBe(true);
    expect(requireOrgAdmin).not.toHaveBeenCalled();
  });

  it.each(MERGE_ACTIONS)("7. $label merge still hands target selection to the merge helper — no pre-resolved target list", async ({ action, merge }) => {
    await action("inst-1", ["Old A", "Old B"], "Keep Me");

    // The action passes the raw from/to names straight through; which
    // products get rewritten is still resolved by the helper's own live
    // re-fetch at execution time, exactly as before this guard.
    expect(merge).toHaveBeenCalledWith({ accountId: "acct" }, ["Old A", "Old B"], "Keep Me");
  });

  it.each(MERGE_ACTIONS)("8. $label merge activity logging is unchanged", async ({ action, logAction, label }) => {
    await action("inst-1", ["Old"], "New");

    expect(logActivity).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logActivity).mock.calls[0][1]).toMatchObject({
      orgId: "org1",
      instanceId: "inst-1",
      action: logAction,
      summary: `Merged ${label}s "Old" into "New" (3 succeeded)`,
      detail: { fromNames: ["Old"], toName: "New", failed: [] },
    });
  });
});

describe("CCT-ADR-0015: the other four Data Audit write families do NOT gain AAL2", () => {
  it.each(NON_AAL2_WRITE_FAMILIES)("6. $name stays member-only with no added assurance", async ({ run, cin7 }) => {
    // Assurance is unavailable — if this family had inherited the merge
    // requirement (e.g. via a check pushed into a shared helper), it would
    // now fail closed. ADR-0015 says it must not.
    vi.mocked(requireAal2).mockRejectedValue(new Error("Two-factor authentication is required."));

    const result = await run();

    expect(result.ok).toBe(true);
    expect(requireAal2).not.toHaveBeenCalled();
    expect(cin7).toHaveBeenCalledTimes(1);
    expect(requireOrgAdmin).not.toHaveBeenCalled();
    // The module and billing gates they already had are untouched.
    expect(requireModuleAccess).toHaveBeenCalledTimes(1);
    expect(requireWriteAllowed).toHaveBeenCalledTimes(1);
  });

  it("6b. the read-only product audit scan gains no assurance or billing gate", async () => {
    vi.mocked(requireAal2).mockRejectedValue(new Error("Two-factor authentication is required."));

    const result = await runProductAuditAction("inst-1");

    expect(result.ok).toBe(true);
    expect(requireAal2).not.toHaveBeenCalled();
    expect(requireWriteAllowed).not.toHaveBeenCalled();
  });
});
