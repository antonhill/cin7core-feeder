import { describe, expect, it, vi } from "vitest";
import { updateProjectDetails } from "../project-details-store";

vi.mock("server-only", () => ({}));

// A tiny recording stand-in for the Supabase client: one `projects` row, every query's filters and any update payload are captured.
function fakeDb(row: Record<string, unknown> | null, updateRows: unknown[] | null = [{ id: "p1" }]) {
  const rec: { filters: Array<[string, unknown]>; update: Record<string, unknown> | null } = { filters: [], update: null };
  const chain = (mode: "select" | "update"): unknown => new Proxy({}, {
    get: (_t, prop: string) => {
      if (prop === "then") return undefined;
      if (prop === "eq") return (c: string, v: unknown) => { rec.filters.push([c, v]); return chain(mode); };
      if (prop === "maybeSingle") return () => Promise.resolve({ data: row, error: null });
      if (prop === "select") return () => (mode === "update" ? Promise.resolve({ data: updateRows, error: null }) : chain(mode));
      return () => chain(mode);
    },
  });
  const db = { from: () => ({ select: () => chain("select"), update: (p: Record<string, unknown>) => { rec.update = p; return chain("update"); } }) };
  return { db: db as never, rec };
}
const PATCH = { project_manager: "pm@x.co.za", start_date: "2026-11-03", target_completion_date: "2027-02-01" };

describe("updateProjectDetails", () => {
  it("writes exactly the three columns, scoped by organisation and project, and returns what it replaced", async () => {
    const { db, rec } = fakeDb({ project_manager: "old@x.co.za", start_date: null, target_completion_date: null, billing_scope: "PROJECT" });
    const r = await updateProjectDetails(db, "org-1", "p1", PATCH);
    expect(Object.keys(rec.update!).sort()).toEqual(["project_manager", "start_date", "target_completion_date"]);
    expect(rec.filters).toEqual(expect.arrayContaining([["org_id", "org-1"], ["id", "p1"]]));
    expect(r.before).toEqual({ project_manager: "old@x.co.za", start_date: null, target_completion_date: null });
    expect(r.after).toEqual(PATCH);
  });
  it("a project of another organisation (or none) is 'not found' and nothing is written", async () => {
    const { db, rec } = fakeDb(null);
    await expect(updateProjectDetails(db, "org-1", "p9", PATCH)).rejects.toThrow("Project not found.");
    expect(rec.update).toBeNull();
  });
  it("a variation's internal billing project has no details of its own", async () => {
    const { db, rec } = fakeDb({ project_manager: null, start_date: null, target_completion_date: null, billing_scope: "VARIATION" });
    await expect(updateProjectDetails(db, "org-1", "p1", PATCH)).rejects.toThrow(/edit the original project/);
    expect(rec.update).toBeNull();
  });
  it("a project that has a parent is an internal billing scope whatever its scope label says", async () => {
    const { db, rec } = fakeDb({ project_manager: null, start_date: null, target_completion_date: null, billing_scope: "PROJECT", parent_project_id: "base" });
    await expect(updateProjectDetails(db, "org-1", "p1", PATCH)).rejects.toThrow(/edit the original project/);
    expect(rec.update).toBeNull();
  });
  it("an update that matches no row is reported, not silently accepted", async () => {
    const { db } = fakeDb({ project_manager: null, start_date: null, target_completion_date: null, billing_scope: "PROJECT" }, []);
    await expect(updateProjectDetails(db, "org-1", "p1", PATCH)).rejects.toThrow("Project not found.");
  });
});
