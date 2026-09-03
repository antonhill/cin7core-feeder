import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { upsertInstance, deleteInstance } from "@/app/settings/instances/actions";
// Moved to the Diagnostics capability — see settings/diagnostics/actions.ts.
// The assertions below are unchanged; only the import path moved with them.
import {
  debugTestCreatePurchaseOrder,
  debugPushOneCustomerAndSupplier,
  debugTestSaleShipByWriteBack,
  debugTestProductSupplierLink,
} from "@/app/settings/diagnostics/actions";
import { requirePrivilegedOrgAdmin, requirePrivilegedSuperAdmin } from "@/lib/require-privileged";
import { requireCurrentOrg } from "@/lib/current-org";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { createServiceRoleClient } from "@/supabase/server";
import { getBillingStatus } from "@/lib/billing";
import { logActivity } from "@/lib/activity-log";
import { testCreatePurchaseOrder, testSaleShipByWriteBack, testProductSupplierLink } from "@/cin7/debug";
import { pushCustomer } from "@/cin7/customers";
import { pushSupplier } from "@/cin7/suppliers";
import { Cin7ApiError } from "@/cin7/http";

vi.mock("@/lib/require-privileged", () => ({ requirePrivilegedOrgAdmin: vi.fn(), requirePrivilegedSuperAdmin: vi.fn() }));
vi.mock("@/lib/current-org", () => ({ requireCurrentOrg: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/lib/billing", () => ({ getBillingStatus: vi.fn() }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn() }));
vi.mock("@/cin7/crypto", () => ({ encrypt: vi.fn((v: string) => `enc:${v}`), decrypt: vi.fn(() => "decrypted-key-plaintext") }));
vi.mock("@/cin7/client", () => ({ testConnection: vi.fn() }));
vi.mock("@/cin7/debug", () => ({
  findProductWithBom: vi.fn(),
  probeWorkCentrePaths: vi.fn(),
  findCustomerAndSupplierExamples: vi.fn(),
  checkCustomerReferenceFields: vi.fn(),
  checkSupplierReferenceFields: vi.fn(),
  findCustomerRawByName: vi.fn(),
  findAccountsByCodes: vi.fn(),
  checkSaleStatuses: vi.fn(),
  findFinishedGoodsExample: vi.fn(),
  surveyFinishedGoodsFields: vi.fn(),
  surveyCostBasisFields: vi.fn(),
  surveyProductionBomFields: vi.fn(),
  surveyProductionBomForSkus: vi.fn(),
  surveyProductionOrderDetail: vi.fn(),
  surveyProductionOrderRoutingTasks: vi.fn(),
  surveyProductionOrderOperationStatus: vi.fn(),
  surveyProductionRun: vi.fn(),
  surveyProductionOrderStatuses: vi.fn(),
  surveyPurchaseDetailFields: vi.fn(),
  surveyProductAvailabilityFields: vi.fn(),
  surveySaleFulfillmentFields: vi.fn(),
  surveyBackorderEtaFields: vi.fn(),
  testSaleShipByWriteBack: vi.fn(),
  testProductSupplierLink: vi.fn(),
  surveyProductSupplierOptionsFields: vi.fn(),
  findProductSupplierOptionsExample: vi.fn(),
  testCreatePurchaseOrder: vi.fn(),
  checkProductAvailabilityForSkus: vi.fn(),
  checkProductSupplierOptionsForUnparsedFields: vi.fn(),
  probeUpdatedSinceFiltering: vi.fn(),
}));
vi.mock("@/cin7/customers", () => ({ pushCustomer: vi.fn() }));
vi.mock("@/cin7/suppliers", () => ({ pushSupplier: vi.fn() }));

const CURRENT_ORG = { userId: "u1", orgId: "org1", email: "admin@example.com" };
const SUPER = { userId: "super1" };

/**
 * Generic thenable/chainable Supabase query-builder stand-in: every chain
 * method returns itself, and awaiting the chain resolves to `result`. Covers
 * .select/.eq/.order/.limit/.insert/.update/.delete plus a terminal
 * .single()/.maybeSingle(), matching every shape this file's actions
 * actually build. When `result.data` is an array (the shape a plain
 * `.select().eq().order()` list query resolves to, e.g. listInstances' own
 * query), `.single()`/`.maybeSingle()` pull the first row out of it — the
 * same array can serve both a list read and a single-row read of the same
 * table within one test, since upsertInstance/deleteInstance always end by
 * calling listInstances() themselves.
 */
function chain(result: unknown) {
  const asSingle = () => {
    const r = result as { data: unknown; error: unknown };
    if (r && Array.isArray(r.data)) return Promise.resolve({ data: r.data[0] ?? null, error: r.error });
    return Promise.resolve(result);
  };
  const obj: Record<string, unknown> = {
    select: () => obj,
    eq: () => obj,
    order: () => obj,
    limit: () => obj,
    single: asSingle,
    maybeSingle: asSingle,
    insert: () => obj,
    update: () => obj,
    delete: () => obj,
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return obj;
}

/** Routes db.from(table) to a canned response; unlisted tables return {data: null, error: null}. */
function fakeDb(responses: Record<string, unknown> = {}) {
  return { from: (table: string) => chain(responses[table] ?? { data: null, error: null }) };
}

beforeEach(() => {
  vi.mocked(requirePrivilegedOrgAdmin).mockReset().mockResolvedValue(CURRENT_ORG);
  vi.mocked(requirePrivilegedSuperAdmin).mockReset().mockResolvedValue(SUPER);
  vi.mocked(requireCurrentOrg).mockReset().mockResolvedValue(CURRENT_ORG);
  vi.mocked(requireOrgAdmin).mockReset().mockResolvedValue(CURRENT_ORG);
  vi.mocked(getBillingStatus).mockReset().mockResolvedValue({ maxInstances: 5 } as never);
  vi.mocked(logActivity).mockReset().mockResolvedValue(undefined);
  vi.mocked(createServiceRoleClient).mockReset();
});

describe("security closure Blocker 2: every debug* action must directly enforce requirePrivilegedSuperAdmin (permanent regression guard)", () => {
  // The debug* actions moved to the Diagnostics capability (see
  // settings/diagnostics/actions.ts). This guard follows them: the invariant
  // it protects is "every debug* action enforces requirePrivilegedSuperAdmin
  // in its own body", not the file they happen to live in.
  const source = fs.readFileSync(path.join(process.cwd(), "src/app/settings/diagnostics/actions.ts"), "utf8");
  const sigRe = /^export async function (debug\w+)\(/gm;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = sigRe.exec(source))) names.push(m[1]);

  it("finds at least the known 31 debug* exports (fails loudly if the file couldn't be read/parsed, rather than silently passing on zero matches)", () => {
    expect(names.length).toBeGreaterThanOrEqual(31);
  });

  it.each(names.map((n) => [n]))("%s calls requirePrivilegedSuperAdmin( directly in its own body", (name) => {
    const startIdx = source.indexOf(`export async function ${name}(`);
    expect(startIdx).toBeGreaterThanOrEqual(0);
    const nextTopLevelFn = source.indexOf("\nexport async function ", startIdx + 1);
    const body = source.slice(startIdx, nextTopLevelFn === -1 ? source.length : nextTopLevelFn);
    expect(body).toContain("requirePrivilegedSuperAdmin(");
  });

  it("does NOT rely on loadInstanceCreds'/requireOrgAdmin's org-admin check as the only guard — no debug* body calls requireOrgAdmin as its first authorization step without also calling requirePrivilegedSuperAdmin", () => {
    for (const name of names) {
      const startIdx = source.indexOf(`export async function ${name}(`);
      const nextTopLevelFn = source.indexOf("\nexport async function ", startIdx + 1);
      const body = source.slice(startIdx, nextTopLevelFn === -1 ? source.length : nextTopLevelFn);
      const privilegedIdx = body.indexOf("requirePrivilegedSuperAdmin(");
      const orgAdminIdx = body.indexOf("requireOrgAdmin(");
      expect(privilegedIdx).toBeGreaterThanOrEqual(0);
      // requireOrgAdmin( may still appear (loadInstanceCreds calls it internally,
      // or a function fetches its own orgId via requireCurrentOrg) but the
      // privileged guard must never appear strictly AFTER a direct requireOrgAdmin(
      // call within the same body — that would mean org-admin was checked first.
      if (orgAdminIdx >= 0) expect(privilegedIdx).toBeLessThan(orgAdminIdx);
    }
  });
});

describe("upsertInstance — security closure Blocker 3: credential CRUD audit trail", () => {
  it("logs instance.create on a successful create, never including the raw application key", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(
      fakeDb({
        cin7_instances: {
          data: [{ id: "inst-1", name: "New Instance", account_id: "acc-1", application_key_encrypted: "enc", active: true, created_at: "2026-01-01", fulfilment_view_start_date: null }],
          error: null,
        },
      }) as never
    );
    const result = await upsertInstance({ name: "New Instance", accountId: "acc-1", applicationKey: "SUPER-SECRET-KEY", active: true });
    expect(result.ok).toBe(true);
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: "org1", instanceId: "inst-1", action: "instance.create" })
    );
    const call = vi.mocked(logActivity).mock.calls[0][1];
    expect(JSON.stringify(call)).not.toContain("SUPER-SECRET-KEY");
  });

  it("logs instance.create as failed when the insert errors", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(
      fakeDb({ cin7_instances: { data: null, error: { message: "insert failed" } } }) as never
    );
    const result = await upsertInstance({ name: "New Instance", accountId: "acc-1", applicationKey: "key", active: true });
    expect(result.ok).toBe(false);
    expect(logActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "instance.create" }));
    const detail = vi.mocked(logActivity).mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.outcome).toBe("failed");
  });

  it("logs instance.update on a successful key rotation, flagging rotatedKey without logging the key itself", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(
      fakeDb({
        cin7_instances: {
          data: [{ id: "inst-1", name: "Renamed", account_id: "acc-1", application_key_encrypted: "enc", active: true, created_at: "2026-01-01", fulfilment_view_start_date: null }],
          error: null,
        },
      }) as never
    );
    const result = await upsertInstance({ instanceId: "inst-1", name: "Renamed", accountId: "acc-1", applicationKey: "ROTATED-SECRET", active: true });
    expect(result.ok).toBe(true);
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: "org1", instanceId: "inst-1", action: "instance.update" })
    );
    const call = vi.mocked(logActivity).mock.calls[0][1];
    expect(JSON.stringify(call)).not.toContain("ROTATED-SECRET");
    expect((call.detail as Record<string, unknown>).rotatedKey).toBe(true);
  });

  it("logs instance.update as failed when the update errors", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(
      fakeDb({ cin7_instances: { data: null, error: { message: "update failed" } } }) as never
    );
    const result = await upsertInstance({ instanceId: "inst-1", name: "Renamed", accountId: "acc-1", active: true });
    expect(result.ok).toBe(false);
    const detail = vi.mocked(logActivity).mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.outcome).toBe("failed");
  });
});

