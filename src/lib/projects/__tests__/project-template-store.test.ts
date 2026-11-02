import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { createTemplate, saveTemplateVersion, setDefaultTemplate, setTemplateStatus, listTemplates, loadActiveTemplateVersion } from "../project-template-store";

// A tiny recording stub: every call is logged so a test can prove that NOTHING was written when a rule refused the request.
function stub(opts: { missingTable?: boolean; templateRow?: Record<string, unknown> | null } = {}) {
  const calls: string[] = [];
  const result = (data: unknown) => (opts.missingTable ? { data: null, error: { message: 'relation "public.newquip_project_templates" does not exist' } } : { data, error: null });
  const chain = (table: string, op: string): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ["eq", "order", "limit", "select", "insert", "update"]) c[m] = (...a: unknown[]) => { if (m === "insert" || m === "update") calls.push(`${op === "from" ? m : op}:${table}`); return chain(table, m === "insert" || m === "update" ? m : op); };
    c.maybeSingle = async () => result(opts.templateRow ?? null);
    c.single = async () => result({ id: "t1", name: "X", description: "", status: "ACTIVE", is_default: false, created_by_email: "m@x", created_at: "", updated_at: "", version: 1, template_id: "t1", stages: [], reason: "" });
    c.then = (res: (v: unknown) => unknown) => res(result([]));
    return c;
  };
  return { db: { from: (t: string) => chain(t, "from") } as never, calls };
}
const rows = [{ name: "Deposit", percent: "40" }, { name: "Rest", percent: "60" }];
const mgr = { isManager: true }, member = { isManager: false };

describe("template writes are gated and validated before anything is written", () => {
  it("a non-manager cannot create, version, retire or set a default", async () => {
    const s = stub();
    await expect(createTemplate(s.db, member, "a@x", { orgId: "o", name: "N", stages: rows })).rejects.toThrow(/Only a manager/);
    await expect(saveTemplateVersion(s.db, member, "a@x", { orgId: "o", templateId: "t", stages: rows, reason: "r" })).rejects.toThrow(/Only a manager/);
    await expect(setTemplateStatus(s.db, member, { orgId: "o", templateId: "t", status: "RETIRED" })).rejects.toThrow(/Only a manager/);
    await expect(setDefaultTemplate(s.db, member, { orgId: "o", templateId: "t" })).rejects.toThrow(/Only a manager/);
    expect(s.calls).toEqual([]);
  });
  it("invalid stages, a blank name and a missing reason write nothing", async () => {
    const s = stub();
    await expect(createTemplate(s.db, mgr, "m@x", { orgId: "o", name: "N", stages: [{ name: "A", percent: "99" }] })).rejects.toThrow(/99\.00%/);
    await expect(createTemplate(s.db, mgr, "m@x", { orgId: "o", name: "  ", stages: rows })).rejects.toThrow(/needs a name/);
    await expect(saveTemplateVersion(s.db, mgr, "m@x", { orgId: "o", templateId: "t", stages: rows, reason: " " })).rejects.toThrow(/reason/);
    expect(s.calls).toEqual([]);
  });
  it("a retired template cannot be edited, and cannot be the default", async () => {
    const s = stub({ templateRow: { id: "t", status: "RETIRED" } });
    await expect(saveTemplateVersion(s.db, mgr, "m@x", { orgId: "o", templateId: "t", stages: rows, reason: "r" })).rejects.toThrow(/retired/);
    await expect(setDefaultTemplate(s.db, mgr, { orgId: "o", templateId: "t" })).rejects.toThrow(/active template/);
    expect(s.calls.filter((c) => c.startsWith("insert"))).toEqual([]);
  });
  it("applying a retired template to a new project is refused", async () => {
    const s = stub({ templateRow: { id: "t", name: "Old", status: "RETIRED" } });
    await expect(loadActiveTemplateVersion(s.db, "o", "t")).rejects.toThrow(/retired/);
  });
});

describe("before migration 0111 is applied", () => {
  it("reads report unavailable (null), never an empty list, and writes explain why", async () => {
    const s = stub({ missingTable: true });
    expect(await listTemplates(s.db, "o")).toBeNull();
    await expect(createTemplate(s.db, mgr, "m@x", { orgId: "o", name: "N", stages: rows })).rejects.toThrow(/migration pending/);
    await expect(loadActiveTemplateVersion(s.db, "o", "t")).rejects.toThrow(/migration pending/);
  });
});
