import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn(), requireModuleWrite: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/cin7/sale-quote-write", () => ({ createSaleQuote: vi.fn() }));

import { submitQuoteAction } from "../actions";
import { requireModuleWrite } from "@/lib/authorization";
import { createServiceRoleClient } from "@/supabase/server";
import { createSaleQuote } from "@/cin7/sale-quote-write";
import { NEWQUIP_POC_ORG_IDS } from "@/newquip/access";

const db = () => {
  const chain: Record<string, unknown> = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: null, error: null }) };
  return { from: () => chain } as unknown as ReturnType<typeof createServiceRoleClient>;
};
const saved = { ...process.env };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(createServiceRoleClient).mockReturnValue(db()); });
afterEach(() => { process.env = { ...saved }; });

describe("Toolbox Quotes submit honours the NewQuip Cin7 write switch (NewQuip organisation only)", () => {
  it("a NewQuip user is refused before anything is read or sent when writes are off (the default everywhere but the UAT deployment)", async () => {
    vi.mocked(requireModuleWrite).mockResolvedValue({ userId: "u", orgId: NEWQUIP_POC_ORG_IDS[0], email: "s@newquip.co.za" });
    const r = await submitQuoteAction("q1");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/Cin7 writes are switched off/);
    expect(createSaleQuote).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });
  it("still refused when the flag is set but the deployment is not the UAT/Preview one", async () => {
    process.env.NEWQUIP_CIN7_WRITES_ENABLED = "true";
    process.env.VERCEL_ENV = "production"; // no CIN7_CREDENTIAL_STORE=uat
    vi.mocked(requireModuleWrite).mockResolvedValue({ userId: "u", orgId: NEWQUIP_POC_ORG_IDS[0], email: "s@newquip.co.za" });
    expect((await submitQuoteAction("q1")).ok).toBe(false);
    expect(createSaleQuote).not.toHaveBeenCalled();
  });
  it("another organisation is not gated by the NewQuip switch (proceeds to its normal checks)", async () => {
    vi.mocked(requireModuleWrite).mockResolvedValue({ userId: "u", orgId: "some-other-org", email: "a@b.com" });
    const r = await submitQuoteAction("q1");
    expect(r.ok === false && r.error).toBe("Quote not found.");
  });
});
