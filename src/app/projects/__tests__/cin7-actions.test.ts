import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as actions from "../cin7-actions";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import * as store from "@/lib/projects/cin7-posting-store";
import { NEWQUIP_POC_CIN7_INSTANCE_ID, NEWQUIP_POC_ORG_IDS } from "@/newquip/access";
import { buildCin7Port, singleActiveInstanceId } from "@/lib/projects/cin7-adapter";
import * as saleStore from "@/lib/projects/cin7-sale-creation-store";
import { POST_CONFIRMATION_TEXT } from "@/lib/projects/cin7-posting";
const REC = { saleId: "x", customerName: "c", location: "l", revenueAccount: "200", cin7TaxRule: "t", reason: "a reason that is long enough" };

vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/lib/projects/scope-access", async (orig) => ({ ...(await orig<typeof import("@/lib/projects/scope-access")>()), guardBillingScope: vi.fn(() => Promise.resolve()) }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn(() => ({ __db: true })) }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/projects/cin7-adapter", () => ({ buildCin7Port: vi.fn(() => ({ __port: true })), singleActiveInstanceId: vi.fn(() => Promise.resolve("inst")) }));
vi.mock("@/lib/projects/cin7-sale-creation-store", () => ({
  createSaleForProject: vi.fn(() => Promise.resolve({ state: "CREATED", message: "ok", linked: false, creation: { id: "c1", cin7_sale_number: "SO-9" } })),
  loadCreation: vi.fn(() => Promise.resolve(null)), reconcileSaleCreation: vi.fn(() => Promise.resolve({ state: "RECONCILED", message: "ok", linked: true, creation: { id: "c1" } })),
}));
vi.mock("@/lib/projects/cin7-posting-store", () => ({
  linkCin7Sale: vi.fn(() => Promise.resolve({ cin7_sale_number: "SO-1" })),
  listPostings: vi.fn(() => Promise.resolve([])),
  loadSaleLink: vi.fn(() => Promise.resolve({ id: "l", instance_id: "inst", cin7_sale_id: "s" })),
  postClaimToCin7: vi.fn(() => Promise.resolve({ state: "CREATED", message: "ok", posting: { id: "p", idempotency_key: "k", cin7_invoice_number: "INV-1" } })),
  reconcileClaimPosting: vi.fn(() => Promise.resolve({ state: "RECONCILED", message: "ok", posting: { id: "p" } })),
}));

const NQ = NEWQUIP_POC_ORG_IDS[0];
const gatesOf = () => vi.mocked(store.postClaimToCin7).mock.calls[0][2];
const env = process.env.NEWQUIP_CIN7_WRITES_ENABLED;
const savedUrls = { s: process.env.SUPABASE_URL, p: process.env.NEXT_PUBLIC_SUPABASE_URL };
const WIRED = "https://pnzwjqjovxxdikxtfngq.supabase.co";
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: NQ, userId: "u", email: "m@x" } as never);
  vi.mocked(requireOrgAdmin).mockResolvedValue({} as never);
  delete process.env.NEWQUIP_CIN7_WRITES_ENABLED;
  process.env.SUPABASE_URL = WIRED; process.env.NEXT_PUBLIC_SUPABASE_URL = WIRED;
});
afterEach(() => { if (savedUrls.s === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = savedUrls.s; if (savedUrls.p === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = savedUrls.p; if (env === undefined) delete process.env.NEWQUIP_CIN7_WRITES_ENABLED; else process.env.NEWQUIP_CIN7_WRITES_ENABLED = env; });

describe("the write gates are derived on the server", () => {
  it("OFF by default: with the flag unset the store receives writesEnabled=false", async () => {
    await actions.postClaimToCin7Action("p", "c", POST_CONFIRMATION_TEXT);
    expect(gatesOf()).toEqual({ writesEnabled: false, orgEnabled: true, isManager: true });
  });
  it.each(["TRUE", "1", "yes", "false", ""])("only the exact string 'true' enables writes (%j does not)", async (v) => {
    process.env.NEWQUIP_CIN7_WRITES_ENABLED = v;
    await actions.postClaimToCin7Action("p", "c", POST_CONFIRMATION_TEXT);
    expect(gatesOf().writesEnabled).toBe(false);
  });
  it("'true' turns it on - on a PREVIEW deployment only", async () => {
    process.env.NEWQUIP_CIN7_WRITES_ENABLED = "true"; vi.stubEnv("VERCEL_ENV", "preview");
    await actions.postClaimToCin7Action("p", "c", POST_CONFIRMATION_TEXT);
    expect(gatesOf().writesEnabled).toBe(true); vi.unstubAllEnvs();
  });
  it.each([["production"], [undefined], ["development"], [""]])("'true' with VERCEL_ENV=%j (Production / local / unknown) does NOT enable writes", async (ve) => {
    process.env.NEWQUIP_CIN7_WRITES_ENABLED = "true"; vi.stubEnv("VERCEL_ENV", ve as string); if (ve === undefined) delete process.env.VERCEL_ENV;
    await actions.postClaimToCin7Action("p", "c", POST_CONFIRMATION_TEXT);
    expect(gatesOf().writesEnabled).toBe(false); vi.unstubAllEnvs();
  });
  it("'true' still does NOT enable writes when the deployment points at a different Supabase project (fail closed)", async () => {
    process.env.NEWQUIP_CIN7_WRITES_ENABLED = "true";
    process.env.SUPABASE_URL = "https://witulfbpotimvbfiqbwq.supabase.co";
    await actions.postClaimToCin7Action("p", "c", POST_CONFIRMATION_TEXT);
    expect(gatesOf().writesEnabled).toBe(false);
  });
  it("a non-NewQuip org gets orgEnabled=false", async () => {
    vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: "other-org", userId: "u", email: "m@x" } as never);
    await actions.postClaimToCin7Action("p", "c", POST_CONFIRMATION_TEXT);
    expect(gatesOf().orgEnabled).toBe(false);
  });
  it("a non-admin (or a failure to establish the role) gets isManager=false — fail closed", async () => {
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("no"));
    await actions.postClaimToCin7Action("p", "c", POST_CONFIRMATION_TEXT);
    expect(gatesOf().isManager).toBe(false);
  });
});

