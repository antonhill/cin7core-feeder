import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireCurrentOrg } from "@/lib/current-org";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { fetchAvailabilityForSku, fetchSaleForInspection } from "@/cin7/sale-inspect";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { T0_INSTANCE_ID, T0_ORG_ID } from "@/lib/cin7-proof/t0";
import Page from "../page";

class NotFound extends Error {}
vi.mock("next/navigation", () => ({ notFound: () => { throw new NotFound("404"); } }));
vi.mock("@/lib/current-org", () => ({ requireCurrentOrg: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn(() => ({ __db: true })) }));
vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: vi.fn(async () => ({ accountId: "a", applicationKey: "k", baseUrl: "b" })) }));
vi.mock("@/cin7/sale-inspect", () => ({
  fetchAvailabilityForSku: vi.fn(async () => [{ SKU: "NQ2886", Location: "MSTR", OnHand: 1000, Allocated: 0, Available: 1000 }]),
  fetchSaleForInspection: vi.fn(async () => ({})),
}));

const sp = (v?: string) => Promise.resolve(v === undefined ? {} : { sale: v });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireCurrentOrg).mockResolvedValue({ orgId: T0_ORG_ID, userId: "u", email: "m@x" });
  vi.mocked(requireOrgAdmin).mockResolvedValue({} as never);
});

describe("T0 inspector page gating", () => {
  it("another organisation gets a 404 before the admin check or any Cin7 call", async () => {
    vi.mocked(requireCurrentOrg).mockResolvedValue({ orgId: "other", userId: "u", email: null });
    await expect(Page({ searchParams: sp() })).rejects.toBeInstanceOf(NotFound);
    expect(requireOrgAdmin).not.toHaveBeenCalled();
    expect(loadCin7Credentials).not.toHaveBeenCalled();
    expect(fetchAvailabilityForSku).not.toHaveBeenCalled();
  });
  it("a non-manager gets a 404 before any Cin7 call", async () => {
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("Only an org owner or admin"));
    await expect(Page({ searchParams: sp() })).rejects.toBeInstanceOf(NotFound);
    expect(loadCin7Credentials).not.toHaveBeenCalled();
    expect(fetchAvailabilityForSku).not.toHaveBeenCalled();
  });
  it("a manager in the NewQuip POC org reads with the HARD-CODED org and instance, never anything from the URL", async () => {
    await Page({ searchParams: sp() });
    expect(loadCin7Credentials).toHaveBeenCalledWith({ __db: true }, T0_ORG_ID, T0_INSTANCE_ID);
    expect(fetchAvailabilityForSku).toHaveBeenCalledWith(expect.anything(), "NQ2886");
    expect(fetchSaleForInspection).not.toHaveBeenCalled();
  });
  it("with a valid sale parameter it reads exactly that Sale (GET) and nothing else", async () => {
    await Page({ searchParams: sp("11111111-2222-3333-4444-555555555555") });
    expect(fetchSaleForInspection).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetchSaleForInspection).mock.calls[0][1]).toBe("11111111-2222-3333-4444-555555555555");
  });
  it("a malformed sale parameter never reaches Cin7", async () => {
    await Page({ searchParams: sp("not-a-guid; DROP") });
    expect(fetchSaleForInspection).not.toHaveBeenCalled();
  });
});
