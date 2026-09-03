import { describe, expect, it } from "vitest";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Capability ownership between the Cin7 Instances settings surface and the
 * Diagnostics surface.
 *
 * These two lived in one action file, which made directory-based action
 * ownership impossible to reason about and blocked a MODULES-derived
 * structural guard: `settings/instances` is an org-toggleable module route,
 * while Diagnostics is deliberately NOT in MODULES and is super-admin only.
 *
 * This pins the split so the two capabilities cannot re-merge.
 */
const ROOT = join(__dirname, "..", "..", "..");
const INSTANCES = join(ROOT, "src", "app", "settings", "instances", "actions.ts");
const DIAGNOSTICS = join(ROOT, "src", "app", "settings", "diagnostics", "actions.ts");
const DIAG_PAGE = join(ROOT, "src", "app", "settings", "diagnostics", "page.tsx");

function exportedFunctions(path: string): { name: string; body: string }[] {
  const source = readFileSync(path, "utf8");
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const out: { name: string; body: string }[] = [];
  for (const st of sf.statements) {
    const exported = ts.canHaveModifiers(st) && ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isFunctionDeclaration(st) && st.name) out.push({ name: st.name.text, body: st.getText(sf) });
  }
  return out;
}

describe("Diagnostics and Cin7 Instances are separate action capabilities", () => {
  const instances = exportedFunctions(INSTANCES);
  const diagnostics = exportedFunctions(DIAGNOSTICS);

  it("9. no debug action remains exported from the Instances action surface", () => {
    expect(instances.filter((a) => a.name.startsWith("debug")).map((a) => a.name)).toEqual([]);
  });

  it("6. the Instances action surface is exactly its four capability actions", () => {
    expect(instances.map((a) => a.name).sort()).toEqual(["deleteInstance", "listInstances", "testInstanceConnection", "upsertInstance"]);
  });

  it("7. all 31 debug actions are exported from the Diagnostics surface", () => {
    expect(diagnostics.filter((a) => a.name.startsWith("debug"))).toHaveLength(31);
  });

  it("8. debugProbeUpdatedSinceFiltering is retained even though it has no caller", () => {
    // Relocation, not diagnostics cleanup — see docs/PROJECT-NOTES on how these
    // are reached (temporarily wired to a page, not a permanent UI feature).
    expect(diagnostics.map((a) => a.name)).toContain("debugProbeUpdatedSinceFiltering");
  });

  it("2. every Diagnostics action independently requires privileged super-admin", () => {
    const missing = diagnostics.filter((a) => !a.body.includes("requirePrivilegedSuperAdmin(")).map((a) => a.name);
    expect(missing).toEqual([]);
  });

  /**
   * The load-bearing one. Diagnostics is deliberately non-org-toggleable, so
   * gating it on an org module toggle would be wrong rather than stricter.
   */
  it("3. no Diagnostics action is gated on any org-toggleable module", () => {
    const offenders = diagnostics.filter((a) => /requireModule(Access|Write)\(/.test(a.body)).map((a) => a.name);
    expect(offenders).toEqual([]);
    // Comments legitimately explain WHY the module gate is absent, so strip
    // them before asserting no CODE reference to an org-toggleable module.
    const code = readFileSync(DIAGNOSTICS, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/INSTANCES_MODULE/);
    expect(code).not.toMatch(/module-nav/);
  });

  it("4. the Diagnostics instance list checks privilege before touching the database", () => {
    const action = diagnostics.find((a) => a.name === "listDiagnosticInstancesAction");
    expect(action, "listDiagnosticInstancesAction not found").toBeDefined();
    const guardAt = action!.body.indexOf("requirePrivilegedSuperAdmin(");
    const dbAt = action!.body.indexOf("createServiceRoleClient(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(dbAt).toBeGreaterThan(guardAt);
  });

  it("5. the Diagnostics instance list selects only the fields its page renders", () => {
    const action = diagnostics.find((a) => a.name === "listDiagnosticInstancesAction")!;
    expect(action.body).toMatch(/\.select\("id, name, account_id"\)/);
    // Instances-settings metadata must not leak into the Diagnostics DTO.
    for (const field of ["application_key", "key_last4", "keyLast4", "fulfilment_view_start_date", "created_at:"]) {
      expect(action.body, `${field} must not be exposed to Diagnostics`).not.toContain(field);
    }
  });

  it("1. the Diagnostics page imports its actions from its own capability, not from Instances", () => {
    const page = readFileSync(DIAG_PAGE, "utf8");
    expect(page).not.toMatch(/from "\.\.\/instances\/actions"/);
    expect(page).toMatch(/from "\.\/actions"/);
  });

  it("10. no caller outside Diagnostics imports a moved debug action", () => {
    // The Instances page must not reach across into the Diagnostics surface.
    const instancesPage = readFileSync(join(ROOT, "src", "app", "settings", "instances", "page.tsx"), "utf8");
    expect(instancesPage).not.toMatch(/diagnostics\/actions/);
    expect(instancesPage).not.toMatch(/\bdebug[A-Z]\w*/);
  });

  it("the Instances surface keeps its own role/assurance guards unchanged by the split", () => {
    const byName = new Map(instances.map((a) => [a.name, a.body]));
    expect(byName.get("upsertInstance")).toMatch(/requirePrivilegedOrgAdmin\(/);
    expect(byName.get("deleteInstance")).toMatch(/requirePrivilegedOrgAdmin\(/);
    expect(byName.get("listInstances")).toMatch(/requirePrivilegedOrgAdmin\(/);
  });
});
