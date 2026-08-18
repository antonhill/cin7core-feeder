import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Security re-audit closure, Blocker 6: `/api/sync*`'s 6 POST handlers used
 * to trust an `orgId` read straight out of the request body, behind only a
 * shared-secret check (`assertInternalAuth`, a single static `CRON_SECRET`
 * bearer token with no per-caller identity or rotation) — anyone holding
 * that one string could act as service-role against ANY org by changing the
 * JSON body. The POST handlers are now deleted (2026-08-18); this test is
 * the permanent guard against a future internal route reintroducing the
 * same shape: shared machine secret + request-body/query tenant identifier +
 * service-role client, with no session-derived authorization anywhere in
 * the handler.
 *
 * Deliberately narrow, so it doesn't flag every route handler in the app —
 * only ones combining all three ingredients. `/api/webhooks/lemonsqueezy`
 * (a real webhook, authenticated via HMAC signature over the payload, org
 * resolved server-side from a persisted checkout-token table, never from a
 * client-supplied org id) and `/api/delete-expired-trials`/
 * `/api/notify-ship-by-changes` (internal-secret-gated but derive their
 * scope entirely server-side, no request-supplied identifier at all) must
 * never trip this — see the "known-safe" tests below asserting exactly that.
 */

const INTERNAL_SECRET_PATTERN = /assertInternalAuth\(/;
const SERVICE_ROLE_PATTERN = /createServiceRoleClient\(/;
const SESSION_GUARD_PATTERN = /require(CurrentOrg|OrgAdmin|PrivilegedOrgAdmin|ModuleAccess|ModuleWrite|SuperAdmin|PrivilegedSuperAdmin)\(/;
const REVIEWED_SAFE_MARKER = /internal-auth-scan:\s*reviewed-safe/;

// An org/tenant-id-shaped property name: matches "orgId", "org_id", "OrgID",
// and — deliberately loose — any identifier merely CONTAINING that shape as
// a substring ("targetOrgId", "requestedOrgId") so a differently-prefixed
// variable name doesn't evade detection.
const ORG_ID_NAME = /org_?id/i;
// A whole-body variable assigned directly from the parsed request, e.g.
// `const body = await req.json();` or `const payload = request.json()`.
const JSON_BODY_ASSIGNMENT = /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:req|request)\.json\(\)/g;
// A destructuring assignment straight off the parsed request, e.g.
// `const { orgId } = await req.json();` — captures the `{ ... }` contents.
const JSON_BODY_DESTRUCTURE = /(?:const|let)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?(?:req|request)\.json\(\)/g;
// `searchParams.get("orgId")` / `.get('org_id')` for query-string-sourced ids.
const SEARCH_PARAMS_GET = /searchParams\s*\.\s*get\(\s*["'`](\w*org_?id\w*)["'`]/gi;

/**
 * Security re-audit adversarial-verification fix (2026-08-18): the original
 * version of this check was a single regex anchored on the literal
 * `body.orgId` shape of the deleted vulnerable code — an adversarial
 * verification pass constructed 3 syntactically-different reintroductions
 * of the identical vulnerability class (destructuring, a differently-named
 * whole-body variable, a differently-suffixed property name) and confirmed
 * none were caught. This function replaces the single regex with a
 * multi-step scan: find every variable the request body was parsed into
 * (whole-object or destructured), then check for ANY access to an
 * org/tenant-id-shaped property off it — not just one fixed spelling.
 *
 * Known, accepted limitation (documented rather than silently missed): a
 * tenant id derived INDIRECTLY — e.g. `body.instanceId` used to look up
 * `orgId` via a DB join — cannot be caught by a text-level scan; that shape
 * needs human review, not a static invariant. This function closes the
 * "same identifier, different syntax" gap, not the "different identifier
 * entirely" gap.
 */
function readsOrgIdFromRequest(handlerBody: string): boolean {
  // Whole-object assignment: const body = await req.json(); ... body.orgId
  for (const m of handlerBody.matchAll(JSON_BODY_ASSIGNMENT)) {
    const varName = m[1];
    const accessPattern = new RegExp(`\\b${varName}\\s*(?:\\.\\s*(\\w+)|\\[\\s*["'\`](\\w+)["'\`]\\s*\\])`, "g");
    for (const access of handlerBody.matchAll(accessPattern)) {
      const propName = access[1] ?? access[2];
      if (propName && ORG_ID_NAME.test(propName)) return true;
    }
  }
  // Destructuring assignment: const { orgId } = await req.json();
  // (also handles a rename, `orgId: targetOrg`, by checking the left side)
  for (const m of handlerBody.matchAll(JSON_BODY_DESTRUCTURE)) {
    const names = m[1].split(",").map((s) => s.trim().split(":")[0].trim());
    if (names.some((n) => ORG_ID_NAME.test(n))) return true;
  }
  // Query-string: searchParams.get("orgId")
  if ([...handlerBody.matchAll(SEARCH_PARAMS_GET)].length > 0) return true;
  return false;
}

function listRouteFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...listRouteFiles(full));
    } else if (entry === "route.ts") {
      files.push(full);
    }
  }
  return files;
}

