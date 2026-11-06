import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Region placement (see docs/vercel-region-placement.md).
 *
 * The app's functions run in dub1 (next to the Supabase database in eu-west-1);
 * the Cin7 sync routes stay in iad1, because they page through the Cin7 API
 * (about +300 ms per request from Europe) and gain nothing from being near the
 * database. `preferredRegion` cannot do this on Vercel (deprecated, accepts only
 * auto/global/home), so the per-function override lives in vercel.json. These
 * tests stop the pin drifting away from the cron list and the route folders.
 */
const root = join(__dirname, "..", "..", "..");
const config = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")) as {
  regions?: string[];
  crons?: { path: string }[];
  functions?: Record<string, { regions?: string[] }>;
};

const apiDir = join(root, "src", "app", "api");
const syncRouteDirs = readdirSync(apiDir).filter((d) => d.startsWith("sync") && existsSync(join(apiDir, d, "route.ts")));

/** vercel.json function keys are globs; only a trailing-`*` folder glob is used. */
function globMatches(glob: string, file: string): boolean {
  const re = new RegExp("^" + glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$");
  return re.test(file);
}

describe("vercel.json region placement", () => {
  it("runs the application in dub1 only", () => {
    expect(config.regions).toEqual(["dub1"]);
  });

  it("finds the sync routes it is meant to pin", () => {
    expect(syncRouteDirs.sort()).toEqual([
      "sync",
      "sync-assembly-builds",
      "sync-product-availability",
      "sync-production-runs",
      "sync-purchases",
      "sync-sales",
    ]);
  });

  it("pins every sync route to iad1 and nothing else", () => {
    const pins = Object.entries(config.functions ?? {}).filter(([, v]) => v.regions);
    for (const [glob, v] of pins) expect(v.regions, glob).toEqual(["iad1"]);
    const pinned = (file: string) => pins.some(([glob]) => globMatches(glob, file));
    for (const d of syncRouteDirs) expect(pinned(`src/app/api/${d}/route.ts`), d).toBe(true);
    const others = readdirSync(apiDir).filter((d) => !syncRouteDirs.includes(d));
    for (const d of others) expect(pinned(`src/app/api/${d}/route.ts`), d).toBe(false);
    expect(pinned("src/app/projects/page.tsx")).toBe(false);
  });

  it("every Cin7-sync cron path is a pinned route", () => {
    const syncCrons = (config.crons ?? []).map((c) => c.path).filter((p) => p.startsWith("/api/sync"));
    expect(syncCrons.length).toBe(syncRouteDirs.length);
    for (const p of syncCrons) expect(syncRouteDirs).toContain(p.replace("/api/", ""));
  });
});
