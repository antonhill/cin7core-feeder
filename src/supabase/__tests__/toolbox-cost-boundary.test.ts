import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Migration 0127 removed ALL client-role (anon / authenticated) access to the Toolbox cost / margin tables and revoked EXECUTE on the cost / margin report functions
 * (only the service role may use them). That is only safe while no code reaches them through a USER-JWT client (createSessionClient / createBrowserSupabaseClient /
 * @supabase/ssr clients). This guard fails the build if a user-JWT client file queries one of those tables or calls one of those functions, and - together with the REVIEWED list
 * in rep-isolation-client-boundary.test.ts - a NEW user-JWT client file fails the build until it has been reviewed against both 0122 and 0127.
 */
const ROOT = join(__dirname, "..", "..", "..");
const COST_TABLES = ["products", "quotes", "quote_lines", "sale_lines", "assembly_bom_lines", "assembly_consumption_lines", "production_bom_items", "production_operations", "production_orders"];
const COST_FUNCTIONS = ["report_sales_by_product", "report_sales_pivot", "report_sales_facts", "report_reorder", "recompute_product_hash"];
const USER_JWT_CLIENT = /createSessionClient|createBrowserSupabaseClient|createServerClient|createBrowserClient|supabase\/server-session|supabase\/browser/;
/** Same reviewed set as the 0122 guard: these files use a user-JWT client and touch only org_members / organizations / super_admins / create_self_serve_org. */
const REVIEWED = new Set([
  "src/actions/active-org.ts", "src/actions/auth.ts", "src/app/auth/callback/route.ts", "src/app/login/page.tsx", "src/app/mfa-challenge/page.tsx", "src/app/presenter/actions.ts", "src/app/settings/security/page.tsx",
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

describe("0127 client boundary: cost / margin tables and report functions are never reached with a user JWT", () => {
  it("finds the user-JWT client files (guards against a silently empty scan)", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(userJwtFiles.length).toBeGreaterThan(5);
  });
  it("only reviewed files use a user-JWT client (a new one must be reviewed against 0127 and added to REVIEWED)", () => {
    expect(userJwtFiles.map((f) => f.rel).filter((r) => !REVIEWED.has(r))).toEqual([]);
  });
  it("no user-JWT client file queries a cost / margin table", () => {
    const offenders = userJwtFiles
      .filter((f) => [...f.text.matchAll(/\.from\(\s*["'`]([a-z_]+)["'`]/g)].some((m) => COST_TABLES.includes(m[1])))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
  it("no user-JWT client file calls a cost / margin report function", () => {
    const offenders = userJwtFiles.filter((f) => COST_FUNCTIONS.some((fn) => f.text.includes(fn))).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
  it("every application caller of those RPCs uses the service-role client (sanity: they do exist, none in a user-JWT file)", () => {
    const callers = files.filter((f) => COST_FUNCTIONS.some((fn) => new RegExp(`\\.rpc\\(\\s*["'\`]${fn}["'\`]`).test(f.text)));
    expect(callers.length).toBeGreaterThan(0);
    expect(callers.filter((f) => USER_JWT_CLIENT.test(f.text)).map((f) => f.rel)).toEqual([]);
  });
  it("the REVIEWED list stays in step with the 0122 guard", () => {
    const g = readFileSync(join(__dirname, "rep-isolation-client-boundary.test.ts"), "utf8");
    for (const r of REVIEWED) expect(g).toContain(`"${r}"`);
  });
});