describe("authorisation is re-established in every action", () => {
  const all: Array<[string, () => Promise<{ ok: boolean; error?: string }>]> = [
    ["status", () => actions.getCin7PostingStatusAction("p")],
    ["link", () => actions.recoverLinkCin7SaleAction("p", REC)],
    ["post", () => actions.postClaimToCin7Action("p", "c", POST_CONFIRMATION_TEXT)],
    ["reconcile", () => actions.reconcileClaimPostingAction("p", "c")],
  ];
  it.each(all)("%s: module access denied -> error and no store call", async (_n, run) => {
    vi.mocked(requireModuleAccess).mockRejectedValue(new Error("denied"));
    expect(await run()).toEqual({ ok: false, error: "denied" });
    for (const f of Object.values(store)) expect(f).not.toHaveBeenCalled();
  });
  it("the status action exposes gates and rows but no credentials", async () => {
    const r = await actions.getCin7PostingStatusAction("p");
    expect(JSON.stringify(r)).not.toMatch(/application_key|applicationKey|secret|password/i);
  });
});

describe('"use server" rule', () => {
  it("cin7-actions.ts exports only async functions and erased interfaces", () => {
    const src = readFileSync(join(__dirname, "..", "cin7-actions.ts"), "utf8");
    const exports = [...src.matchAll(/^export\s+(.*)$/gm)].map((m) => m[1]);
    expect(exports.length).toBeGreaterThan(3);
    for (const e of exports) expect(e).toMatch(/^(async function |interface |type )/);
    expect(src).not.toMatch(/export\s+(const|let|var|\{|default)/);
  });
});

describe("Sale creation is pinned to the expected NewQuip POC Cin7 instance", () => {
  const input = { confirmation: "x", customerName: "c", location: "l", revenueAccount: "200", cin7TaxRule: "t" };
  it("refuses, before any Cin7 call, when the organisation's single active instance is not the expected one", async () => {
    vi.mocked(singleActiveInstanceId).mockResolvedValueOnce("some-other-cin7-instance");
    const r = await actions.createCin7SaleAction("p", input);
    expect(r.ok).toBe(false); expect(r.error).toMatch(/expected NewQuip POC Cin7 instance/);
    expect(saleStore.createSaleForProject).not.toHaveBeenCalled();
  });
  it("proceeds to the store (which applies the write gates) only for the expected instance", async () => {
    vi.mocked(singleActiveInstanceId).mockResolvedValueOnce(NEWQUIP_POC_CIN7_INSTANCE_ID);
    const r = await actions.createCin7SaleAction("p", input);
    expect(r.ok, r.error).toBe(true); expect(saleStore.createSaleForProject).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saleStore.createSaleForProject).mock.calls[0][4]).toMatchObject({ instanceId: NEWQUIP_POC_CIN7_INSTANCE_ID });
  });
  it("the gates handed to the store still come from the single Preview-only decision", async () => {
    vi.mocked(singleActiveInstanceId).mockResolvedValueOnce(NEWQUIP_POC_CIN7_INSTANCE_ID); process.env.NEWQUIP_CIN7_WRITES_ENABLED = "true"; vi.stubEnv("VERCEL_ENV", "production");
    await actions.createCin7SaleAction("p", input);
    expect(vi.mocked(saleStore.createSaleForProject).mock.calls[0][2]).toMatchObject({ writesEnabled: false }); vi.unstubAllEnvs();
  });
});

