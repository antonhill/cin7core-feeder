import { describe, expect, it } from "vitest";
import ts from "typescript";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Every exported Server Action inside an ORG-TOGGGLEABLE module's route tree
 * must re-establish that module's authorization at the ACTION boundary — not
 * rely on middleware, a layout, or navigation visibility. A Server Action's
 * request path is the *referring page*, so a path-based module block never
 * fires for the action's own module (CCT-ADR-0010, src/lib/authorization.ts).
 *
 * HISTORY, because each widening came from a real defect:
 *
 *   - Written for /reports after the Natas report was found enforcing only
 *     its single-organization restriction, with no module check.
 *   - Hardened when a role guard (requireOrgAdmin) was wrongly accepted as a
 *     substitute on the Picking Calendar settings write. It is not one:
 *     requireModuleAccess narrows EVERY non-super-admin by their
 *     allowed_modules — with no role condition — and applies the org's
 *     disabled_modules to everyone, while requireOrgAdmin performs no module
 *     check at all. A role guard answers WHO, never WHICH capability.
 *   - Hardened again when six export syntaxes proved invisible to a
 *     declaration-only scan.
 *   - Generalised here from /reports to ALL org-toggleable modules, after a
 *     14-module audit found the same defect in Purchase Planner's settings
 *     write and all four Cin7 Instances actions.
 *
 * The module list is DERIVED FROM CODE (module-nav's MODULES) rather than
 * duplicated here, so a module added there is covered on the day it is added.
 */
const ROOT = join(__dirname, "..", "..", "..");
const MODULE_NAV = join(ROOT, "src", "app", "module-nav.tsx");
const DIAGNOSTICS_ACTIONS = "src/app/settings/diagnostics/actions.ts";

/**
 * Delegation is the ONLY accepted exception: the action holds no logic of its
 * own and calls another action that independently establishes the required
 * boundary. Keyed by FULLY-QUALIFIED identity, never by bare action name.
 *
 * NOT accepted, and deliberately impossible to express here: role-only,
 * billing-only, assurance-only or location-based exemptions.
 */
const DELEGATING_EXEMPTIONS: Record<string, { target: string; reason: string }> = {
  "src/app/reports/reorder-report/actions.ts:createReorderReportPurchaseOrdersAction": {
    target: "createSupplierPlanPurchaseOrdersAction",
    reason: "Pure delegate to Purchase Planner's PO action, which independently enforces SUPPLIER_PLANNER_MODULE + billing write-plan + AAL2. Pinned by po-create-aal2.test.ts.",
  },
  "src/app/audit/actions.ts:mergeCategoryAction": { target: "mergeAction", reason: "Delegates to the private mergeAction, which enforces AUDIT_MODULE + billing + AAL2 for all four merge actions." },
  "src/app/audit/actions.ts:mergeBrandAction": { target: "mergeAction", reason: "Delegates to the private mergeAction, which enforces AUDIT_MODULE + billing + AAL2 for all four merge actions." },
  "src/app/audit/actions.ts:mergeUOMAction": { target: "mergeAction", reason: "Delegates to the private mergeAction, which enforces AUDIT_MODULE + billing + AAL2 for all four merge actions." },
  "src/app/audit/actions.ts:mergeTagAction": { target: "mergeAction", reason: "Delegates to the private mergeAction, which enforces AUDIT_MODULE + billing + AAL2 for all four merge actions." },
};

const ROLE_GUARDS = /require(OrgAdmin|SuperAdmin|PrivilegedOrgAdmin|PrivilegedSuperAdmin)\(/;

// ---------------------------------------------------------------- MODULES

export interface ModuleEntry {
  constant: string;
  href: string;
  routeRoot: string;
}

/**
 * Reads module-nav's MODULES array and resolves each referenced constant's
 * literal href. Any shape that cannot be resolved statically throws, so an
 * unreadable module list fails the suite rather than silently shrinking it.
 */
export function deriveModules(source: string): ModuleEntry[] {
  const sf = ts.createSourceFile("module-nav.tsx", source, ts.ScriptTarget.Latest, true);

  const hrefByConstant = new Map<string, string>();
  let modulesArray: ts.ArrayLiteralExpression | undefined;

  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const decl of st.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      if (decl.name.text === "MODULES") {
        if (!ts.isArrayLiteralExpression(decl.initializer)) throw new Error("MODULES is not an array literal — cannot derive modules");
        modulesArray = decl.initializer;
        continue;
      }
      if (ts.isObjectLiteralExpression(decl.initializer)) {
        const href = decl.initializer.properties.find(
          (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "href"
        );
        if (href && ts.isStringLiteral(href.initializer)) hrefByConstant.set(decl.name.text, href.initializer.text);
      }
    }
  }

  if (!modulesArray) throw new Error("MODULES not found in module-nav — cannot derive modules");

  return modulesArray.elements.map((el) => {
    if (!ts.isIdentifier(el)) throw new Error(`MODULES contains a non-identifier entry (${el.getText(sf)}) this guard cannot resolve`);
    const href = hrefByConstant.get(el.text);
    if (!href) throw new Error(`MODULES references ${el.text} but its literal href could not be resolved`);
    return { constant: el.text, href, routeRoot: join("src", "app", href.replace(/^\//, "")) };
  });
}

// ------------------------------------------------------- action discovery

export interface DiscoveredAction {
  file: string;
  name: string;
  body: string;
  unclassified: boolean;
}

function hasExportModifier(node: ts.Node): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

/**
 * Every top-level export in one `actions.ts`. Analysable shapes come back
 * with a body to inspect; every other shape comes back UNCLASSIFIED and fails
 * the suite, because this scanner resolves no imports and follows no
 * re-exports and so cannot prove such an export is guarded. Only exports the
 * AST proves are type-only are dropped.
 */
export function discoverExportedActions(relPath: string, sourceText: string): DiscoveredAction[] {
  const sourceFile = ts.createSourceFile(relPath, sourceText, ts.ScriptTarget.Latest, true);
  const found: DiscoveredAction[] = [];
  const add = (name: string, body: string, unclassified: boolean) => found.push({ file: relPath, name, body, unclassified });

  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (statement.isTypeOnly) continue;
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          if (element.isTypeOnly) continue;
          add(element.name.text, statement.getText(sourceFile), true);
        }
      } else if (clause && ts.isNamespaceExport(clause)) {
        add(`* as ${clause.name.text}`, statement.getText(sourceFile), true);
      } else {
        add("* (star re-export)", statement.getText(sourceFile), true);
      }
      continue;
    }
    if (ts.isExportAssignment(statement)) {
      add("default", statement.getText(sourceFile), true);
      continue;
    }
    if (!hasExportModifier(statement)) continue;
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name) add(statement.name.text, statement.getText(sourceFile), false);
      else add("default (anonymous function)", statement.getText(sourceFile), true);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const init = decl.initializer;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) add(decl.name.text, decl.getText(sourceFile), false);
        else if (ts.isCallExpression(init) || ts.isIdentifier(init) || ts.isPropertyAccessExpression(init)) add(decl.name.text, decl.getText(sourceFile), true);
      }
    }
  }
  return found;
}

