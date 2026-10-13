import { beforeEach, describe, expect, it, vi } from "vitest";

// Wrong-org access must fail CLOSED and must do so BEFORE any service-role client is created.
const createServiceRoleClient = vi.fn(() => {
  throw new Error("service-role client must not be created for an unauthorised caller");
});
const requireCurrentOrg = vi.fn();
const requireModuleAccess = vi.fn();

vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => createServiceRoleClient() }));
vi.mock("@/lib/current-org", () => ({ requireCurrentOrg: () => requireCurrentOrg() }));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: (h: string) => requireModuleAccess(h) }));

import { discoverGrowerProductsAction, lookupGrowerProductsAction } from "@/app/newquip-grower/actions";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";

const NEWQUIP = "e1aea782-d095-47ad-90fb-4fa65c9bf855";

beforeEach(() => {
  vi.clearAllMocks();
  requireModuleAccess.mockResolvedValue(undefined);
});

describe("wrong org fails closed before service-role access", () => {
  beforeEach(() => requireCurrentOrg.mockResolvedValue({ orgId: "0242e481-0f2b-4bd9-a8ef-2d4a9554bc09", userId: "u", email: null }));

  it("requireNewquipPocOrg throws", async () => {
    await expect(requireNewquipPocOrg()).rejects.toThrow(/isn't available/);
  });
  it("discover returns ok:false and never builds a service-role client", async () => {
    const r = await discoverGrowerProductsAction();
    expect(r.ok).toBe(false);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(requireModuleAccess).not.toHaveBeenCalled();
  });
  it("lookup returns ok:false and never builds a service-role client, whatever SKUs a client sends", async () => {
    const r = await lookupGrowerProductsAction(["X", "Y"]);
    expect(r.ok).toBe(false);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });
});

describe("right org but Quotes module denied fails closed", () => {
  it("does not reach the database", async () => {
    requireCurrentOrg.mockResolvedValue({ orgId: NEWQUIP, userId: "u", email: null });
    requireModuleAccess.mockRejectedValue(new Error("You don't have access to this feature."));
    expect((await lookupGrowerProductsAction(["A"])).ok).toBe(false);
    expect(requireModuleAccess).toHaveBeenCalledWith("/quotes");
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });
});

describe("org scope comes from the server context, not the client", () => {
  it("the actions take no org/instance parameter", () => {
    expect(discoverGrowerProductsAction.length).toBe(0);
    expect(lookupGrowerProductsAction.length).toBe(1); // skus only
  });
  it("not signed in fails closed", async () => {
    requireCurrentOrg.mockRejectedValue(new Error("Not signed in."));
    expect((await discoverGrowerProductsAction()).ok).toBe(false);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });
});
