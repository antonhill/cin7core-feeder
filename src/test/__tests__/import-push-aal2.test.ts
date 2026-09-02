import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * CCT-ADR-0015 (2026-09-02) classifies the user-triggered catalog push as an
 * ordinary-member action that ALSO requires a step-up (AAL2) — covering the
 * first chunk and every write-capable continuation as one family.
 *
 * The behavioural tests in src/app/import/__tests__/actions.test.ts prove
 * both halves work today, including the per-chunk expiry/recovery timeline.
 * This structural check proves the call sites cannot drift, and — just as
 * importantly — that user assurance has NOT been pushed down into the shared
 * sync layer the cron also travels through. A machine actor has no user
 * session and cannot satisfy requireAal2, so an assurance check anywhere
 * below these two actions would break the cron entirely.
 *
 * Same pattern as po-create-aal2.test.ts and bulk-write-aal2.test.ts, which
 * pin the other three AAL2 families.
 */
const ROOT = join(__dirname, "..", "..", "..");
const IMPORT_ACTIONS = join(ROOT, "src", "app", "import", "actions.ts");

/** Files on the machine (cron) path, or shared by both paths — none may require user assurance. */
const SHARED_AND_MACHINE_PATH = [
  ["src/app/api/sync/route.ts", join(ROOT, "src", "app", "api", "sync", "route.ts")],
  ["src/sync/sync-org.ts", join(ROOT, "src", "sync", "sync-org.ts")],
  ["src/sync/run-sync.ts", join(ROOT, "src", "sync", "run-sync.ts")],
  ["src/sync/cron-rotation.ts", join(ROOT, "src", "sync", "cron-rotation.ts")],
  ["src/lib/job-lock.ts", join(ROOT, "src", "lib", "job-lock.ts")],
  ["src/lib/sync-lock.ts", join(ROOT, "src", "lib", "sync-lock.ts")],
  ["src/cin7/products.ts", join(ROOT, "src", "cin7", "products.ts")],
  ["src/cin7/customers.ts", join(ROOT, "src", "cin7", "customers.ts")],
  ["src/cin7/suppliers.ts", join(ROOT, "src", "cin7", "suppliers.ts")],
  ["src/cin7/http.ts", join(ROOT, "src", "cin7", "http.ts")],
] as const;

/** The body of a top-level `function name(` — exported or not — up to the next top-level declaration. */
function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`^(export )?async function ${name}\\(`, "m"));
  expect(start, `${name} not found — was it renamed?`).toBeGreaterThan(-1);
  const next = source.slice(start + 1).search(/^(export )?async function /m);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

const ADMIN_GUARDS = /require(OrgAdmin|PrivilegedOrgAdmin|SuperAdmin|PrivilegedSuperAdmin)\(/;
const source = readFileSync(IMPORT_ACTIONS, "utf8");

describe("CCT-ADR-0015: startPushJobAction keeps its AAL2 guard", () => {
  const body = functionBody(source, "startPushJobAction");

  it("calls requireAal2", () => {
    expect(body).toMatch(/requireAal2\(/);
  });

  it("checks assurance before creating the push job and before the first chunk", () => {
    const aal2At = body.indexOf("requireAal2(");
    expect(aal2At).toBeGreaterThan(-1);
    // A job row created before assurance would be resumable by a later
    // continuation, defeating the guard at the point it matters most.
    expect(body.indexOf('.from("push_jobs")')).toBeGreaterThan(aal2At);
    expect(body.indexOf("resolveScope(")).toBeGreaterThan(aal2At);
    expect(body.indexOf("runNextChunk(")).toBeGreaterThan(aal2At);
  });

  it("keeps the module and billing gates ahead of it", () => {
    const aal2At = body.indexOf("requireAal2(");
    expect(body.indexOf("requireModuleAccess(")).toBeLessThan(aal2At);
    expect(body.indexOf("requireWriteAllowed(")).toBeLessThan(aal2At);
  });

  it("does NOT require an admin role — ADR-0015 keeps this member-accessible", () => {
    expect(body).not.toMatch(ADMIN_GUARDS);
  });
});

describe("CCT-ADR-0015: continuePushJobAction re-checks AAL2 on the write-capable branch", () => {
  const body = functionBody(source, "continuePushJobAction");

  it("calls requireAal2", () => {
    expect(body).toMatch(/requireAal2\(/);
  });

  it("checks assurance before the next chunk — so before the chunk lock and any Cin7 write", () => {
    const aal2At = body.indexOf("requireAal2(");
    expect(aal2At).toBeGreaterThan(-1);
    expect(body.indexOf("runNextChunk(")).toBeGreaterThan(aal2At);
  });

  it("only gates the running branch — a finished job's status is still readable", () => {
    const notRunningAt = body.indexOf('job.status !== "running"');
    expect(notRunningAt).toBeGreaterThan(-1);
    // The early return for a non-running job precedes the assurance check,
    // so reading a completed push never demands a step-up.
    expect(body.indexOf("requireAal2(")).toBeGreaterThan(notRunningAt);
  });

  it("keeps the org-scoped job lookup as the ownership boundary, ahead of assurance", () => {
    const aal2At = body.indexOf("requireAal2(");
    expect(body.indexOf('.eq("org_id", orgId)')).toBeLessThan(aal2At);
    expect(body.indexOf("requireModuleAccess(")).toBeLessThan(aal2At);
    expect(body.indexOf("requireWriteAllowed(")).toBeLessThan(aal2At);
  });

  it("does NOT require an admin role", () => {
    expect(body).not.toMatch(ADMIN_GUARDS);
  });

  it("does not fail, finish or delete the job on the assurance path — it must stay resumable", () => {
    const aal2At = body.indexOf("requireAal2(");
    const after = body.slice(aal2At);
    // Everything after the check is the normal chunk path; nothing between
    // the check and runNextChunk may mutate or destroy the job row.
    const between = after.slice(0, after.indexOf("runNextChunk("));
    expect(between).not.toMatch(/\.update\(|\.delete\(|status:\s*"(failed|done)"/);
  });
});

describe("CCT-ADR-0015: read-only and local-import boundaries stay ungated", () => {
  it.each(["importCsvAction", "getActivePushJobAction"])("%s does NOT require AAL2", (name) => {
    const body = functionBody(source, name);
    expect(body).not.toMatch(/requireAal2\(/);
    expect(body).not.toMatch(ADMIN_GUARDS);
  });
});

describe("CCT-ADR-0015: the machine/cron path stays independent of user assurance", () => {
  it.each(SHARED_AND_MACHINE_PATH)("%s contains no user-assurance check", (_name, path) => {
    expect(readFileSync(path, "utf8")).not.toMatch(/requireAal2\(/);
  });

  it("GET /api/sync is still authorized by assertInternalAuth alone", () => {
    const route = readFileSync(join(ROOT, "src", "app", "api", "sync", "route.ts"), "utf8");
    expect(route).toMatch(/assertInternalAuth\(/);
    expect(route).not.toMatch(/requireAal2\(|requireModuleAccess\(|requireWriteAllowed\(/);
  });

  it("the two guarded user actions are the only entry points into the user push path", () => {
    // If a third caller of runNextChunk appears it needs its own
    // classification — it would otherwise reach Cin7 writes unguarded.
    const callers = source.match(/(?<!async function )runNextChunk\(/g) ?? [];
    expect(callers).toHaveLength(2);
  });
});
