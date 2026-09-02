import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * CCT-ADR-0015 (2026-09-02) classifies Purchase Order creation as an
 * ordinary-member action that ALSO requires a step-up (AAL2). The behavioural
 * tests in src/app/supplier-planner/__tests__/actions.test.ts prove the guard
 * works today; this narrow structural check proves the *call site* cannot lose
 * it silently — the same "a fix covers the examples an audit named, a sibling
 * ships unguarded later" pattern the other guards in this directory exist for.
 *
 * Deliberately narrow: it pins the one action that owns the PO write family,
 * rather than scanning every action in the app. The reorder-report entry point
 * (createReorderReportPurchaseOrdersAction) delegates straight to this action
 * and is covered transitively — asserted below so that delegation can't be
 * quietly replaced with a second, unguarded create path.
 */
const ROOT = join(__dirname, "..", "..", "..");
const PLANNER_ACTIONS = join(ROOT, "src", "app", "supplier-planner", "actions.ts");
const REORDER_ACTIONS = join(ROOT, "src", "app", "reports", "reorder-report", "actions.ts");

function actionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  expect(start, `${name} not found — was it renamed?`).toBeGreaterThan(-1);
  const next = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

describe("CCT-ADR-0015: Purchase Order creation keeps its AAL2 guard", () => {
  const plannerSource = readFileSync(PLANNER_ACTIONS, "utf8");
  const body = actionBody(plannerSource, "createSupplierPlanPurchaseOrdersAction");

  it("calls requireAal2", () => {
    expect(body).toMatch(/requireAal2\(/);
  });

  it("checks assurance before creating anything in Cin7", () => {
    const aal2At = body.indexOf("requireAal2(");
    const createAt = body.indexOf("createPurchaseOrder(");
    const credsAt = body.indexOf("loadCin7Credentials(");
    expect(aal2At).toBeGreaterThan(-1);
    expect(createAt).toBeGreaterThan(aal2At);
    expect(credsAt).toBeGreaterThan(aal2At);
  });

  it("keeps the module and billing gates alongside it", () => {
    expect(body).toMatch(/requireModuleAccess\(/);
    expect(body).toMatch(/requireWriteAllowed\(/);
  });

  it("does NOT require an org-admin role — ADR-0015 keeps this member-accessible", () => {
    expect(body).not.toMatch(/requireOrgAdmin\(/);
    expect(body).not.toMatch(/requirePrivilegedOrgAdmin\(/);
  });

  it("the reorder-report entry point still delegates rather than creating its own PO", () => {
    const reorderSource = readFileSync(REORDER_ACTIONS, "utf8");
    const delegate = actionBody(reorderSource, "createReorderReportPurchaseOrdersAction");
    expect(delegate).toMatch(/createSupplierPlanPurchaseOrdersAction\(/);
    // If this ever calls the Cin7 write directly it needs its own guard.
    expect(delegate).not.toMatch(/createPurchaseOrder\(/);
  });
});
