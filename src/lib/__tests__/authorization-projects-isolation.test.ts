import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";

// The REAL requireModuleAccess with the Rep-isolation rule for PROJECT DATA (Slice 1B). Only the session org and the database are replaced.
let db: FakeDb;
vi.mock("server-only", () => ({}));
vi.mock("@/lib/current-org", () => ({ requireCurrentOrg: vi.fn() }));
vi.mock("@/lib/billing", () => ({ requireWriteAllowed: vi.fn() }));
vi.mock("@/lib/demo-mode/context", () => ({ assertNoDemoImpersonation: vi.fn(async () => undefined) }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
import { requireModuleAccess } from "@/lib/authorization";
import { requireCurrentOrg } from "@/lib/current-org";

const ORG = "org-a";
const sign = (userId: string) => vi.mocked(requireCurrentOrg).mockResolvedValue({ userId, orgId: ORG, email: `${userId}@nq.test` } as never);
const member = (id: string, role: string, roles: string[] = []) => {
  db.rows("org_members").push({ org_id: ORG, user_id: id, role, allowed_modules: null });
  for (const r of roles) db.rows("org_functional_roles").push({ id: `${id}-${r}`, org_id: ORG, user_id: id, user_email: `${id}@nq.test`, role: r });
};
beforeEach(() => {
  db = new FakeDb(); db.rolesApplied = true; db.accessApplied = true; db.assignmentsApplied = true;
  db.rows("organizations").push({ id: ORG, disabled_modules: [] });
  member("adm", "admin"); member("est", "member", ["ESTIMATOR"]); member("mgr", "member", ["MANAGER"]); member("pm", "member", ["PROJECT_MANAGER"]); member("proc", "member", ["PROCUREMENT"]);
  member("rep", "member", ["REP"]); member("plain", "member"); member("sysadm", "member", ["ADMINISTRATOR"]);
});
const on = (v: boolean) => db.rows("newquip_access_settings").push({ org_id: ORG, rep_isolation_enabled: v });
const open = async (u: string, opts: { projectData?: boolean } = { projectData: true }) => { sign(u); try { await requireModuleAccess("/projects", opts); return "OK"; } catch (e) { return (e as Error).message; } };

describe("requireModuleAccess(..., { projectData: true })", () => {
  it("isolation OFF (default) or the switch not installed: identical to today for everyone", async () => {
    for (const u of ["rep", "plain", "sysadm", "adm"]) expect(await open(u), `${u} (no row)`).toBe("OK");
    on(false); for (const u of ["rep", "plain"]) expect(await open(u), `${u} (off)`).toBe("OK");
    db.accessApplied = false; db.rows("newquip_access_settings").length = 0; expect(await open("rep"), "not installed").toBe("OK");
  });
  it("isolation ON: owner/admin, explicit Estimator/Manager and explicit Project Manager / Procurement may use Projects; a Rep, a plain member and an Administrator-only user may not", async () => {
    on(true);
    for (const u of ["adm", "est", "mgr", "pm", "proc"]) expect(await open(u), u).toBe("OK");
    for (const u of ["rep", "plain", "sysadm"]) expect(await open(u), u).toBe("Not found.");
  });
  it("a call WITHOUT projectData (the approvals dashboard, which Reps use for their own quotations) is not narrowed by this rule", async () => {
    on(true); expect(await open("rep", {})).toBe("OK");
  });
  it("fails closed: an unreadable switch or role list denies, never allows", async () => {
    db.rows("newquip_access_settings").push({ org_id: ORG, rep_isolation_enabled: true });
    const real = db.from.bind(db);
    (db as unknown as { from: unknown }).from = (t: string) => t === "org_members" ? { select: (c: string) => (c === "role" ? { eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "boom" } }) }) }) } : real(t).select(c)) } : real(t);
    expect(await open("rep")).toBe("boom");
  });
});

describe("static guard: every Projects-module action that reads or changes project data passes projectData", () => {
  const dir = join(process.cwd(), "src", "app", "projects");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  it("no `requireModuleAccess(PROJECTS_MODULE.href)` call omits the isolation flag", () => {
    expect(files.length).toBeGreaterThan(5);
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(dir, f), "utf8");
      for (const m of src.matchAll(/requireModuleAccess\(PROJECTS_MODULE\.href([^)]*)\)/g)) if (!/projectData:\s*true/.test(m[1])) offenders.push(`${f}: ${m[0]}`);
      expect(src, f).not.toMatch(/requireModuleWrite\(PROJECTS_MODULE/);   // a write wrapper would bypass the flag
    }
    expect(offenders).toEqual([]);
  });
});
