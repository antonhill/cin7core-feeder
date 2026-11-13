import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({
  org: vi.fn(), module: vi.fn(), demo: vi.fn(), admin: vi.fn(), cost: vi.fn(), creds: vi.fn(), log: vi.fn(), request: vi.fn(),
}));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: m.org }));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: m.module }));
vi.mock("@/lib/demo-mode/context", () => ({ assertNoDemoImpersonation: m.demo }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: m.admin }));
vi.mock("@/lib/approvals/role-store", () => ({ canSeeCosts: m.cost }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => ({ marker: "db" }) }));
vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: m.creds }));
vi.mock("@/lib/activity-log", () => ({ logActivity: m.log }));
vi.mock("@/cin7/http", () => ({ cin7Request: m.request }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
vi.mock("../diagnostics/DiagnosticClient", () => ({ DiagnosticClient: () => null }));

import { runCin7DiagnosticAction } from "../cin7-diagnostic-actions";
import Page from "../diagnostics/page";

const CANARY = "CANARY-APP-KEY-77";
const ORG = "org-nq";
function allow() {
  m.org.mockResolvedValue({ orgId: ORG });
  m.module.mockResolvedValue({ orgId: ORG, userId: "u1", email: "owner@nq" });
  m.demo.mockResolvedValue(undefined); m.admin.mockResolvedValue(undefined); m.cost.mockResolvedValue(true);
}
beforeEach(() => {
  vi.clearAllMocks(); vi.unstubAllEnvs();
  vi.stubEnv("NEWQUIP_CIN7_DIAGNOSTIC_ENABLED", "true");
  allow();
  m.creds.mockResolvedValue({ accountId: "acct", applicationKey: CANARY, baseUrl: "x", name: "n" });
  m.request.mockImplementation(async (_c: unknown, path: string, o: { method: string; query: Record<string, string> }) => {
    expect(o.method).toBe("GET");
    return path === "/Product" ? { Products: [{ SKU: o.query.SKU, Name: "n", Status: "Active", Suppliers: [{ SupplierName: "S", Cost: 9.99 }] }] } : { SupplierList: [{ Name: "S", Currency: "ZAR" }] };
  });
});
const noWork = () => { expect(m.creds).not.toHaveBeenCalled(); expect(m.request).not.toHaveBeenCalled(); expect(m.log).not.toHaveBeenCalled(); };

describe("runCin7DiagnosticAction authorisation", () => {
  it("org admin / owner succeeds, loads credentials once, writes ONE audit row with counts only", async () => {
    const r = await runCin7DiagnosticAction(["SKU1", "SKU2"]);
    expect(r.ok).toBe(true);
    expect(r.data?.summary).toMatchObject({ requested: 2, found: 2 });
    expect(m.creds).toHaveBeenCalledTimes(1);
    expect(m.creds.mock.calls[0].slice(1)).toEqual([ORG, expect.any(String)]);
    expect(m.log).toHaveBeenCalledTimes(1);
    const input = m.log.mock.calls[0][1];
    expect(input).toMatchObject({ orgId: ORG, action: "newquip.cin7_diagnostic_run", summary: "Read-only Cin7 diagnostic run (GET only; no Cin7 or quotation write)", detail: { skusRequested: 2, found: 2, missing: 0, errors: 0 } });
    const audit = JSON.stringify(input);
    for (const leak of ["SKU1", "SKU2", "9.99", CANARY]) expect(audit).not.toContain(leak);
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });
  it("super admin passes (requireOrgAdmin is the super-admin-aware gate)", async () => {
    m.admin.mockResolvedValue({ orgId: ORG }); // requireOrgAdmin returns for a super admin
    expect((await runCin7DiagnosticAction(["A"])).ok).toBe(true);
  });
  it.each([
    ["Rep (not admin, no cost rights)", () => { m.admin.mockRejectedValue(new Error("not admin")); m.cost.mockResolvedValue(false); }],
    ["Estimator without admin", () => { m.admin.mockRejectedValue(new Error("not admin")); m.cost.mockResolvedValue(true); }],
    ["admin without cost rights", () => { m.cost.mockResolvedValue(false); }],
    ["Demo Mode identity", () => { m.demo.mockRejectedValue(new Error("demo")); }],
    ["Demo refused by module access", () => { m.module.mockRejectedValue(new Error("demo")); }],
    ["wrong org", () => { m.org.mockRejectedValue(new Error("This tool isn't available for your organization.")); }],
    ["no module access", () => { m.module.mockRejectedValue(new Error("no access")); }],
    ["env gate off", () => { vi.stubEnv("NEWQUIP_CIN7_DIAGNOSTIC_ENABLED", "false"); }],
    ["env gate unset", () => { vi.stubEnv("NEWQUIP_CIN7_DIAGNOSTIC_ENABLED", ""); }],
    ["env gate not exactly true", () => { vi.stubEnv("NEWQUIP_CIN7_DIAGNOSTIC_ENABLED", "1"); }],
  ])("refuses %s: no credentials, no request, no audit", async (_n, setup) => {
    setup();
    const r = await runCin7DiagnosticAction(["A"]);
    expect(r.ok).toBe(false);
    expect(r.data).toBeUndefined();
    expect(r.error).toBe("This diagnostic is not available.");
    noWork();
  });
  it("invalid input does no Cin7 work", async () => {
    expect((await runCin7DiagnosticAction(["A;DROP"])).ok).toBe(false);
    expect((await runCin7DiagnosticAction([])).ok).toBe(false);
    noWork();
  });
  it("a credential-load failure returns a generic message with no detail", async () => {
    m.creds.mockRejectedValue(new Error(`decrypt failed ${CANARY}`));
    const r = await runCin7DiagnosticAction(["A"]);
    expect(r).toEqual({ ok: false, error: "The diagnostic could not be completed." });
    expect(m.log).not.toHaveBeenCalled();
  });
});

describe("diagnostics page", () => {
  it("renders when enabled and authorised", async () => { await expect(Page()).resolves.toBeTruthy(); });
  it.each([
    ["gate off", () => vi.stubEnv("NEWQUIP_CIN7_DIAGNOSTIC_ENABLED", "false")],
    ["not admin", () => m.admin.mockRejectedValue(new Error("x"))],
    ["wrong org", () => m.org.mockRejectedValue(new Error("x"))],
    ["no cost rights", () => m.cost.mockResolvedValue(false)],
  ])("notFound when %s", async (_n, setup) => { setup(); await expect(Page()).rejects.toThrow("NEXT_NOT_FOUND"); });
});

const SRC = join(__dirname, "..", "..", "..");
const FILES = ["cin7/readonly-diagnostic.ts", "app/newquip-grower/cin7-diagnostic-actions.ts", "app/newquip-grower/diagnostics/authorise.ts", "app/newquip-grower/diagnostics/page.tsx", "app/newquip-grower/diagnostics/DiagnosticClient.tsx"];
const read = (f: string) => readFileSync(join(SRC, f), "utf8");

describe("static guards", () => {
  const importsOf = (s: string) => [...s.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((x) => x[1]);
  it("no write-path imports, no writer identifiers, no POST/PUT/DELETE literals", () => {
    const banned = /quote-store|saveDraft|captureLatestCostsAction|cost-actions|pricing-store|pricing-service|purchase-write|sale-invoice-write|sale-order-write|sale-quote-write|assembly-bom|-write/;
    for (const f of FILES) {
      const s = read(f);
      for (const spec of importsOf(s)) expect(spec, `${f} imports ${spec}`).not.toMatch(banned);
      expect(s, f).not.toMatch(/saveDraft|captureLatestCostsAction/);
      expect(s, f).not.toMatch(/method:\s*["'](POST|PUT|DELETE|PATCH)["']/);
    }
  });
  it("the Cin7 module reaches the network only via the existing gateway", () => {
    const s = read("cin7/readonly-diagnostic.ts");
    expect(s).not.toMatch(/(?<![\w.])fetch\(/);
    expect(importsOf(s).sort()).toEqual(["@/cin7/http", "@/cin7/types", "server-only"]);
  });
  it('"use server" file exports only async functions (and erased types)', () => {
    const s = read("app/newquip-grower/cin7-diagnostic-actions.ts");
    expect(s.startsWith('"use server"')).toBe(true);
    const exports = [...s.matchAll(/^export\s+(.*)$/gm)].map((x) => x[1]);
    expect(exports.length).toBeGreaterThan(0);
    for (const e of exports) expect(e, e).toMatch(/^(async function |interface |type )/);
    expect(s).not.toMatch(/^export\s+(const|let|var|class|default|\{|\*)/m);
  });
});
