import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));
const m = vi.hoisted(() => ({
  cur: vi.fn(), org: vi.fn(), module: vi.fn(), demo: vi.fn(), admin: vi.fn(), cost: vi.fn(), creds: vi.fn(), log: vi.fn(), request: vi.fn(),
}));
vi.mock("@/lib/current-org", () => ({ requireCurrentOrg: m.cur }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: m.org }));
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: m.module }));
vi.mock("@/lib/demo-mode/context", () => ({ assertNoDemoImpersonation: m.demo }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: m.admin }));
vi.mock("@/lib/approvals/role-store", () => ({ canSeeCosts: m.cost }));
type Row = Record<string, unknown>;
const dbh = vi.hoisted(() => ({ rows: [] as Row[], insertError: null as null | { message: string }, selectError: null as null | { message: string } }));
const fakeDb = {
  from: () => {
    const f: { org?: unknown; actions?: string[]; since?: string } = {};
    const q = {
      select: () => q, eq: (_c: string, v: unknown) => { f.org = v; return q; }, in: (_c: string, v: string[]) => { f.actions = v; return q; }, gte: (_c: string, v: string) => { f.since = v; return q; }, order: () => q,
      limit: async () => dbh.selectError ? { data: null, error: dbh.selectError } : { data: dbh.rows.filter((r) => r.org_id === f.org && f.actions!.includes(r.action as string) && (r.created_at as string) >= f.since!).sort((a, b) => ((b.created_at as string) > (a.created_at as string) ? 1 : -1)), error: null },
      insert: async (row: Row) => { if (dbh.insertError) return { error: dbh.insertError }; dbh.rows.push({ created_at: new Date().toISOString(), ...row }); return { error: null }; },
    };
    return q;
  },
};
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => fakeDb }));
vi.mock("@/cin7/load-credentials", () => ({ loadCin7Credentials: m.creds }));
vi.mock("@/lib/activity-log", () => ({ logActivity: m.log }));
vi.mock("@/cin7/http", () => ({ cin7Request: m.request }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
vi.mock("../diagnostics/DiagnosticClient", () => ({ DiagnosticClient: () => null }));

import { runCin7DiagnosticAction } from "../cin7-diagnostic-actions";
import Page, { maxDuration } from "../diagnostics/page";

const CANARY = "CANARY-APP-KEY-77";
const ORG = "org-nq";
function allow() {
  m.cur.mockResolvedValue({ orgId: ORG, userId: "u1", email: "owner@nq" });
  m.org.mockResolvedValue({ orgId: ORG });
  m.module.mockResolvedValue({ orgId: ORG, userId: "u1", email: "owner@nq" });
  m.demo.mockResolvedValue(undefined); m.admin.mockResolvedValue(undefined); m.cost.mockResolvedValue(true);
}
beforeEach(() => {
  vi.clearAllMocks(); vi.unstubAllEnvs(); dbh.rows.length = 0; dbh.insertError = null; dbh.selectError = null;
  vi.stubEnv("NEWQUIP_CIN7_DIAGNOSTIC_ENABLED", "true");
  allow();
  m.creds.mockResolvedValue({ accountId: "acct", applicationKey: CANARY, baseUrl: "x", name: "n" });
  m.request.mockImplementation(async (_c: unknown, path: string, o: { method: string; query: Record<string, string> }) => {
    expect(o.method).toBe("GET");
    return path === "/Product" ? { Products: [{ SKU: o.query.SKU, Name: "n", Status: "Active", Suppliers: [{ SupplierName: "S", Cost: 9.99 }] }] } : { SupplierList: [{ Name: "S", Currency: "ZAR" }] };
  });
});
const run = async (skus: string[]) => { vi.useFakeTimers(); const p = runCin7DiagnosticAction(skus); await vi.runAllTimersAsync(); const r = await p; vi.useRealTimers(); return r; };
const noWork = () => { expect(m.creds).not.toHaveBeenCalled(); expect(m.request).not.toHaveBeenCalled(); expect(dbh.rows).toEqual([]); };
const refusals = () => m.log.mock.calls.map((c) => c[1]).filter((i) => i.action === "newquip.cin7_diagnostic_refused");

describe("runCin7DiagnosticAction authorisation", () => {
  it("org admin / owner succeeds, loads credentials once, writes ONE audit row with counts only", async () => {
    const r = await run(["SKU1", "SKU2"]);
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
    expect((await run(["A"])).ok).toBe(true);
  });
  it.each([
    ["Rep (not admin, no cost rights)", "not_admin", () => { m.admin.mockRejectedValue(new Error("not admin")); m.cost.mockResolvedValue(false); }],
    ["Estimator without admin", "not_admin", () => { m.admin.mockRejectedValue(new Error("not admin")); m.cost.mockResolvedValue(true); }],
    ["admin without cost rights", "not_admin", () => { m.cost.mockResolvedValue(false); }],
    ["Demo Mode identity", "demo", () => { m.demo.mockRejectedValue(new Error("demo")); }],
    ["Demo refused by module access", "not_admin", () => { m.module.mockRejectedValue(new Error("demo")); }],
    ["wrong org", "wrong_org", () => { m.org.mockRejectedValue(new Error("This tool isn't available for your organization.")); }],
    ["no module access", "not_admin", () => { m.module.mockRejectedValue(new Error("no access")); }],
  ])("refuses %s: no credentials, no request, no started row; ONE refusal row with the reason code only", async (_n, reason, setup) => {
    setup();
    const r = await run(["A"]);
    expect(r).toEqual({ ok: false, error: "This diagnostic is not available." });
    noWork();
    expect(m.log).toHaveBeenCalledTimes(1);
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]).toMatchObject({ orgId: ORG, detail: { reason } });
    expect(JSON.stringify(refusals()[0].detail)).not.toContain("A\"");
  });
  it.each([
    ["env gate off", "false"], ["env gate unset", ""], ["env gate not exactly true", "1"],
  ])("refuses when %s: no work, no DB read, no audit row of any kind", async (_n, v) => {
    vi.stubEnv("NEWQUIP_CIN7_DIAGNOSTIC_ENABLED", v);
    expect((await run(["A"])).ok).toBe(false);
    noWork(); expect(m.log).not.toHaveBeenCalled(); expect(m.cur).not.toHaveBeenCalled();
  });
  it("an unauthenticated caller creates no audit row (no write path before authentication)", async () => {
    m.cur.mockRejectedValue(new Error("not signed in"));
    const r = await run(["A"]);
    expect(r.ok).toBe(false);
    noWork(); expect(m.log).not.toHaveBeenCalled();
  });
  it("invalid input does no Cin7 work", async () => {
    expect((await run(["A;DROP"])).ok).toBe(false);
    expect((await run([])).ok).toBe(false);
    noWork();
    expect(refusals().map((i) => i.detail)).toEqual([{ reason: "invalid_input" }, { reason: "invalid_input" }]);
  });
  it("a credential-load failure returns a generic message with no detail", async () => {
    m.creds.mockRejectedValue(new Error(`decrypt failed ${CANARY}`));
    const r = await run(["A"]);
    expect(r).toEqual({ ok: false, error: "The diagnostic could not be completed." });
    expect(m.log).toHaveBeenCalledTimes(1); // the completion row records the failure, counts only, so the single-flight window is released
    expect(m.log.mock.calls[0][1]).toMatchObject({ action: "newquip.cin7_diagnostic_run", detail: { failed: true } });
    expect(JSON.stringify(m.log.mock.calls)).not.toContain(CANARY);
  });
  it("writes a started row BEFORE any Cin7 call (actor + SKU count only)", async () => {
    let startedBeforeFirstRequest = false;
    m.request.mockImplementationOnce(async () => { startedBeforeFirstRequest = dbh.rows.some((r) => r.action === "newquip.cin7_diagnostic_run_started"); return { Products: [] }; });
    await run(["SKU1"]);
    expect(startedBeforeFirstRequest).toBe(true);
    const started = dbh.rows.find((r) => r.action === "newquip.cin7_diagnostic_run_started")!;
    expect(started).toMatchObject({ org_id: ORG, actor_email: "owner@nq", detail: { skusRequested: 1 } });
    expect(JSON.stringify(started)).not.toContain("SKU1");
  });
  it("fails closed when the started row cannot be written: no credentials, no request", async () => {
    dbh.insertError = { message: "db down" };
    const r = await run(["A"]);
    expect(r.ok).toBe(false);
    expect(m.creds).not.toHaveBeenCalled(); expect(m.request).not.toHaveBeenCalled();
  });
  it("completion row records aborted / abortReason counts", async () => {
    await run(["A"]);
    expect(m.log.mock.calls[0][1].detail).toMatchObject({ aborted: false, abortReason: null });
  });
});

