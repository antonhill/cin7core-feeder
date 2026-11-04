import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Migration 0122 removed ALL client-role (anon / authenticated) access to the NewQuip, approval, Project, claim and functional-role tables: only the service role may touch them.
 * That is only safe while no code reads those tables through a USER-JWT client (createSessionClient / createBrowserSupabaseClient / @supabase/ssr clients). This guard fails the
 * build if any user-JWT client file references a protected table, or if a NEW file starts using a user-JWT client (it then needs a deliberate review against 0122).
 */
const ROOT = join(__dirname, "..", "..", "..");
const PROTECTED = /\b(newquip_[a-z_]+|approval_(requests|events|notifications|policies|policy_events|settings)|org_functional_roles?(_events)?|projects|project_[a-z_]+|customer_rep_assignments|activity_log)\b/;
const USER_JWT_CLIENT = /createSessionClient|createBrowserSupabaseClient|createServerClient|createBrowserClient|supabase\/server-session|supabase\/browser/;
/** Reviewed files that use a user-JWT client; they read only org_members / organizations / auth, never a protected table. */
const REVIEWED = new Set([
  "src/actions/active-org.ts", "src/actions/auth.ts", "src/app/auth/callback/route.ts", "src/app/login/page.tsx", "src/app/mfa-challenge/page.tsx", "src/app/settings/security/page.tsx",
  "src/app/signup/actions.ts", "src/app/signup/page.tsx", "src/lib/current-org.ts", "src/lib/require-privileged.ts", "src/lib/require-super-admin.ts", "src/middleware.ts",
  "src/supabase/browser.ts", "src/supabase/server-session.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "__tests__") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "portal", "app"))].map((p) => ({ rel: relative(ROOT, p), text: readFileSync(p, "utf8") }));
const userJwtFiles = files.filter((f) => USER_JWT_CLIENT.test(f.text));

describe("0122 client boundary: protected tables are never read with a user JWT", () => {
  it("finds the user-JWT client files (guards against a silently empty scan)", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(userJwtFiles.length).toBeGreaterThan(5);
  });
  it("only reviewed files use a user-JWT client", () => {
    const unreviewed = userJwtFiles.map((f) => f.rel).filter((r) => !REVIEWED.has(r));
    expect(unreviewed).toEqual([]);
  });
  it("no user-JWT client file queries a protected table", () => {
    const offenders = userJwtFiles.filter((f) => /\.from\(\s*["'`]/.test(f.text) && [...f.text.matchAll(/\.from\(\s*["'`]([a-z_]+)["'`]/g)].some((m) => PROTECTED.test(m[1]))).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
  it("no user-JWT client file imports a store that reads protected tables (a store would otherwise receive the user client)", () => {
    const offenders = userJwtFiles.filter((f) => /from\s+["']@\/lib\/(approvals|projects|newquip-quotes|newquip-portal|newquip-assignments)\//.test(f.text)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
  it("the service-role client file is the only place the service key is read", () => {
    const keyReaders = files.filter((f) => f.text.includes("SUPABASE_SERVICE_ROLE_KEY")).map((f) => f.rel);
    expect(keyReaders).toContain("src/supabase/server.ts");
  });
});