describe("deleteInstance — security closure Blocker 3: credential CRUD audit trail", () => {
  it("logs instance.delete on success", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(fakeDb({ cin7_instances: { data: null, error: null } }) as never);
    await deleteInstance("inst-1");
    expect(logActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: "org1", instanceId: "inst-1", action: "instance.delete" })
    );
    const detail = vi.mocked(logActivity).mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.outcome).toBe("success");
  });

  it("logs instance.delete as failed when the delete errors", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(
      fakeDb({ cin7_instances: { data: null, error: { message: "delete failed" } } }) as never
    );
    await deleteInstance("inst-1");
    const detail = vi.mocked(logActivity).mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.outcome).toBe("failed");
  });
});

describe("debugTestCreatePurchaseOrder — security closure Blockers 2+3: guard enforcement + honest outcome logging", () => {
  const VALID_INPUT = "SKU1,Supplier Co,2,Main Warehouse";

  it("rejects before any Cin7 call or audit log when requirePrivilegedSuperAdmin denies (not merely an org admin)", async () => {
    vi.mocked(requirePrivilegedSuperAdmin).mockRejectedValue(new Error("Not authorized."));
    const result = await debugTestCreatePurchaseOrder("inst-1", VALID_INPUT);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Not authorized/);
    expect(testCreatePurchaseOrder).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  // Security re-audit adversarial-verification fix: testCreatePurchaseOrder
  // NEVER rejects in the real implementation — tryPurchaseRequest/
  // tryPurchaseOrderLines catch their own Cin7ApiError internally and
  // return `{succeeded: false, ...}` in the `attempts` array. Mocking a
  // rejection (the previous version of these tests) doesn't exercise the
  // real code path at all; these tests now mock the real resolved shape.

  it("logs a success outcome when at least one attempt actually succeeded", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(
      fakeDb({ cin7_instances: { data: { account_id: "acc", application_key_encrypted: "enc" }, error: null } }) as never
    );
    vi.mocked(testCreatePurchaseOrder).mockResolvedValue({
      attempts: [{ shape: "s1", endpoint: "/purchase", succeeded: true, linesPopulatedIn: "Order" }],
    } as never);
    const result = await debugTestCreatePurchaseOrder("inst-1", VALID_INPUT);
    expect(result.ok).toBe(true);
    const detail = vi.mocked(logActivity).mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.outcome).toBe("success");
  });

  it("logs an 'ambiguous' outcome (not flat 'failed') when every attempt fails but at least one was ambiguous", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(
      fakeDb({ cin7_instances: { data: { account_id: "acc", application_key_encrypted: "enc" }, error: null } }) as never
    );
    vi.mocked(testCreatePurchaseOrder).mockResolvedValue({
      attempts: [{ shape: "s1", endpoint: "/purchase", succeeded: false, error: "network lost", ambiguous: true }],
    } as never);
    const result = await debugTestCreatePurchaseOrder("inst-1", VALID_INPUT);
    expect(result.ok).toBe(true); // the diagnostic ITSELF completed; the write outcome is reported via the log/message
    const detail = vi.mocked(logActivity).mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.outcome).toBe("ambiguous");
  });

  it("logs a definite 'failed' outcome (not 'ambiguous') when every attempt fails and none were ambiguous", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(
      fakeDb({ cin7_instances: { data: { account_id: "acc", application_key_encrypted: "enc" }, error: null } }) as never
    );
    vi.mocked(testCreatePurchaseOrder).mockResolvedValue({
      attempts: [{ shape: "s1", endpoint: "/purchase", succeeded: false, error: "rejected", ambiguous: false }],
    } as never);
    const result = await debugTestCreatePurchaseOrder("inst-1", VALID_INPUT);
    expect(result.ok).toBe(true);
    const detail = vi.mocked(logActivity).mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.outcome).toBe("failed");
  });

  it("does NOT log a false 'success' when testCreatePurchaseOrder resolves normally but every attempt actually failed — the exact bug an adversarial verification pass found", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(
      fakeDb({ cin7_instances: { data: { account_id: "acc", application_key_encrypted: "enc" }, error: null } }) as never
    );
    vi.mocked(testCreatePurchaseOrder).mockResolvedValue({
      attempts: [
        { shape: "s1", endpoint: "/purchase", succeeded: false, error: "bad request", ambiguous: false },
        { shape: "s2", endpoint: "/advanced-purchase", succeeded: false, error: "bad request", ambiguous: false },
      ],
    } as never);
    await debugTestCreatePurchaseOrder("inst-1", VALID_INPUT);
    const detail = vi.mocked(logActivity).mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.outcome).not.toBe("success");
    expect(detail.outcome).toBe("failed");
  });
});

