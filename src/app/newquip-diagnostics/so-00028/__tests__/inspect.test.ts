import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspectSaleSo00028Action } from "../actions";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchSaleDetail, fetchSaleDetailOnce } from "@/cin7/sales";
import { singleActiveInstanceId } from "@/lib/projects/cin7-adapter";
import { INSPECTED_SALE, inspectSale } from "@/lib/projects/sale-inspection";

// Calls recorded on the fake database: only SELECT-style methods may ever appear.
const dbCalls: string[] = [];
let creationRows: unknown[] = [{ id: "c1" }];
const query = (): unknown => new Proxy({}, {
  get: (_t, prop: string) => {
    if (prop === "then") return (res: (v: unknown) => void) => res({ data: creationRows, error: null });
    dbCalls.push(prop);
    return () => query();
  },
});
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn(() => ({ from: (t: string) => { dbCalls.push(`from:${t}`); return query(); } })) }));
vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: vi.fn(() => Promise.resolve({ name: "n", accountId: "a", applicationKey: "SECRET-KEY-VALUE", baseUrl: "https://x" })) }));
vi.mock("@/cin7/sales", () => ({ fetchSaleDetailOnce: vi.fn(), fetchSaleDetail: vi.fn() }));
vi.mock("@/lib/projects/cin7-adapter", () => ({ singleActiveInstanceId: vi.fn() }));

// The shape of an Advanced Sale with ONE commercial charge, no product lines and an empty fulfilment container.
const emptyContainerSale = () => ({
  ID: INSPECTED_SALE.saleId, Type: "Advanced Sale", Customer: "Spark", ExternalID: INSPECTED_SALE.externalId, TaxRule: "Standard Rate Sales",
  Order: { Status: "AUTHORISED", Lines: [], AdditionalCharges: [{ Description: "PRJ-NQ-Q-0017-V001 - Variation", Quantity: 1, Price: 500000, Tax: 75000, Total: 500000, TaxRule: "Standard Rate Sales" }], TotalBeforeTax: 500000, Tax: 75000, Total: 575000 },
  Invoices: [],
  Fulfilments: [{ TaskID: "TASK-SECRET-ID", FulfillmentNumber: 1, FulFilmentStatus: "NOT FULFILLED", LinkedInvoiceNumber: "", Pick: { Status: "NOT AVAILABLE", Lines: [] }, Pack: { Status: "NOT AVAILABLE", Lines: [] }, Ship: { Status: "NOT AVAILABLE", Lines: [] } }],
  // fields the diagnostic must never show
  BillingAddress: { Line1: "1 Secret Street" }, Attachments: [{ DownloadUrl: "https://files/secret?timeStamp=1", FileName: "x.pdf" }], CustomerReference: "CUST-REF-SECRET", SalesRepresentative: "Rep Name",
});

beforeEach(() => {
  vi.clearAllMocks();
  dbCalls.length = 0;
  creationRows = [{ id: "c1" }];
  vi.mocked(requireOrgAdmin).mockResolvedValue({ orgId: INSPECTED_SALE.orgId, userId: "u" } as never);
  vi.mocked(singleActiveInstanceId).mockResolvedValue(INSPECTED_SALE.instanceId);
  vi.mocked(fetchSaleDetailOnce).mockResolvedValue(emptyContainerSale() as never);
});

describe("access: refused before any Cin7 call", () => {
  it("an unauthenticated or non-admin user is refused", async () => {
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("Only an org owner or admin can inspect a Cin7 Sale."));
    const r = await inspectSaleSo00028Action();
    expect(r.ok).toBe(false);
    expect(r.data).toBeUndefined();
    expect(loadCin7Credentials).not.toHaveBeenCalled();
    expect(fetchSaleDetailOnce).not.toHaveBeenCalled();
  });
  it("another organisation is refused", async () => {
    vi.mocked(requireOrgAdmin).mockResolvedValue({ orgId: "00000000-0000-0000-0000-000000000000", userId: "u" } as never);
    const r = await inspectSaleSo00028Action();
    expect(r).toMatchObject({ ok: false });
    expect(fetchSaleDetailOnce).not.toHaveBeenCalled();
  });
  it("another Cin7 instance is refused", async () => {
    vi.mocked(singleActiveInstanceId).mockResolvedValue("11111111-1111-1111-1111-111111111111");
    expect((await inspectSaleSo00028Action()).ok).toBe(false);
    expect(fetchSaleDetailOnce).not.toHaveBeenCalled();
  });
  it("a Sale the Toolbox did not record creating for the organisation is refused", async () => {
    creationRows = [];
    expect((await inspectSaleSo00028Action()).ok).toBe(false);
    expect(fetchSaleDetailOnce).not.toHaveBeenCalled();
  });
  it("takes no argument, so no other Sale ID can be requested", () => {
    expect(inspectSaleSo00028Action.length).toBe(0);
  });
  it("does not echo unexpected error text to the browser", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(fetchSaleDetailOnce).mockRejectedValue(new Error("Cin7 said: Authorization header was Bearer abc123"));
    const r = await inspectSaleSo00028Action();
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("abc123");
  });
  it("shows nothing if Cin7 answers with a different Sale", async () => {
    vi.mocked(fetchSaleDetailOnce).mockResolvedValue({ ...emptyContainerSale(), ID: "another-sale-id" } as never);
    const r = await inspectSaleSo00028Action();
    expect(r.ok).toBe(false);
    expect(r.data).toBeUndefined();
  });
});

