import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn(), requireModuleWrite: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/cin7/sale-quote-write", async (orig) => ({ ...(await orig<object>()), createSaleQuote: vi.fn(), findSaleByExternalId: vi.fn() }));
vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: vi.fn() }));
vi.mock("@/cin7/customers", () => ({ fetchCustomerDefaults: vi.fn() }));
vi.mock("@/cin7/reference-lookups", async (orig) => ({ ...(await orig<object>()), fetchAllTaxRules: vi.fn() }));
vi.mock("@/lib/quote-submit", () => ({
  claimQuoteCreation: vi.fn(), settleQuoteCreation: vi.fn(), releaseQuoteCreation: vi.fn(), markQuoteCreationAmbiguous: vi.fn(), discardQuoteClaim: vi.fn(), QUOTE_CLAIM_TTL_SECONDS: 600,
}));

import { submitQuoteAction } from "../actions";
import { requireModuleWrite } from "@/lib/authorization";
import { createServiceRoleClient } from "@/supabase/server";
import { createSaleQuote, buildQuoteBody } from "@/cin7/sale-quote-write";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchCustomerDefaults } from "@/cin7/customers";
import { fetchAllTaxRules } from "@/cin7/reference-lookups";
import { claimQuoteCreation, settleQuoteCreation } from "@/lib/quote-submit";