describe("getCommercialBootAction: the Commercial tab's Sale + invoice state in one guarded read", () => {
  it("re-establishes module access and billing scope itself, once, before reading anything", async () => {
    const scope = await import("@/lib/projects/scope-access");
    await actions.getCommercialBootAction("p1");
    expect(requireModuleAccess).toHaveBeenCalledTimes(1);
    expect(scope.guardBillingScope).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    vi.mocked(requireModuleAccess).mockRejectedValue(new Error("You don't have access to this feature."));
    const denied = await actions.getCommercialBootAction("p1");
    expect(denied).toEqual({ ok: false, error: "You don't have access to this feature." });
    expect(store.loadSaleLink).not.toHaveBeenCalled();
    expect(store.listPostings).not.toHaveBeenCalled();
  });
  it("an internal billing scope the caller may not open is refused with nothing read", async () => {
    const scope = await import("@/lib/projects/scope-access");
    vi.mocked(scope.guardBillingScope).mockRejectedValueOnce(new Error("Open the original project."));
    const r = await actions.getCommercialBootAction("p1");
    expect(r.ok).toBe(false);
    expect(store.listPostings).not.toHaveBeenCalled();
  });
  it("returns the same posting state as the single action; a failure in one half does not hide the other", async () => {
    const single = await actions.getCin7PostingStatusAction("p1");
    const boot = await actions.getCommercialBootAction("p1");
    expect(boot.ok).toBe(true);
    expect(boot.data!.posting).toEqual(single.data);
    // the creation half fails (no scope can be read from the stub db) while the posting half still answers
    expect(boot.data!.creation).toBeNull();
    vi.mocked(store.listPostings).mockRejectedValueOnce(new Error("db down"));
    const again = await actions.getCommercialBootAction("p1");
    expect(again.ok).toBe(true);
    expect(again.data!.posting).toBeNull();
  });
  it("a plain member gets display gates with isManager=false (the manager check is the server's, not the page's)", async () => {
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("not admin"));
    const r = await actions.getCommercialBootAction("p1");
    expect(r.data!.posting!.gates.isManager).toBe(false);
  });
});