describe("single-flight", () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const seed = (action: string, ms: number) => dbh.rows.push({ org_id: ORG, action, created_at: ago(ms) });
  it("refuses while a recent started row has no later completion; audits it as concurrent", async () => {
    seed("newquip.cin7_diagnostic_run_started", 60_000);
    const r = await run(["A"]);
    expect(r).toEqual({ ok: false, error: "A run is already in progress, try again in a few minutes." });
    expect(m.creds).not.toHaveBeenCalled(); expect(m.request).not.toHaveBeenCalled();
    expect(refusals().map((i) => i.detail)).toEqual([{ reason: "concurrent" }]);
  });
  it("allows a run once a later completion row exists, or when the started row is older than 5 minutes", async () => {
    seed("newquip.cin7_diagnostic_run_started", 120_000); seed("newquip.cin7_diagnostic_run", 60_000);
    expect((await run(["A"])).ok).toBe(true);
    dbh.rows.length = 0; seed("newquip.cin7_diagnostic_run_started", 6 * 60_000);
    expect((await run(["A"])).ok).toBe(true);
  });
  it("another organisation's started row does not block", async () => {
    dbh.rows.push({ org_id: "other", action: "newquip.cin7_diagnostic_run_started", created_at: ago(1000) });
    expect((await run(["A"])).ok).toBe(true);
  });
  it("fails closed when the in-progress check itself fails", async () => {
    dbh.selectError = { message: "boom" };
    expect((await run(["A"])).ok).toBe(false);
    expect(m.creds).not.toHaveBeenCalled();
  });
  it("a second same-process call while the first is running is refused (in-flight flag)", async () => {
    vi.useFakeTimers();
    const first = runCin7DiagnosticAction(["A", "B"]);
    await vi.advanceTimersByTimeAsync(0);
    const second = await runCin7DiagnosticAction(["A"]);
    expect(second.error).toBe("A run is already in progress, try again in a few minutes.");
    await vi.runAllTimersAsync(); await first; vi.useRealTimers();
    dbh.rows.push({ org_id: ORG, action: "newquip.cin7_diagnostic_run", created_at: new Date(Date.now() + 1000).toISOString() }); // (logActivity is mocked, so add the completion row it would write)
    expect((await run(["A"])).ok).toBe(true); // the in-flight flag was released
  });
});