describe("the one read-only operation", () => {
  it("makes exactly one GET (no retries), for the pinned Sale ID, and only SELECTs on the database", async () => {
    const r = await inspectSaleSo00028Action();
    expect(r.ok).toBe(true);
    expect(fetchSaleDetailOnce).toHaveBeenCalledTimes(1);
    const [creds, id] = vi.mocked(fetchSaleDetailOnce).mock.calls[0];
    expect(creds).toMatchObject({ applicationKey: "SECRET-KEY-VALUE" });
    expect(id).toBe("ab919729-36e5-44c4-ae7b-f7a4797e8b75");
    expect(fetchSaleDetail).not.toHaveBeenCalled(); // the retrying reader is never used
    expect(dbCalls.every((c) => c.startsWith("from:") || ["select", "eq"].includes(c))).toBe(true);
    expect(dbCalls).toContain("from:project_cin7_sale_creations");
  });
  it("the module can reach no Cin7 write, no database write, no audit log and no retry", () => {
    const src = readFileSync(join(__dirname, "..", "actions.ts"), "utf8");
    expect(src).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
    expect(src).not.toMatch(/logActivity|createAdvancedSale|cin7Request|fetchSaleDetail\(|sale-order-write|method:|reconcile|recoverLink|postClaim|setTimeout|for \(|while \(/);
    const imports = [...src.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual(["@/cin7/load-credentials", "@/cin7/sales", "@/lib/projects/cin7-adapter", "@/lib/projects/sale-inspection", "@/lib/require-org-admin", "@/supabase/server"]);
    // "use server" rule: only async function exports
    expect([...src.matchAll(/^export (.*)$/gm)].every((m) => m[1].startsWith("async function "))).toBe(true);
  });
});

const ALLOWED = new Set([
  "ok", "data", "saleId", "type", "customer", "externalId", "taxRule", "orderStatus", "orderProductLineCount", "orderProductLines", "additionalCharges", "orderTotals", "invoiceCount",
  "invoices", "fulfilmentCount", "fulfilments", "sku", "quantity", "priceExVat", "description", "vat", "total", "exVat", "number", "status", "linkedInvoice", "pick", "pack", "ship",
  "lineCount", "totalQuantity", "lines", "shippedLineCount", "hasShipmentDate", "looksEmpty",
]);
const keysOf = (v: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
};

describe("the response is an allowlisted summary", () => {
  it("contains only allowlisted keys and none of the sensitive values in the raw Sale", async () => {
    const r = await inspectSaleSo00028Action();
    expect([...keysOf(r)].filter((k) => !ALLOWED.has(k))).toEqual([]);
    const text = JSON.stringify(r);
    for (const secret of ["SECRET-KEY-VALUE", "TASK-SECRET-ID", "1 Secret Street", "files/secret", "CUST-REF-SECRET", "Rep Name", "applicationKey", "DownloadUrl"]) expect(text).not.toContain(secret);
  });
  it("reports the observed empty-container structure plainly", async () => {
    const d = (await inspectSaleSo00028Action()).data!;
    expect(d).toMatchObject({ orderStatus: "AUTHORISED", orderProductLineCount: 0, invoiceCount: 0, fulfilmentCount: 1, externalId: INSPECTED_SALE.externalId, customer: "Spark" });
    expect(d.additionalCharges).toEqual([{ description: "PRJ-NQ-Q-0017-V001 - Variation", quantity: 1, priceExVat: 500000, vat: 75000, total: 500000 }]);
    expect(d.fulfilments[0]).toMatchObject({ looksEmpty: true, pick: { lineCount: 0, totalQuantity: 0 }, pack: { lineCount: 0 }, ship: { lineCount: 0, shippedLineCount: 0 } });
  });
  it("flags a fulfilment with real pick, pack or shipment activity", () => {
    const busy = emptyContainerSale();
    (busy.Fulfilments[0] as { Pick: unknown }).Pick = { Status: "AUTHORISED", Lines: [{ SKU: "NQ1000", Quantity: 3 }] };
    expect(inspectSale(busy as never).fulfilments[0]).toMatchObject({ looksEmpty: false, pick: { totalQuantity: 3 } });
    const shipped = emptyContainerSale();
    (shipped.Fulfilments[0] as { Ship: unknown }).Ship = { Status: "AUTHORISED", Lines: [{ IsShipped: true, ShipmentDate: "2026-11-01", TrackingNumber: "TRK-SECRET" }] };
    const out = inspectSale(shipped as never);
    expect(out.fulfilments[0]).toMatchObject({ looksEmpty: false, ship: { shippedLineCount: 1, hasShipmentDate: true } });
    expect(JSON.stringify(out)).not.toContain("TRK-SECRET");
  });
});
