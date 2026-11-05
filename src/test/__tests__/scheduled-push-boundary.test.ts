import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * The scheduled master-data push is default-deny (src/sync/scheduled-push-policy.ts), enforced in ONE place: syncOrgInstances, for the machine actor.
 * The behavioural tests in src/sync/__tests__/scheduled-push-gate.test.ts prove the gate works. This structural check proves nothing can reach the Cin7
 * master-data writes while stepping AROUND it, which a behavioural test of the gate itself cannot see:
 *  - a new module that imports syncInstance (the real push) directly, e.g. a second cron route;
 *  - a new caller of pushProduct / pushCustomer / pushSupplier;
 *  - the gate drifting out of sync-org, or the cron route changing actor;
 *  - the five read-only syncs acquiring a write path, or being swept up in the gate.
 * A legitimate new caller must be added to the lists below consciously, with the owner's approval of how it is authorised.
 */
const ROOT = join(__dirname, "..", "..", "..");
const SRC = join(ROOT, "src");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "__tests__" && name !== "node_modules") sourceFiles(p, out); }
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(ROOT, p).split("\\").join("/");
const ALL = sourceFiles(SRC);
const read = (r: string) => readFileSync(join(ROOT, r), "utf8");

describe("scheduled master-data push cannot be reached around the default-deny gate", () => {
  it("syncInstance (the push) is imported by exactly one production module: sync-org.ts", () => {
    const importers = ALL.filter((f) => /import\s*\{[^}]*\bsyncInstance\b[^}]*\}\s*from\s*"@\/sync\/run-sync"/.test(readFileSync(f, "utf8"))).map(rel);
    expect(importers).toEqual(["src/sync/sync-org.ts"]);
  });

  it("the master-data write functions are called only by run-sync (the scheduled/Import path) and the super-admin diagnostics action", () => {
    const callers = ALL.filter((f) => !rel(f).startsWith("src/cin7/") && /\b(pushProduct|pushCustomer|pushSupplier|pushProductionBom)\(/.test(readFileSync(f, "utf8"))).map(rel).sort();
    expect(callers).toEqual(["src/app/settings/diagnostics/actions.ts", "src/sync/run-sync.ts"]);
  });

  it("sync-org gates the machine actor through the policy before any lock or push", () => {
    const src = read("src/sync/sync-org.ts");
    expect(src).toMatch(/from "@\/sync\/scheduled-push-policy"/);
    expect(src).toMatch(/const scheduled = actor === "system"/);
    expect(src).toMatch(/scheduledPushAllowedInstanceIds\(\)/);
    // the gate is applied before the route lock and before runInstances is first called
    const gate = src.indexOf("const allInstances = allowedIds");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(src.indexOf("acquireSyncRouteLock(db"));
    expect(gate).toBeLessThan(src.indexOf("runInstances(allInstances)"));
  });

  it("the /api/sync cron route calls syncOrgInstances as the machine actor and does not import the push directly", () => {
    const src = read("src/app/api/sync/route.ts");
    expect(src).toMatch(/syncOrgInstances\([^)]*"system"/);
    expect(src).not.toMatch(/@\/sync\/run-sync/);
  });

  it("the policy defaults to deny: it has no wildcard branch and no fallback allow-list", () => {
    const src = read("src/sync/scheduled-push-policy.ts");
    expect(src).toMatch(/if \(!raw\) return new Set\(\)/);
    expect(src).not.toMatch(/return true;|=== "\*"|\.includes\("\*"\)/);
  });

  it.each([
    "src/sync/sync-sales.ts",
    "src/sync/sync-purchases.ts",
    "src/sync/sync-assembly-builds.ts",
    "src/sync/sync-production-runs.ts",
    "src/sync/sync-product-availability.ts",
  ])("%s stays read-only against Cin7 and is not subject to the gate", (file) => {
    const src = read(file);
    expect(src).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
    expect(src).not.toMatch(/\b(pushProduct|pushCustomer|pushSupplier|ensureReferenceExists)\b/);
    // imports (not comments, which may legitimately mention the push): none of them reaches the push orchestration or the gate
    expect(src).not.toMatch(/from\s*"@\/sync\/(run-sync|sync-org|scheduled-push-policy)"/);
    expect(src).not.toMatch(/from\s*"@\/cin7\/(products|customers|suppliers)"/);
  });
});