describe("diagnostics page", () => {
  it("exports maxDuration for the page's server action", () => expect(maxDuration).toBe(300));
  it("gate off: notFound before any identity/DB read; a page view never writes an audit row", async () => {
    vi.stubEnv("NEWQUIP_CIN7_DIAGNOSTIC_ENABLED", "false");
    await expect(Page()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(m.cur).not.toHaveBeenCalled();
    m.admin.mockRejectedValue(new Error("x"));
    vi.stubEnv("NEWQUIP_CIN7_DIAGNOSTIC_ENABLED", "true");
    await expect(Page()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(m.log).not.toHaveBeenCalled(); expect(dbh.rows).toEqual([]);
  });
  it("renders when enabled and authorised", async () => { await expect(Page()).resolves.toBeTruthy(); });
  it.each([
    ["gate off", () => vi.stubEnv("NEWQUIP_CIN7_DIAGNOSTIC_ENABLED", "false")],
    ["not admin", () => m.admin.mockRejectedValue(new Error("x"))],
    ["wrong org", () => m.org.mockRejectedValue(new Error("x"))],
    ["no cost rights", () => m.cost.mockResolvedValue(false)],
  ])("notFound when %s", async (_n, setup) => { setup(); await expect(Page()).rejects.toThrow("NEXT_NOT_FOUND"); });
});

const SRC = join(__dirname, "..", "..", "..");
const FILES = ["cin7/readonly-diagnostic.ts", "cin7/readonly-diagnostic-run.ts", "app/newquip-grower/cin7-diagnostic-actions.ts", "app/newquip-grower/diagnostics/authorise.ts", "app/newquip-grower/diagnostics/page.tsx", "app/newquip-grower/diagnostics/DiagnosticClient.tsx"];
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