describe("verifyInvoiceStatusesAction (UAT-028): read-only, manager only, one Sale read", () => {
  const postingRow = (n: string, status: string, over: Record<string, unknown> = {}) => ({ id: `po-${n}`, claim_id: `cl-${n}`, posting_state: "RECONCILED", cin7_invoice_number: n, cin7_task_id: null, cin7_status: status, ...over });
  const sale = (invoices: Array<{ invoiceNumber: string; status: string }>, id = "s") => ({ id, saleNumber: "SO-27", type: null, orderStatus: null, taxRule: null, invoices: invoices.map((i) => ({ ...i, taskId: null, memo: null, subtotalCents: 0, taxCents: 0, totalCents: 0 })) });
  const fetchSale = vi.fn();
  const createInvoice = vi.fn();
  beforeEach(() => {
    fetchSale.mockReset(); createInvoice.mockReset();
    vi.mocked(buildCin7Port).mockReturnValue({ fetchSale, createInvoice } as never);
    vi.mocked(singleActiveInstanceId).mockResolvedValue(NEWQUIP_POC_CIN7_INSTANCE_ID);
    vi.mocked(store.loadSaleLink).mockResolvedValue({ id: "l", instance_id: NEWQUIP_POC_CIN7_INSTANCE_ID, cin7_sale_id: "s" } as never);
    vi.mocked(store.listPostings).mockResolvedValue([postingRow("INV-34", "DRAFT"), postingRow("INV-35", "DRAFT"), postingRow("INV-37", "AUTHORISED")] as never);
    fetchSale.mockResolvedValue(sale([{ invoiceNumber: "INV-34", status: "AUTHORISED" }, { invoiceNumber: "INV-35", status: "AUTHORISED" }, { invoiceNumber: "INV-37", status: "AUTHORISED" }]));
  });

  it("reads the Sale ONCE for all invoices and returns recorded vs current with a timestamp; nothing is written and no invoice is created", async () => {
    const r = await actions.verifyInvoiceStatusesAction("p1");
    expect(r.ok).toBe(true);
    expect(fetchSale).toHaveBeenCalledTimes(1);
    expect(fetchSale).toHaveBeenCalledWith("s");
    expect(createInvoice).not.toHaveBeenCalled();
    expect(r.data!.invoices.map((i) => [i.invoiceNumber, i.recordedStatus, i.currentStatus, i.outcome])).toEqual([["INV-34", "DRAFT", "AUTHORISED", "CHANGED"], ["INV-35", "DRAFT", "AUTHORISED", "CHANGED"], ["INV-37", "AUTHORISED", "AUTHORISED", "SAME"]]);
    expect(Number.isNaN(Date.parse(r.data!.verifiedAt))).toBe(false);
    for (const fn of [store.linkCin7Sale, store.postClaimToCin7, store.reconcileClaimPosting]) expect(fn).not.toHaveBeenCalled(); // the posting record is never touched
  });
  it("re-establishes module access and the billing-scope guard first; a refusal reads nothing", async () => {
    const scope = await import("@/lib/projects/scope-access");
    vi.mocked(requireModuleAccess).mockRejectedValueOnce(new Error("You don't have access to this feature."));
    expect((await actions.verifyInvoiceStatusesAction("p1")).ok).toBe(false);
    vi.mocked(scope.guardBillingScope).mockRejectedValueOnce(new Error("Open the original project."));
    expect((await actions.verifyInvoiceStatusesAction("p1")).ok).toBe(false);
    expect(fetchSale).not.toHaveBeenCalled();
  });
  it("is owner/admin only: a plain user is refused and Cin7 is not read", async () => {
    vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("not admin"));
    expect(await actions.verifyInvoiceStatusesAction("p1")).toEqual({ ok: false, error: "Only an owner or admin can verify invoice statuses against Cin7." });
    expect(fetchSale).not.toHaveBeenCalled();
  });
  it("a project with no linked Sale, a Sale on another instance, or another instance being active reads nothing", async () => {
    vi.mocked(store.loadSaleLink).mockResolvedValueOnce(null);
    expect((await actions.verifyInvoiceStatusesAction("p1")).error).toMatch(/No Cin7 Sales Order is linked/);
    vi.mocked(store.loadSaleLink).mockResolvedValueOnce({ id: "l", instance_id: "other", cin7_sale_id: "s" } as never);
    expect((await actions.verifyInvoiceStatusesAction("p1")).error).toMatch(/different Cin7 instance/);
    vi.mocked(singleActiveInstanceId).mockResolvedValueOnce("not-the-poc-instance");
    expect((await actions.verifyInvoiceStatusesAction("p1")).ok).toBe(false);
    expect(fetchSale).not.toHaveBeenCalled();
  });
  it("Cin7 returning a different Sale than the linked one verifies nothing", async () => {
    fetchSale.mockResolvedValue(sale([{ invoiceNumber: "INV-34", status: "AUTHORISED" }], "someone-elses"));
    const r = await actions.verifyInvoiceStatusesAction("p1");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/different Sale/);
  });
  it("a Cin7 failure is reported as a failure, not as 'all matches'", async () => {
    fetchSale.mockRejectedValue(new Error("Cin7 timed out"));
    expect(await actions.verifyInvoiceStatusesAction("p1")).toEqual({ ok: false, error: "Cin7 timed out" });
  });
  it("is never run automatically by the status reads the page makes on opening", async () => {
    await actions.getCin7PostingStatusAction("p1"); await actions.getCommercialBootAction("p1"); await actions.getCin7SaleCreationStatusAction("p1");
    expect(fetchSale).not.toHaveBeenCalled();
  });
});
