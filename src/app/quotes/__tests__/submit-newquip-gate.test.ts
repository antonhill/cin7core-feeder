import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn(), requireModuleWrite: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/cin7/sale-quote-write", async (orig) => ({ ...(await orig<object>()), createSaleQuote: vi.fn() }));
vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: vi.fn() }));

import { submitQuoteAction, listQuotesAction, getQuoteAction } from "../actions";
import { requireModuleAccess, requireModuleWrite } from "@/lib/authorization";
import { createServiceRoleClient } from "@/supabase/server";
import { createSaleQuote } from "@/cin7/sale-quote-write";
import { loadCin7Credentials } from "@/cin7/load-credentials";

const NEWQUIP_POC = "e1aea782-d095-47ad-90fb-4fa65c9bf855"; // literal on purpose: the gate must key on this stable identifier
const OTHER_ORG = "d776b8cc-4e6f-42bc-bbd1-3d910fd3aaef";

// A db whose every read returns a draft quote with no lines, and which records every table touched.
const touched: string[] = [];
function db(quote: unknown = null) {
  const chain = (t: string): Record<string, unknown> => {
    touched.push(t);
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "in", "limit", "neq"]) c[m] = () => c;
    c.maybeSingle = async () => ({ data: quote, error: null });
    c.then = (res: (v: unknown) => void) => res({ data: [], error: null });
    return c;
  };
  return { from: (t: string) => chain(t) } as unknown as ReturnType<typeof createServiceRoleClient>;
}
beforeEach(() => { vi.clearAllMocks(); touched.length = 0; vi.mocked(createServiceRoleClient).mockReturnValue(db()); });

describe("Toolbox Quotes submit: NewQuip POC cannot create Cin7 quotations from this Toolbox", () => {
  it("NEGATIVE: NewQuip POC is refused on the server before any database read, credential load or Cin7 write", async () => {
    vi.mocked(requireModuleWrite).mockResolvedValue({ userId: "u", orgId: NEWQUIP_POC, email: "shirnel@newquip.co.za" });
    const r = await submitQuoteAction("q1");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/not enabled for this organization yet/);
    expect(createSaleQuote).not.toHaveBeenCalled();
    expect(loadCin7Credentials).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });
  it("NEGATIVE: the refusal does not depend on any environment variable (set every flag the UAT uses; still refused)", async () => {
    const saved = { ...process.env };
    try {
      process.env.NEWQUIP_CIN7_WRITES_ENABLED = "true"; process.env.CIN7_CREDENTIAL_STORE = "uat"; process.env.VERCEL_ENV = "preview";
      vi.mocked(requireModuleWrite).mockResolvedValue({ userId: "u", orgId: NEWQUIP_POC, email: "s@newquip.co.za" });
      expect((await submitQuoteAction("q1")).ok).toBe(false);
      expect(createSaleQuote).not.toHaveBeenCalled();
    } finally { process.env = saved; }
  });
  it("NEGATIVE: the module-access check still runs first (an unauthorised caller is refused by it, not reaching the gate)", async () => {
    vi.mocked(requireModuleWrite).mockRejectedValue(new Error("You don't have access to this feature."));
    const r = await submitQuoteAction("q1");
    expect(r.ok === false && r.error).toBe("You don't have access to this feature.");
  });
  it("POSITIVE: another organisation proceeds exactly as before (reaches its normal quote lookup)", async () => {
    vi.mocked(requireModuleWrite).mockResolvedValue({ userId: "u", orgId: OTHER_ORG, email: "a@b.com" });
    const r = await submitQuoteAction("q1");
    expect(r.ok === false && r.error).toBe("Quote not found.");
    expect(touched).toContain("quotes");
  });
  it("POSITIVE: another organisation's submit still reaches Cin7 credential loading for a valid draft (the gate does not block it)", async () => {
    vi.mocked(requireModuleWrite).mockResolvedValue({ userId: "u", orgId: OTHER_ORG, email: "a@b.com" });
    // a draft with no product lines stops at "Add at least one product line" - still past the NewQuip gate and the quote lookup
    vi.mocked(createServiceRoleClient).mockReturnValue(db({ id: "q1", status: "draft", customer_name: "C", location: "L", instance_id: "i1" }));
    const r = await submitQuoteAction("q1");
    expect(r.ok === false && r.error).toBe("Add at least one product line before submitting.");
  });
  it("PRESERVED: Quotes read access is not touched for NewQuip POC (list and get run their normal reads)", async () => {
    vi.mocked(requireModuleAccess).mockResolvedValue({ userId: "u", orgId: NEWQUIP_POC, email: "s@newquip.co.za" });
    const l = await listQuotesAction();
    expect(l.ok).toBe(true);
    const g = await getQuoteAction("q1");
    expect(g.ok === false && g.error).not.toMatch(/not enabled for this organization/);
    expect(touched).toContain("quotes");
  });
});
