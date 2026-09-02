import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * CCT-ADR-0015 (2026-09-02) classifies two further ordinary-member write
 * families as also requiring a step-up (AAL2):
 *
 *   - Bulk Pricing price-tier update  (applyPriceUpdatesAction)
 *   - Data Audit merge near-duplicates (the four merge actions)
 *
 * and deliberately leaves Data Audit's OTHER four write families member-only
 * with no added assurance. The behavioural tests in
 * src/app/pricing/__tests__/actions.test.ts and
 * src/app/audit/__tests__/actions.test.ts prove both halves work today; this
 * structural check proves the call sites cannot drift — the same pattern as
 * po-create-aal2.test.ts, which pins the third AAL2 family.
 *
 * It fails if either required guard disappears, if an admin guard is
 * introduced (ADR-0015 keeps both member-accessible), or if the merge
 * assurance check is moved into a helper shared with the no-AAL2 families.
 */
const ROOT = join(__dirname, "..", "..", "..");
const PRICING_ACTIONS = join(ROOT, "src", "app", "pricing", "actions.ts");
const AUDIT_ACTIONS = join(ROOT, "src", "app", "audit", "actions.ts");
const APPLY_FIXES = join(ROOT, "src", "audit", "apply-fixes.ts");
const APPLY_PARTY_FIXES = join(ROOT, "src", "audit", "apply-party-fixes.ts");

/** The body of a top-level `function name(` — exported or not — up to the next top-level declaration. */
function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`^(export )?async function ${name}\\(`, "m"));
  expect(start, `${name} not found — was it renamed?`).toBeGreaterThan(-1);
  const next = source.slice(start + 1).search(/^(export )?async function /m);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

const ADMIN_GUARDS = /require(OrgAdmin|PrivilegedOrgAdmin|SuperAdmin|PrivilegedSuperAdmin)\(/;

describe("CCT-ADR-0015: Bulk Pricing price-tier update keeps its AAL2 guard", () => {
  const source = readFileSync(PRICING_ACTIONS, "utf8");
  const body = functionBody(source, "applyPriceUpdatesAction");

  it("calls requireAal2", () => {
    expect(body).toMatch(/requireAal2\(/);
  });

  it("checks assurance before loading credentials and before the Cin7 write", () => {
    const aal2At = body.indexOf("requireAal2(");
    expect(aal2At).toBeGreaterThan(-1);
    expect(body.indexOf("loadCin7Credentials(")).toBeGreaterThan(aal2At);
    expect(body.indexOf("applyProductFixes(")).toBeGreaterThan(aal2At);
  });

  it("keeps the module and billing gates alongside it", () => {
    expect(body).toMatch(/requireModuleAccess\(/);
    expect(body).toMatch(/requireWriteAllowed\(/);
  });

  it("does NOT require an admin role — ADR-0015 keeps this member-accessible", () => {
    expect(body).not.toMatch(ADMIN_GUARDS);
  });

  it("leaves the read-only pricing preview ungated by assurance or billing", () => {
    const preview = functionBody(source, "loadPricingPreviewAction");
    expect(preview).not.toMatch(/requireAal2\(/);
    expect(preview).not.toMatch(/requireWriteAllowed\(/);
    expect(preview).not.toMatch(ADMIN_GUARDS);
  });
});

describe("CCT-ADR-0015: Data Audit merge keeps its AAL2 guard at the shared boundary", () => {
  const source = readFileSync(AUDIT_ACTIONS, "utf8");
  const merge = functionBody(source, "mergeAction");

  it("the shared mergeAction boundary calls requireAal2", () => {
    expect(merge).toMatch(/requireAal2\(/);
  });

  it("checks assurance before loading credentials and before the merge write", () => {
    const aal2At = merge.indexOf("requireAal2(");
    expect(aal2At).toBeGreaterThan(-1);
    expect(merge.indexOf("loadCin7Credentials(")).toBeGreaterThan(aal2At);
    expect(merge.indexOf("await merge(")).toBeGreaterThan(aal2At);
  });

  it("keeps the module and billing gates alongside it", () => {
    expect(merge).toMatch(/requireModuleAccess\(/);
    expect(merge).toMatch(/requireWriteAllowed\(/);
  });

  it("does NOT require an admin role — ADR-0015 keeps merge member-accessible", () => {
    expect(merge).not.toMatch(ADMIN_GUARDS);
  });

  it.each(["mergeCategoryAction", "mergeBrandAction", "mergeUOMAction", "mergeTagAction"])(
    "%s still delegates to that boundary rather than merging on its own",
    (name) => {
      const body = functionBody(source, name);
      expect(body).toMatch(/return mergeAction\(/);
      // A second, unguarded merge path would bypass the assurance check.
      expect(body).not.toMatch(/loadCin7Credentials\(/);
    }
  );

  it("mergeAction is the ONLY caller of the boundary — a new caller must be classified first", () => {
    const callers = source.match(/(?<!async function )mergeAction\(/g) ?? [];
    // Exactly the four merge actions above.
    expect(callers).toHaveLength(4);
  });
});

describe("CCT-ADR-0015: the other four Data Audit write families must NOT inherit AAL2", () => {
  const source = readFileSync(AUDIT_ACTIONS, "utf8");

  it.each([
    "applyProductFixesAction",
    "applyAttributeTemplateAction",
    "applySupplierAssignmentAction",
    "applyPartyFixesAction",
  ])("%s stays member-only with no added assurance", (name) => {
    const body = functionBody(source, name);
    expect(body).not.toMatch(/requireAal2\(/);
    expect(body).not.toMatch(ADMIN_GUARDS);
    // The gates they already had are still required.
    expect(body).toMatch(/requireModuleAccess\(/);
    expect(body).toMatch(/requireWriteAllowed\(/);
  });

  it("the read-only audit scans stay ungated by assurance", () => {
    for (const name of ["runProductAuditAction", "runPartyAuditAction"]) {
      expect(functionBody(source, name)).not.toMatch(/requireAal2\(/);
    }
  });

  /**
   * The load-bearing check. applyProductFixes/applyPartyFixes are shared by
   * the no-AAL2 families above AND by Replenish's reorder-point edits, which
   * ADR-0015 also classifies as needing no added assurance. Pushing the merge
   * check down into either would silently over-gate all of them.
   */
  it.each([
    ["src/audit/apply-fixes.ts", APPLY_FIXES],
    ["src/audit/apply-party-fixes.ts", APPLY_PARTY_FIXES],
  ])("assurance has not been moved into the shared %s helper", (_name, path) => {
    expect(readFileSync(path, "utf8")).not.toMatch(/requireAal2\(/);
  });

  it("reorder-point edits, which share the same helper, gain no assurance", () => {
    const reorder = readFileSync(join(ROOT, "src", "app", "replenish", "reorder-points", "actions.ts"), "utf8");
    expect(reorder).not.toMatch(/requireAal2\(/);
  });
});