// ----------------------------------------------------------------- scan

function listActionFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
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

const toPosix = (p: string) => p.split("\\").join("/");

const MODULES = deriveModules(readFileSync(MODULE_NAV, "utf8"));

/** Most-specific route root wins, so a nested module is never satisfied by its parent's gate. */
function owningModule(relPath: string): ModuleEntry | undefined {
  let best: ModuleEntry | undefined;
  for (const m of MODULES) {
    const root = toPosix(m.routeRoot) + "/";
    if (relPath.startsWith(root) && (!best || m.routeRoot.length > best.routeRoot.length)) best = m;
  }
  return best;
}

interface Row extends DiscoveredAction {
  module: ModuleEntry;
  key: string;
}

function scanAll(): Row[] {
  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const m of MODULES) {
    for (const file of listActionFiles(join(ROOT, m.routeRoot))) {
      const rel = toPosix(relative(ROOT, file));
      if (seen.has(rel)) continue;
      seen.add(rel);
      const owner = owningModule(rel);
      if (!owner) throw new Error(`${rel} has no owning module — route-root mapping is wrong`);
      for (const a of discoverExportedActions(rel, readFileSync(file, "utf8"))) {
        rows.push({ ...a, module: owner, key: `${rel}:${a.name}` });
      }
    }
  }
  return rows;
}

