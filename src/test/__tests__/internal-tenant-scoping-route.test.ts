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

const ORG_ID_PATTERN = /\b(?:body|params|query|searchParams)\s*(?:\.|\[["'`])?\s*(?:get\(["'`])?(?:org_?[Ii]d)\b/;
const INTERNAL_SECRET_PATTERN = /assertInternalAuth\(/;
const SERVICE_ROLE_PATTERN = /createServiceRoleClient\(/;
const SESSION_GUARD_PATTERN = /require(CurrentOrg|OrgAdmin|PrivilegedOrgAdmin|ModuleAccess|ModuleWrite|SuperAdmin|PrivilegedSuperAdmin)\(/;
const REVIEWED_SAFE_MARKER = /internal-auth-scan:\s*reviewed-safe/;

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
        const readsOrgIdFromRequest = ORG_ID_PATTERN.test(handler.body);
        const hasSessionGuard = SESSION_GUARD_PATTERN.test(handler.body);

        if (usesInternalSecret && usesServiceRole && readsOrgIdFromRequest && !hasSessionGuard) {
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

  it("known-safe routes correctly do NOT trip the scan (webhook + no-request-scope internal routes)", () => {
    const lemonsqueezy = readFileSync(join(apiDir, "webhooks", "lemonsqueezy", "route.ts"), "utf8");
    const deleteExpiredTrials = readFileSync(join(apiDir, "delete-expired-trials", "route.ts"), "utf8");
    const notifyShipByChanges = readFileSync(join(apiDir, "notify-ship-by-changes", "route.ts"), "utf8");
    for (const source of [lemonsqueezy, deleteExpiredTrials, notifyShipByChanges]) {
      for (const handler of extractHandlers(source)) {
        const usesInternalSecret = INTERNAL_SECRET_PATTERN.test(handler.body);
        const usesServiceRole = SERVICE_ROLE_PATTERN.test(handler.body);
        const readsOrgIdFromRequest = ORG_ID_PATTERN.test(handler.body);
        expect(usesInternalSecret && usesServiceRole && readsOrgIdFromRequest).toBe(false);
      }
    }
  });
});
