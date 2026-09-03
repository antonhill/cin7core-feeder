import { describe, expect, it } from "vitest";
import ts from "typescript";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Every exported Server Action under src/app/reports/ that can be invoked
 * must re-establish module access at the ACTION boundary — not rely on
 * middleware, a layout, or navigation visibility. A Server Action's request
 * path is the *referring page*, so a path-based module block never fires for
 * the action's own module (CCT-ADR-0010, src/lib/authorization.ts).
 *
 * Added 2026-09-03 after the Natas report was found enforcing only its
 * single-organization restriction with no module check, so a member of that
 * org with Reporting switched off could still be served its data by invoking
 * the action from another page.
 *
 * HARDENED after review, twice over:
 *
 *   1. A role guard does NOT substitute for a module guard. `requireOrgAdmin`
 *      performs no module check, while `requireModuleAccess` narrows EVERY
 *      non-super-admin by their `allowed_modules` allow-list — with no role
 *      condition — and applies the org's `disabled_modules` to everyone. Team
 *      management can set `allowed_modules` for any member id, owners and
 *      admins included. So an owner/admin can pass a role check while being
 *      denied the module. Role-only exemptions are therefore not accepted for
 *      an org-toggleable report module.
 *
 *   2. Discovery is AST-based, not a single declaration regex. The first
 *      version recognised only `export async function foo(...)`, so an
 *      exported async arrow binding would have escaped the whole-family claim
 *      entirely — a known syntactic escape has no place in a security
 *      regression test. Same approach as the Cin7 mutation registry guard.
 *      An exported callable this scanner cannot classify FAILS the test
 *      rather than being silently skipped.
 */
const ROOT = join(__dirname, "..", "..", "..");
const REPORTS_DIR = join(ROOT, "src", "app", "reports");

/**
 * The only accepted reason for an action not to call requireModuleAccess
 * itself: it is a pure delegate into another action that independently
 * re-establishes its own module boundary. Adding an entry here is a
 * deliberate, reviewable decision.
 *
 * NOTE: a role-only guard (requireOrgAdmin / requireSuperAdmin) is NOT a
 * valid reason — see the header. Do not add one.
 */
const DELEGATING_EXEMPTIONS: Record<string, string> = {
  createReorderReportPurchaseOrdersAction:
    "Pure one-line delegate to Purchase Planner's createSupplierPlanPurchaseOrdersAction, which independently enforces SUPPLIER_PLANNER_MODULE + billing write-plan + AAL2. The delegation itself is pinned by po-create-aal2.test.ts.",
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

export interface DiscoveredAction {
  file: string;
  name: string;
  body: string;
  /** True when the exported binding is callable but this scanner could not resolve a function body for it. */
  unclassified: boolean;
}

function hasExportModifier(node: ts.Node): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

/**
 * Every exported callable in one `actions.ts`, discovered from the AST:
 * function declarations, and `export const foo = async (...) => {}` /
 * `= async function () {}` bindings alike. A `"use server"` file may only
 * export async functions, so an exported binding whose initializer is not a
 * resolvable function is reported as unclassified rather than ignored.
 */
export function discoverExportedActions(relPath: string, sourceText: string): DiscoveredAction[] {
  const sourceFile = ts.createSourceFile(relPath, sourceText, ts.ScriptTarget.Latest, true);
  const found: DiscoveredAction[] = [];

  for (const statement of sourceFile.statements) {
    if (!hasExportModifier(statement)) continue;

    if (ts.isFunctionDeclaration(statement) && statement.name) {
      found.push({ file: relPath, name: statement.name.text, body: statement.getText(sourceFile), unclassified: false });
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const init = decl.initializer;
        // Types and interfaces never reach here (they are not variable statements).
        if (!init) continue;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          found.push({ file: relPath, name: decl.name.text, body: decl.getText(sourceFile), unclassified: false });
        } else if (ts.isCallExpression(init) || ts.isIdentifier(init) || ts.isPropertyAccessExpression(init)) {
          // Could be a callable produced elsewhere (a wrapper, a re-export) —
          // this scanner cannot see its guards, so fail rather than pass it.
          found.push({ file: relPath, name: decl.name.text, body: decl.getText(sourceFile), unclassified: true });
        }
      }
    }
  }

  return found;
}

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