const NEWQUIP_POC = "e1aea782-d095-47ad-90fb-4fa65c9bf855";
const POC_INSTANCE = "30eac8f2-d55c-486c-be70-a5f2d778a761";
const OTHER_INSTANCE = "99999999-9999-4999-8999-999999999999";
const REF = "pnzwjqjovxxdikxtfngq";
const WIRED = { SUPABASE_URL: `https://${REF}.supabase.co`, NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co` };

const quote = (over: Record<string, unknown> = {}) => ({ id: "q1", status: "draft", customer_name: "Test Customer", location: "Main", instance_id: POC_INSTANCE, tax_inclusive: false, price_tier: null, sales_rep: null, notes: "", overall_margin_pct: 20, estimated_gp: 100, margin_revenue_ex_tax: 500, margin_scope: "all", ...over });
const lines = [
  { line_number: 1, line_type: "product", product_sku: "NQ3444", product_name: "PVC door", quantity: 2, unit_price: 1000, discount_pct: 0 },
  { line_number: 2, line_type: "product", product_sku: "CON001", product_name: "Panel", quantity: 1, unit_price: 500, discount_pct: 10 },
  { line_number: 3, line_type: "charge", product_sku: null, product_name: "Freight", quantity: 1, unit_price: 350, discount_pct: 0 },
];
const writes: string[] = [];
function db(q: unknown, l: unknown[] = lines) {
  return { from: (t: string) => {
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "in", "limit", "neq", "insert", "delete"]) c[m] = () => c;
    c.update = () => { writes.push(t); return c; };
    c.maybeSingle = async () => ({ data: q, error: null });
    c.then = (res: (v: unknown) => void) => res({ data: t === "quote_lines" ? l : [], error: null });
    return c;
  } } as unknown as ReturnType<typeof createServiceRoleClient>;
}
const saved = { ...process.env };
function env(over: Record<string, string | undefined>) { process.env = { ...saved, ...WIRED, VERCEL_ENV: "preview", ...over } as NodeJS.ProcessEnv; }
beforeEach(() => {
  vi.clearAllMocks(); writes.length = 0; process.env = { ...saved };
  vi.mocked(requireModuleWrite).mockResolvedValue({ userId: "u", orgId: NEWQUIP_POC, email: "shirnel@newquip.co.za" });
  vi.mocked(createServiceRoleClient).mockReturnValue(db(quote()));
  vi.mocked(loadCin7Credentials).mockResolvedValue({} as never);
  vi.mocked(fetchCustomerDefaults).mockResolvedValue({ taxRule: "VAT 15%", revenueAccount: "200" } as never);
  vi.mocked(fetchAllTaxRules).mockResolvedValue([{ name: "VAT 15%", rate: 15 }] as never);
  vi.mocked(claimQuoteCreation).mockResolvedValue({ claimed: true } as never);
  vi.mocked(settleQuoteCreation).mockResolvedValue(true as never);
  vi.mocked(createSaleQuote).mockResolvedValue({ saleId: "sale-1", quoteNumber: "SO-00099", totals: { totalBeforeTax: 0, tax: 0, total: 0 } } as never);
});

describe("NewQuip Toolbox quotation switch (independent of the Grower Cin7 write switch)", () => {
  it("OFF by default: refused before any read, credential load or Cin7 call", async () => {
    env({});
    const r = await submitQuoteAction("q1");
    expect(r.ok === false && r.error).toMatch(/not enabled for this organization yet/);
    expect(createServiceRoleClient).not.toHaveBeenCalled(); expect(loadCin7Credentials).not.toHaveBeenCalled(); expect(createSaleQuote).not.toHaveBeenCalled();
  });
  it("the Grower switch alone does NOT enable Toolbox quotations", async () => {
    env({ NEWQUIP_CIN7_WRITES_ENABLED: "true", CIN7_CREDENTIAL_STORE: "uat" });
    expect((await submitQuoteAction("q1")).ok).toBe(false);
    expect(createSaleQuote).not.toHaveBeenCalled();
  });
  it("non-exact values stay OFF", async () => {
    for (const v of ["TRUE", "1", "yes", " true", "false", ""]) { env({ NEWQUIP_TOOLBOX_QUOTE_WRITES_ENABLED: v }); expect((await submitQuoteAction("q1")).ok).toBe(false); }
    expect(createSaleQuote).not.toHaveBeenCalled();
  });
  it("switch on but the deployment is not wired to the NewQuip database: refused", async () => {
    env({ NEWQUIP_TOOLBOX_QUOTE_WRITES_ENABLED: "true", SUPABASE_URL: "https://aaaaaaaaaaaaaaaaaaaa.supabase.co" });
    expect((await submitQuoteAction("q1")).ok).toBe(false);
    expect(createSaleQuote).not.toHaveBeenCalled();
  });
  it("switch on but the quote targets another Cin7 instance: refused, nothing sent", async () => {
    env({ NEWQUIP_TOOLBOX_QUOTE_WRITES_ENABLED: "true" });
    vi.mocked(createServiceRoleClient).mockReturnValue(db(quote({ instance_id: OTHER_INSTANCE })));
    const r = await submitQuoteAction("q1");
    expect(r.ok === false && r.error).toMatch(/not linked to the NewQuip POC Cin7 instance/);
    expect(loadCin7Credentials).not.toHaveBeenCalled(); expect(createSaleQuote).not.toHaveBeenCalled();
  });
  it("the module-access check still runs first (a user without Quotes access is refused)", async () => {
    env({ NEWQUIP_TOOLBOX_QUOTE_WRITES_ENABLED: "true" });
    vi.mocked(requireModuleWrite).mockRejectedValue(new Error("You don't have access to this feature."));
    expect((await submitQuoteAction("q1") as { error: string }).error).toBe("You don't have access to this feature.");
    expect(createSaleQuote).not.toHaveBeenCalled();
  });
  it("ON + NewQuip instance: Shirnel's submit reaches Cin7 once and returns the real Cin7 reference", async () => {
    env({ NEWQUIP_TOOLBOX_QUOTE_WRITES_ENABLED: "true" });
    const r = await submitQuoteAction("q1");
    expect(r).toEqual({ ok: true, data: { cin7SaleId: "sale-1", cin7QuoteNumber: "SO-00099" } });
    expect(createSaleQuote).toHaveBeenCalledTimes(1);
    const [, header, ls, charges] = vi.mocked(createSaleQuote).mock.calls[0];
    expect(header.externalId).toBe("QUOTE-q1");
    expect(ls.map((l) => [l.productSku, l.quantity, l.unitPrice, l.discountPct, l.taxRule, l.taxRatePct])).toEqual([["NQ3444", 2, 1000, 0, "VAT 15%", 15], ["CON001", 1, 500, 10, "VAT 15%", 15]]);
    expect((charges ?? []).map((c) => [c.description, c.unitPrice, c.taxRule, c.taxRatePct])).toEqual([["Freight", 350, "VAT 15%", 15]]);
  });
  it("retry: a claim already completed returns the SAME reference and creates nothing; one in progress is refused", async () => {
    env({ NEWQUIP_TOOLBOX_QUOTE_WRITES_ENABLED: "true" });
    vi.mocked(claimQuoteCreation).mockResolvedValue({ claimed: false, existingStatus: "completed", cin7SaleId: "sale-1", quoteNumber: "SO-00099" } as never);
    expect(await submitQuoteAction("q1")).toEqual({ ok: true, data: { cin7SaleId: "sale-1", cin7QuoteNumber: "SO-00099" } });
    vi.mocked(claimQuoteCreation).mockResolvedValue({ claimed: false, existingStatus: "pending" } as never);
    expect((await submitQuoteAction("q1")).ok).toBe(false);
    expect(createSaleQuote).not.toHaveBeenCalled();
  });
  it("an already-submitted quote returns its stored reference without touching Cin7", async () => {
    env({ NEWQUIP_TOOLBOX_QUOTE_WRITES_ENABLED: "true" });
    vi.mocked(createServiceRoleClient).mockReturnValue(db(quote({ status: "submitted", cin7_sale_id: "sale-1", cin7_quote_number: "SO-00099" })));
    expect(await submitQuoteAction("q1")).toEqual({ ok: true, data: { cin7SaleId: "sale-1", cin7QuoteNumber: "SO-00099" } });
    expect(createSaleQuote).not.toHaveBeenCalled();
  });
  it("another organisation is unaffected by the NewQuip switch (no flag needed, any instance)", async () => {
    env({});
    vi.mocked(requireModuleWrite).mockResolvedValue({ userId: "u", orgId: "d776b8cc-4e6f-42bc-bbd1-3d910fd3aaef", email: "a@b.com" });
    vi.mocked(createServiceRoleClient).mockReturnValue(db(quote({ instance_id: OTHER_INSTANCE })));
    expect((await submitQuoteAction("q1")).ok).toBe(true);
    expect(createSaleQuote).toHaveBeenCalledTimes(1);
  });
});

describe("transmitted payload: amounts, VAT, SKUs and the freight line", () => {
  it("exclusive of VAT: line totals, 15% tax, SKUs and the freight charge (with the customer's revenue account)", () => {
    const tl = { taxRule: "VAT 15%", taxRatePct: 15 };
    const body = buildQuoteBody("s", [
      { productSku: "NQ3444", productName: "PVC door", quantity: 2, unitPrice: 1000, discountPct: 0, ...tl },
      { productSku: "CON001", productName: "Panel", quantity: 1, unitPrice: 500, discountPct: 10, ...tl },
    ], [{ description: "Freight", quantity: 1, unitPrice: 350, discountPct: 0, ...tl }], new Map([["NQ3444", "p1"], ["CON001", "p2"]]), { taxInclusive: false, revenueAccount: "200" }) as { Lines: Array<Record<string, unknown>>; AdditionalCharges: Array<Record<string, unknown>> };
    expect(body.Lines.map((l) => [l.SKU, l.ProductID, l.Total, l.Tax, l.TaxRule])).toEqual([["NQ3444", "p1", 2000, 300, "VAT 15%"], ["CON001", "p2", 450, 67.5, "VAT 15%"]]);
    expect(body.AdditionalCharges).toEqual([expect.objectContaining({ Description: "Freight", Price: 350, Total: 350, Tax: 52.5, TaxRule: "VAT 15%", Account: "200" })]);
  });
  it("VAT-inclusive: the tax is the included portion, not added on top", () => {
    const body = buildQuoteBody("s", [{ productSku: "A", productName: "A", quantity: 1, unitPrice: 115, discountPct: 0, taxRule: "VAT 15%", taxRatePct: 15 }], [], new Map(), { taxInclusive: true }) as { Lines: Array<Record<string, unknown>> };
    expect(body.Lines[0]).toEqual(expect.objectContaining({ Total: 115, Tax: 15 }));
  });
});