describe("debugTestSaleShipByWriteBack — security closure Blocker 3 adversarial-verification fix", () => {
  it("logs 'success' only when the real PUT actually succeeded (putSucceeded: true)", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(
      fakeDb({ cin7_instances: { data: { account_id: "acc", application_key_encrypted: "enc" }, error: null } }) as never
    );
    vi.mocked(testSaleShipByWriteBack).mockResolvedValue({
      saleId: "s1",
      orderNumber: "SO-1",
      shipByTested: null,
      putSucceeded: true,
      unexpectedChanges: [],
    } as never);
    await debugTestSaleShipByWriteBack("inst-1", "SO-1");
    const detail = vi.mocked(logActivity).mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.outcome).toBe("success");
  });

  it("does NOT log a false 'success' when the underlying PUT failed (putSucceeded: false) — testSaleShipByWriteBack resolves normally on failure, it never throws", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(
      fakeDb({ cin7_instances: { data: { account_id: "acc", application_key_encrypted: "enc" }, error: null } }) as never
    );
    vi.mocked(testSaleShipByWriteBack).mockResolvedValue({
      saleId: "s1",
      orderNumber: "SO-1",
      shipByTested: null,
      putSucceeded: false,
      putError: "[400] validation failed",
      unexpectedChanges: [],
    } as never);
    await debugTestSaleShipByWriteBack("inst-1", "SO-1");
    const detail = vi.mocked(logActivity).mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.outcome).toBe("failed");
    expect(detail.putError).toBe("[400] validation failed");
  });
});