/** Extracts each exported HTTP-method handler's own source text (from its `export async function X(` line to the next top-level `export` or EOF) — mirrors the brace-free slicing approach already used by the diagnostics-guard scan in settings/instances/actions.test.ts. */
function extractHandlers(source: string): { method: string; body: string }[] {
  const handlers: { method: string; body: string }[] = [];
  const re = /^export async function (GET|POST|PUT|PATCH|DELETE)\(/gm;
  let m: RegExpExecArray | null;
  const matches: { method: string; index: number }[] = [];
  while ((m = re.exec(source))) matches.push({ method: m[1], index: m.index });

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : source.length;
    handlers.push({ method: matches[i].method, body: source.slice(start, end) });
  }
  return handlers;
}

describe("internal privileged-route tenant-scoping boundary", () => {
  const apiDir = join(__dirname, "..", "..", "app", "api");
  const routeFiles = listRouteFiles(apiDir);

  it("finds at least the known 9 route.ts files (fails loudly rather than silently passing on zero files)", () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(9);
  });

  it("no handler combines a shared internal secret, a request-supplied org/tenant identifier, and a service-role client with no session-derived authorization", () => {
    const offenders: { file: string; method: string }[] = [];

    for (const file of routeFiles) {
      const source = readFileSync(file, "utf8");
      if (REVIEWED_SAFE_MARKER.test(source)) continue; // explicit, human-reviewed exemption
      for (const handler of extractHandlers(source)) {
        const usesInternalSecret = INTERNAL_SECRET_PATTERN.test(handler.body);
        const usesServiceRole = SERVICE_ROLE_PATTERN.test(handler.body);
        const readsOrgId = readsOrgIdFromRequest(handler.body);
        const hasSessionGuard = SESSION_GUARD_PATTERN.test(handler.body);

        if (usesInternalSecret && usesServiceRole && readsOrgId && !hasSessionGuard) {
          offenders.push({ file, method: handler.method });
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("confirms the 6 sync routes' POST handlers are gone, not just passing the scan by accident", () => {
    const syncRoutes = ["sync", "sync-sales", "sync-purchases", "sync-assembly-builds", "sync-product-availability", "sync-production-runs"];
    for (const name of syncRoutes) {
      const source = readFileSync(join(apiDir, name, "route.ts"), "utf8");
      expect(source).not.toMatch(/export async function POST/);
      expect(source).toMatch(/export async function GET/); // the real cron entry point must remain
    }
  });

  it("catches the 3 syntactic bypasses an adversarial verification pass found against the original single-regex version", () => {
    // Variant 1: destructuring directly, no `body` token at all.
    expect(readsOrgIdFromRequest('export async function POST(req: Request) {\n  const { orgId } = await req.json();\n}')).toBe(true);
    // Variant 2: a differently-named whole-body variable and a nested lookup
    // (the DB-join step itself can't be caught, but the direct property
    // read that seeds it can be, if it names orgId-shaped fields at all —
    // this variant specifically re-tests the "different variable name"
    // half of the original bypass, not the full indirect-DB-derivation case).
    expect(readsOrgIdFromRequest('export async function POST(req: Request) {\n  const payload = await req.json();\n  const orgId = payload.orgId;\n}')).toBe(true);
    // Variant 3: differently-named whole-body variable AND a differently-
    // suffixed property name.
    expect(readsOrgIdFromRequest('export async function POST(req: Request) {\n  const input = await request.json();\n  const targetOrgId = input.orgId;\n}')).toBe(true);
    // The literal original vulnerable shape must still be caught too.
    expect(readsOrgIdFromRequest('export async function POST(req: Request) {\n  const body = await req.json().catch(() => ({}));\n  const orgId = typeof body.orgId === "string" ? body.orgId : undefined;\n}')).toBe(true);
    // Query-string variant.
    expect(readsOrgIdFromRequest('export async function POST(req: Request) {\n  const orgId = new URL(req.url).searchParams.get("orgId");\n}')).toBe(true);
    // Negative control: a handler with no request-derived org id at all must not false-positive.
    expect(readsOrgIdFromRequest('export async function GET(req: Request) {\n  const db = createServiceRoleClient();\n  const results = await runCronRotation(db, "sync", () => {});\n}')).toBe(false);
  });

  it("known-safe routes correctly do NOT trip the scan (webhook + no-request-scope internal routes)", () => {
    const lemonsqueezy = readFileSync(join(apiDir, "webhooks", "lemonsqueezy", "route.ts"), "utf8");
    const deleteExpiredTrials = readFileSync(join(apiDir, "delete-expired-trials", "route.ts"), "utf8");
    const notifyShipByChanges = readFileSync(join(apiDir, "notify-ship-by-changes", "route.ts"), "utf8");
    for (const source of [lemonsqueezy, deleteExpiredTrials, notifyShipByChanges]) {
      for (const handler of extractHandlers(source)) {
        const usesInternalSecret = INTERNAL_SECRET_PATTERN.test(handler.body);
        const usesServiceRole = SERVICE_ROLE_PATTERN.test(handler.body);
        const readsOrgId = readsOrgIdFromRequest(handler.body);
        expect(usesInternalSecret && usesServiceRole && readsOrgId).toBe(false);
      }
    }
  });
});
