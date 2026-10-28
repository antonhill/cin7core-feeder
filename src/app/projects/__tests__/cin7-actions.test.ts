import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as actions from "../cin7-actions";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import * as store from "@/lib/projects/cin7-posting-store";
import { NEWQUIP_POC_ORG_IDS } from "@/newquip/access";
import { POST_CONFIRMATION_TEXT } from "@/lib/projects/cin7-posting";

vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/lib/projects/scope-access", async (orig) => ({ ...(await orig<typeof import("@/lib/projects/scope-access")>()), guardBillingScope: vi.fn(() => Promise.resolve()) }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: vi.fn(() => ({ __db: true })) }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/projects/cin7-adapter", () => ({ buildCin7Port: vi.fn(() => ({ __port: true })), singleActiveInstanceId: vi.fn(() => Promise.resolve("inst")) }));
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
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireModuleAccess).mockResolvedValue({ orgId: NQ, userId: "u", email: "m@x" } as never);
  vi.mocked(requireOrgAdmin).mockResolvedValue({} as never);
  delete process.env.NEWQUIP_CIN7_WRITES_ENABLED;
});
afterEach(() => { if (env === undefined) delete process.env.NEWQUIP_CIN7_WRITES_ENABLED; else process.env.NEWQUIP_CIN7_WRITES_ENABLED = env; });

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
  it("'true' turns it on", async () => {
    process.env.NEWQUIP_CIN7_WRITES_ENABLED = "true";
    await actions.postClaimToCin7Action("p", "c", POST_CONFIRMATION_TEXT);
    expect(gatesOf().writesEnabled).toBe(true);
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
    ["link", () => actions.linkCin7SaleAction("p", "s", "200")],
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