describe("debugTestProductSupplierLink — security closure Blocker 3 adversarial-verification fix", () => {
  const VALID_INPUT = "SKU1,Supplier Co";

  it("logs 'success' only when at least one attempt actually succeeded", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(
      fakeDb({ cin7_instances: { data: { account_id: "acc", application_key_encrypted: "enc" }, error: null } }) as never
    );
    vi.mocked(testProductSupplierLink).mockResolvedValue({
      sku: "SKU1",
      supplierName: "Supplier Co",
      supplierFound: true,
      fullRecordHadId: true,
      attempts: [{ shape: "ID + SupplierName", succeeded: true }],
    } as never);
    await debugTestProductSupplierLink("inst-1", VALID_INPUT);
    const detail = vi.mocked(logActivity).mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.outcome).toBe("success");
  });

  it("does NOT log a false 'success' when every attempt failed — testProductSupplierLink resolves normally on failure, it never throws", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(
      fakeDb({ cin7_instances: { data: { account_id: "acc", application_key_encrypted: "enc" }, error: null } }) as never
    );
    vi.mocked(testProductSupplierLink).mockResolvedValue({
      sku: "SKU1",
      supplierName: "Supplier Co",
      supplierFound: true,
      fullRecordHadId: true,
      attempts: [
        { shape: "ID + SupplierName", succeeded: false, error: "Suppliers is invalid" },
        { shape: "ID only", succeeded: false, error: "Suppliers is invalid" },
      ],
    } as never);
    await debugTestProductSupplierLink("inst-1", VALID_INPUT);
    const detail = vi.mocked(logActivity).mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.outcome).toBe("failed");
  });
});

