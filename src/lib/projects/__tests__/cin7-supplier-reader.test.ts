import { beforeEach, describe, expect, it, vi } from "vitest";

// The read-only Cin7 supplier reader: ONE shared read of the catalogue for concurrent callers, a short cache per organisation and instance, and a failure that is never cached (and never becomes "not found").
vi.mock("server-only", () => ({}));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => ({}) }));
const fetchAll = vi.fn();
vi.mock("@/cin7/suppliers", () => ({ fetchAllSuppliers: (...a: unknown[]) => fetchAll(...a) }));
vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: vi.fn(async () => ({ accountId: "a", applicationKey: "k", baseUrl: "u", name: "n" })) }));
vi.mock("@/cin7/latest-cost", () => ({ fetchProductCostRead: vi.fn() }));
import { clearSupplierCache, cin7IdentityLookups, listCin7Suppliers } from "../latest-cost-adapter";

const rows = [{ ID: "S1", Name: "Alpha", Status: "Active", Currency: "ZAR" }, { ID: "S2", Name: "Old", Status: "Deprecated", Currency: "" }];
const db = {} as never;
beforeEach(() => { clearSupplierCache(); fetchAll.mockReset(); fetchAll.mockResolvedValue(rows); });

describe("listCin7Suppliers", () => {
  it("concurrent callers share ONE read of the catalogue", async () => {
    const [a, b, c] = await Promise.all([listCin7Suppliers(db, "org", "inst"), listCin7Suppliers(db, "org", "inst"), listCin7Suppliers(db, "org", "inst")]);
    expect(fetchAll).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b); expect(b).toEqual(c);
    expect(a.map((s) => [s.id, s.currency, s.active])).toEqual([["S1", "ZAR", true], ["S2", null, false]]);
  });
  it("is cached for two minutes per organisation and instance, then read again; another organisation never shares it", async () => {
    const t0 = 1_000_000;
    await listCin7Suppliers(db, "org", "inst", t0);
    await listCin7Suppliers(db, "org", "inst", t0 + 119_000);
    expect(fetchAll).toHaveBeenCalledTimes(1);
    await listCin7Suppliers(db, "org", "inst", t0 + 121_000);
    expect(fetchAll).toHaveBeenCalledTimes(2);
    await listCin7Suppliers(db, "other-org", "inst", t0 + 121_000);
    expect(fetchAll).toHaveBeenCalledTimes(3);
  });
  it("a failed read is not cached, and the lookup says 'unavailable' (never 'not found')", async () => {
    fetchAll.mockRejectedValueOnce(new Error("fetch failed"));
    expect(await cin7IdentityLookups(db, "org", "inst").supplier("S1")).toEqual({ status: "unavailable" });
    expect(await cin7IdentityLookups(db, "org", "inst").supplier("S1")).toEqual({ status: "ok", value: { id: "S1", name: "Alpha", currency: "ZAR", active: true } });
    expect(await cin7IdentityLookups(db, "org", "inst").supplier("NOPE")).toEqual({ status: "ok", value: null });
  });
});