describe("org-toggleable module actions re-establish their module boundary", () => {
  const rows = scanAll();

  it("derives the module inventory from code, not a duplicated list", () => {
    expect(MODULES.length).toBeGreaterThanOrEqual(14);
    expect(MODULES.map((m) => m.href)).toContain("/reports/picking-calendar");
    expect(rows.length).toBeGreaterThan(100);
  });

  it("no exported callable is left unclassified — an unresolvable shape fails rather than passing", () => {
    expect(rows.filter((r) => r.unclassified).map((r) => r.key)).toEqual([]);
  });

  /** THE INVARIANT. Exact module, not merely "some module guard". */
  it("every action calls requireModuleAccess/Write with ITS OWN module, or is a listed delegate", () => {
    const offenders: string[] = [];
    for (const r of rows) {
      if (DELEGATING_EXEMPTIONS[r.key]) continue;
      const expected = new RegExp(`require(ModuleAccess|ModuleWrite)\\(${r.module.constant}\\.href\\)`);
      if (!expected.test(r.body)) offenders.push(`${r.key} (expected ${r.module.constant})`);
    }
    expect(offenders).toEqual([]);
  });

  /** A nested feature must not be satisfied by its parent module's gate. */
  it("nested Picking Calendar actions require their OWN module, not Reporting's", () => {
    const nested = rows.filter((r) => r.file.startsWith("src/app/reports/picking-calendar/"));
    expect(nested.length).toBeGreaterThan(0);
    for (const r of nested) {
      expect(r.module.constant).toBe("PICKING_CALENDAR_MODULE");
      expect(r.body, `${r.key} must use its own module`).toMatch(/requireModuleAccess\(PICKING_CALENDAR_MODULE\.href\)/);
    }
  });

  it("no action substitutes a role guard for the module guard", () => {
    const offenders = rows
      .filter((r) => !DELEGATING_EXEMPTIONS[r.key] && ROLE_GUARDS.test(r.body) && !/require(ModuleAccess|ModuleWrite)\(/.test(r.body))
      .map((r) => r.key);
    expect(offenders).toEqual([]);
  });

  it("every delegating exemption still exists and still delegates to its recorded target", () => {
    const byKey = new Map(rows.map((r) => [r.key, r]));
    for (const [key, { target, reason }] of Object.entries(DELEGATING_EXEMPTIONS)) {
      const row = byKey.get(key);
      expect(row, `${key} is exempt but no longer exists — remove the stale exemption`).toBeDefined();
      expect(reason.length).toBeGreaterThan(40);
      expect(row!.body, `${key} is exempt as a delegate but no longer calls ${target}`).toMatch(new RegExp(`return\\s+${target}\\(`));
    }
  });

  /** PR #95 established Diagnostics as a separate, deliberately non-toggleable capability. */
  it("Diagnostics is excluded: not in MODULES, and never scanned as an Instances action", () => {
    expect(MODULES.map((m) => m.constant)).not.toContain("DIAGNOSTICS_MODULE");
    expect(readFileSync(MODULE_NAV, "utf8")).toMatch(/export const DIAGNOSTICS_MODULE/);
    expect(rows.map((r) => r.file)).not.toContain(DIAGNOSTICS_ACTIONS);
    const code = readFileSync(join(ROOT, DIAGNOSTICS_ACTIONS), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/requireModule(Access|Write)\(/);
  });
});

/** Report-specific regressions retained from the guard this file replaces. */
describe("retained per-feature module-boundary regressions", () => {
  const rows = scanAll();
  const byKey = new Map(rows.map((r) => [r.key, r]));

  it("both Natas actions require Reporting AND keep the Casa das Natas restriction, read-only", () => {
    const natas = rows.filter((r) => r.file === "src/app/reports/natas/actions.ts");
    expect(natas.map((r) => r.name).sort()).toEqual(["loadNatasFilterOptionsAction", "loadNatasReportAction"]);
    for (const r of natas) {
      expect(r.body).toMatch(/requireModuleAccess\(REPORTS_MODULE\.href\)/);
      expect(r.body).toMatch(/requireCasaDasNatasOrg\(\)/);
      const db = r.body.indexOf("createServiceRoleClient(");
      expect(db).toBeGreaterThan(r.body.indexOf("requireModuleAccess("));
      expect(db).toBeGreaterThan(r.body.indexOf("requireCasaDasNatasOrg("));
      expect(r.body).not.toMatch(/requireOrgAdmin\(|requireWriteAllowed\(|requireAal2\(/);
    }
  });

  it("Picking Calendar settings keeps BOTH module and role, before the DB write, with no billing or assurance", () => {
    const r = byKey.get("src/app/reports/picking-calendar/actions.ts:savePickingCalendarSettingsAction");
    expect(r, "savePickingCalendarSettingsAction not found").toBeDefined();
    expect(r!.body).toMatch(/requireModuleAccess\(PICKING_CALENDAR_MODULE\.href\)/);
    expect(r!.body).toMatch(/requireOrgAdmin\(/);
    const db = r!.body.indexOf("createServiceRoleClient(");
    expect(db).toBeGreaterThan(r!.body.indexOf("requireModuleAccess("));
    expect(db).toBeGreaterThan(r!.body.indexOf("requireOrgAdmin("));
    expect(r!.body.indexOf(".upsert(")).toBeGreaterThan(db);
    expect(r!.body).not.toMatch(/requireWriteAllowed\(|requireAal2\(/);
  });

  it("Purchase Planner settings requires module then role, before the DB write", () => {
    const r = byKey.get("src/app/supplier-planner/actions.ts:savePurchasePlannerSettingsAction")!;
    expect(r.body).toMatch(/requireModuleAccess\(SUPPLIER_PLANNER_MODULE\.href\)/);
    expect(r.body.indexOf("requireOrgAdmin(")).toBeGreaterThan(r.body.indexOf("requireModuleAccess("));
    expect(r.body.indexOf("createServiceRoleClient(")).toBeGreaterThan(r.body.indexOf("requireOrgAdmin("));
    expect(r.body).not.toMatch(/requireWriteAllowed\(|requireAal2\(/);
  });

  it("all four Cin7 Instances actions require the Instances module before any protected work", () => {
    for (const name of ["listInstances", "upsertInstance", "deleteInstance", "testInstanceConnection"]) {
      const r = byKey.get(`src/app/settings/instances/actions.ts:${name}`)!;
      expect(r, `${name} not found`).toBeDefined();
      const mod = r.body.indexOf("requireModuleAccess(INSTANCES_MODULE.href)");
      expect(mod, `${name} lost its module guard`).toBeGreaterThan(-1);
      const next = name === "testInstanceConnection" ? r.body.indexOf("loadInstanceCreds(") : r.body.indexOf("requirePrivilegedOrgAdmin(");
      expect(next, `${name} module guard must precede its role/credential step`).toBeGreaterThan(mod);
      const db = r.body.indexOf("createServiceRoleClient(");
      if (db > -1) expect(db).toBeGreaterThan(mod);
    }
    // testInstanceConnection must NOT gain assurance it did not have.
    expect(byKey.get("src/app/settings/instances/actions.ts:testInstanceConnection")!.body).not.toMatch(/requireAal2\(/);
  });
});

/** The scanner's own discovery, against synthetic sources. */
describe("module-boundary scanner discovery", () => {
  const find = (src: string) => discoverExportedActions("src/app/reports/fixture/actions.ts", src);

  it("detects a function declaration, an arrow binding and a function expression", () => {
    expect(find(`export async function a(){}`)[0].unclassified).toBe(false);
    expect(find(`export const b = async () => {};`)[0].unclassified).toBe(false);
    expect(find(`export const c = async function () {};`)[0].unclassified).toBe(false);
  });

  it.each([
    ["export { x };", "named export"],
    [`export { x } from "./other";`, "re-export"],
    [`export * from "./other";`, "star re-export"],
    [`export * as ns from "./other";`, "namespace re-export"],
    ["export default x;", "default identifier"],
    ["export default wrap(x);", "default call"],
    ["export default async function () {}", "anonymous default"],
    ["export const d = wrap(inner);", "unresolved initializer"],
  ])("fails closed on %s (%s)", (src) => {
    const found = find(src);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((f) => f.unclassified)).toBe(true);
  });

  it("ignores proven type-only exports and non-callables", () => {
    expect(find(`export type { Foo };`)).toEqual([]);
    expect(find(`export type { A } from "./other";`)).toEqual([]);
    expect(find(`export const LIMIT = 1;`)).toEqual([]);
    expect(find(`export interface Foo { a: string }`)).toEqual([]);
    expect(find(`export { x, type Foo };`).map((f) => f.name)).toEqual(["x"]);
  });

  it("resolves the module inventory, and FAILS CLOSED on a shape it cannot resolve", () => {
    const ok = deriveModules(`const A_MODULE = { href: "/a" };\nexport const MODULES = [A_MODULE];`);
    expect(ok).toEqual([{ constant: "A_MODULE", href: "/a", routeRoot: join("src", "app", "a") }]);
    expect(() => deriveModules(`export const MODULES = [...SPREAD];`)).toThrow(/cannot resolve/);
    expect(() => deriveModules(`const A_MODULE = { href: someVar };\nexport const MODULES = [A_MODULE];`)).toThrow(/could not be resolved/);
    expect(() => deriveModules(`export const NOT_MODULES = [];`)).toThrow(/MODULES not found/);
  });
});