const MODULE_GUARD = /requireModuleAccess\(/;
const ROLE_ONLY_GUARDS = /require(OrgAdmin|SuperAdmin|PrivilegedOrgAdmin|PrivilegedSuperAdmin)\(/;

describe("report Server Actions re-establish module access at the action boundary", () => {
  const files = listActionFiles(REPORTS_DIR);
  const actions = files.flatMap((f) => discoverExportedActions(toPosix(relative(ROOT, f)), readFileSync(f, "utf8")));

  it("finds the report action files and their exported actions", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(actions.length).toBeGreaterThan(50);
  });

  it("no exported callable is left unclassified — an unresolvable shape fails rather than passing", () => {
    const unclassified = actions.filter((a) => a.unclassified).map((a) => `${a.file}:${a.name}`);
    expect(unclassified).toEqual([]);
  });

  it("every exported report action calls requireModuleAccess, or is an explicitly listed delegate", () => {
    const offenders = actions
      .filter((a) => !MODULE_GUARD.test(a.body) && !DELEGATING_EXEMPTIONS[a.name])
      .map((a) => `${a.file}:${a.name}`);
    expect(offenders).toEqual([]);
  });

  /** A role guard authorizes WHO, never WHICH MODULE — see this file's header. */
  it("no action substitutes a role guard for the module guard", () => {
    const offenders = actions
      .filter((a) => ROLE_ONLY_GUARDS.test(a.body) && !MODULE_GUARD.test(a.body))
      .map((a) => `${a.file}:${a.name}`);
    expect(offenders).toEqual([]);
  });

  it("every delegating exemption still names a real action, carries a reason, and really delegates", () => {
    const byName = new Map(actions.map((a) => [a.name, a]));
    for (const [name, reason] of Object.entries(DELEGATING_EXEMPTIONS)) {
      const action = byName.get(name);
      expect(action, `${name} is exempt but no longer exists — remove the stale exemption`).toBeDefined();
      expect(reason.length).toBeGreaterThan(40);
      expect(action!.body, `${name} is exempt as a delegate but no longer delegates`).toMatch(/return \w+Action\(/);
    }
  });

  /** The specific regression this test was written for. */
  it("both Natas actions carry the module guard AND keep the Casa das Natas restriction", () => {
    const natas = actions.filter((a) => a.file.endsWith("reports/natas/actions.ts"));
    expect(natas.map((a) => a.name).sort()).toEqual(["loadNatasFilterOptionsAction", "loadNatasReportAction"]);

    for (const action of natas) {
      expect(action.body, `${action.name} lost its module guard`).toMatch(/requireModuleAccess\(REPORTS_MODULE\.href\)/);
      expect(action.body, `${action.name} lost its organization restriction`).toMatch(/requireCasaDasNatasOrg\(\)/);
      const dbAt = action.body.indexOf("createServiceRoleClient(");
      expect(dbAt).toBeGreaterThan(action.body.indexOf("requireModuleAccess("));
      expect(dbAt).toBeGreaterThan(action.body.indexOf("requireCasaDasNatasOrg("));
    }
  });

  it("Natas stays read-only — no admin, billing or assurance guard", () => {
    for (const action of actions.filter((a) => a.file.endsWith("reports/natas/actions.ts"))) {
      expect(action.body).not.toMatch(/requireOrgAdmin\(|requirePrivilegedOrgAdmin\(|requireWriteAllowed\(|requireAal2\(/);
    }
  });

  /** The corrected finding: the settings write needs BOTH module and role. */
  it("savePickingCalendarSettingsAction carries BOTH the module guard and the role guard, before the DB client", () => {
    const action = actions.find((a) => a.name === "savePickingCalendarSettingsAction");
    expect(action, "savePickingCalendarSettingsAction not found — was it renamed?").toBeDefined();

    expect(action!.body).toMatch(/requireModuleAccess\(PICKING_CALENDAR_MODULE\.href\)/);
    expect(action!.body).toMatch(/requireOrgAdmin\(/);

    const dbAt = action!.body.indexOf("createServiceRoleClient(");
    const upsertAt = action!.body.indexOf(".upsert(");
    expect(dbAt).toBeGreaterThan(action!.body.indexOf("requireModuleAccess("));
    expect(dbAt).toBeGreaterThan(action!.body.indexOf("requireOrgAdmin("));
    expect(upsertAt).toBeGreaterThan(dbAt);

    // Local settings write — not a Cin7 write family.
    expect(action!.body).not.toMatch(/requireWriteAllowed\(|requireAal2\(/);
  });

  it("savePickingCalendarSettingsAction is NOT exempt — a role guard is not a substitute", () => {
    expect(Object.keys(DELEGATING_EXEMPTIONS)).not.toContain("savePickingCalendarSettingsAction");
  });
});

/** The AST scanner's own discovery, against synthetic sources. */
describe("report-action scanner discovery", () => {
  const find = (src: string) => discoverExportedActions("src/app/reports/fixture/actions.ts", src);

  it("discovers an exported async function declaration", () => {
    expect(find(`export async function loadThing() { await requireModuleAccess("/reports"); }`).map((a) => a.name)).toEqual(["loadThing"]);
  });

  it("discovers an exported async ARROW binding — the escape the first version missed", () => {
    const found = find(`export const loadThing = async () => { return 1; };`);
    expect(found.map((a) => a.name)).toEqual(["loadThing"]);
    expect(found[0].unclassified).toBe(false);
  });

  it("discovers an exported async function EXPRESSION binding", () => {
    expect(find(`export const loadThing = async function () { return 1; };`).map((a) => a.name)).toEqual(["loadThing"]);
  });

  it("flags an exported binding it cannot resolve, rather than ignoring it", () => {
    expect(find(`export const loadThing = wrap(inner);`)[0].unclassified).toBe(true);
    expect(find(`export const loadThing = otherAction;`)[0].unclassified).toBe(true);
  });

  it("ignores non-exported functions and exported non-callables", () => {
    expect(find(`async function helper() {}`)).toEqual([]);
    expect(find(`export const LIMIT = 100;`)).toEqual([]);
    expect(find(`export interface Foo { a: string }`)).toEqual([]);
  });
});