describe("debugPushOneCustomerAndSupplier — security closure Blocker 3: combined-outcome audit trail", () => {
  it("logs an overall 'ambiguous' outcome when only the supplier push is ambiguous", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(
      fakeDb({
        cin7_instances: { data: { account_id: "acc", application_key_encrypted: "enc" }, error: null },
        customers: { data: { name: "Acme" }, error: null },
        suppliers: { data: { name: "Box Co" }, error: null },
        customer_addresses: { data: [], error: null },
        customer_contacts: { data: [], error: null },
        supplier_addresses: { data: [], error: null },
        supplier_contacts: { data: [], error: null },
      }) as never
    );
    vi.mocked(pushCustomer).mockResolvedValue({ succeeded: true } as never);
    vi.mocked(pushSupplier).mockRejectedValue(new Cin7ApiError(0, "network lost", false, true));

    const result = await debugPushOneCustomerAndSupplier("inst-1");
    expect(result.ok).toBe(true); // per-entity errors are captured in the result payload, not thrown
    const detail = vi.mocked(logActivity).mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.customerOutcome).toBe("success");
    expect(detail.supplierOutcome).toBe("ambiguous");
    expect((vi.mocked(logActivity).mock.calls[0][1] as { summary: string }).summary).toMatch(/ambiguous/);
  });

  it("logs an overall 'success' outcome when both pushes succeed", async () => {
    vi.mocked(createServiceRoleClient).mockReturnValue(
      fakeDb({
        cin7_instances: { data: { account_id: "acc", application_key_encrypted: "enc" }, error: null },
        customers: { data: { name: "Acme" }, error: null },
        suppliers: { data: { name: "Box Co" }, error: null },
        customer_addresses: { data: [], error: null },
        customer_contacts: { data: [], error: null },
        supplier_addresses: { data: [], error: null },
        supplier_contacts: { data: [], error: null },
      }) as never
    );
    vi.mocked(pushCustomer).mockResolvedValue({ succeeded: true } as never);
    vi.mocked(pushSupplier).mockResolvedValue({ succeeded: true } as never);

    await debugPushOneCustomerAndSupplier("inst-1");
    const detail = vi.mocked(logActivity).mock.calls[0][1].detail as Record<string, unknown>;
    expect(detail.customerOutcome).toBe("success");
    expect(detail.supplierOutcome).toBe("success");
  });
});
