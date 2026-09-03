import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Every exported Server Action under src/app/reports/ that returns report
 * data must re-establish module access at the ACTION boundary — not rely on
 * middleware, a layout, or navigation visibility. A Server Action's request
 * path is the *referring page*, so a path-based module block never fires for
 * the action's own module (CCT-ADR-0010, src/lib/authorization.ts).
 *
 * Added 2026-09-03 after the Natas report was found enforcing only its
 * single-organization restriction with no module check, so a member of that
 * org with Reporting switched off could still be served its data by invoking
 * the action from another page. This pins the whole family rather than that
 * one file, so the same omission cannot reappear in a sibling — and so the
 * guard cannot be removed from one Natas action while the other keeps it.
 */
const ROOT = join(__dirname, "..", "..", "..");
const REPORTS_DIR = join(ROOT, "src", "app", "reports");

/**
 * Actions that legitimately do not call requireModuleAccess themselves, each
 * for a stated reason. Adding an entry here is a deliberate, reviewable
 * decision — which is the point of the allowlist.
 */
const EXEMPT: Record<string, string> = {
  createReorderReportPurchaseOrdersAction:
    "One-line delegate to Purchase Planner's own PO action, which independently enforces SUPPLIER_PLANNER_MODULE + billing + AAL2. Pinned separately by po-create-aal2.test.ts.",
  savePickingCalendarSettingsAction:
    "Role-gated with requireOrgAdmin, which excludes every ordinary member — and members are the only principals a module allow/deny toggle can restrict. Same deliberate precedent as /settings/instances (Phase 1.2).",
};

function listActionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      out.push(...listActionFiles(full));
    } else if (entry === "actions.ts") {
      out.push(full);
    }
  }
  return out;
}

/** Each top-level exported async function's name and body. */
function exportedActions(source: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /^export async function (\w+)\(/gm;
  const starts: { name: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) starts.push({ name: m[1], index: m.index });
  starts.forEach((s, i) => {
    out.push({ name: s.name, body: source.slice(s.index, i + 1 < starts.length ? starts[i + 1].index : source.length) });
  });
  return out;
}

describe("report Server Actions re-establish module access at the action boundary", () => {
  const files = listActionFiles(REPORTS_DIR);

  it("finds the report action files to scan", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("every exported report action calls requireModuleAccess, or is explicitly exempt with a reason", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file).split("\\").join("/");
      for (const action of exportedActions(readFileSync(file, "utf8"))) {
        if (action.body.includes("requireModuleAccess(")) continue;
        if (EXEMPT[action.name]) continue;
        offenders.push(`${rel}:${action.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every exemption still names a real action and carries a reason", () => {
    const allNames = new Set(files.flatMap((f) => exportedActions(readFileSync(f, "utf8")).map((a) => a.name)));
    for (const [name, reason] of Object.entries(EXEMPT)) {
      expect(allNames.has(name), `${name} is exempt but no longer exists — remove the stale exemption`).toBe(true);
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  /**
   * The specific regression this test was written for: both Natas actions,
   * not just one, and the single-org restriction kept alongside the module
   * gate rather than replaced by it.
   */
  it("both Natas actions carry the module guard AND keep the Casa das Natas restriction", () => {
    const source = readFileSync(join(REPORTS_DIR, "natas", "actions.ts"), "utf8");
    const actions = exportedActions(source);
    expect(actions.map((a) => a.name).sort()).toEqual(["loadNatasFilterOptionsAction", "loadNatasReportAction"]);

    for (const action of actions) {
      expect(action.body, `${action.name} lost its module guard`).toMatch(/requireModuleAccess\(REPORTS_MODULE\.href\)/);
      expect(action.body, `${action.name} lost its organization restriction`).toMatch(/requireCasaDasNatasOrg\(\)/);

      // Both conditions must precede any protected read.
      const moduleAt = action.body.indexOf("requireModuleAccess(");
      const orgAt = action.body.indexOf("requireCasaDasNatasOrg(");
      const dbAt = action.body.indexOf("createServiceRoleClient(");
      expect(dbAt).toBeGreaterThan(moduleAt);
      expect(dbAt).toBeGreaterThan(orgAt);
    }
  });

  it("Natas stays read-only — no admin, billing or assurance guard", () => {
    const source = readFileSync(join(REPORTS_DIR, "natas", "actions.ts"), "utf8");
    for (const action of exportedActions(source)) {
      expect(action.body).not.toMatch(/requireOrgAdmin\(|requirePrivilegedOrgAdmin\(|requireWriteAllowed\(|requireAal2\(/);
    }
  });
});
