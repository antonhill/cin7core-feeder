import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Security re-audit final closure, regression guardrail #3: `createServiceRoleClient()`
 * bypasses RLS entirely — every call site is a place where APPLICATION code,
 * not the database, is the only thing enforcing tenant isolation. The
 * closure matrix's own §6.6 investigation found all 145 then-current call
 * sites clean (each is either itself a guard, preceded by a real guard, or
 * has a fully server-derived tenant scope) but flagged that nothing stops a
 * *future* unguarded call site from being added silently. This test is that
 * stop: a new file calling `createServiceRoleClient(` that isn't in
 * scripts/service-role-allowlist.json fails the build, forcing a deliberate,
 * reviewed addition to the allowlist rather than a silent new trust boundary.
 */

const ROOT = join(__dirname, "..", "..", "..");
const ALLOWLIST_PATH = join(ROOT, "scripts", "service-role-allowlist.json");

function listTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      files.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      files.push(full);
    }
  }
  return files;
}

describe("service-role allowlist", () => {
  it("every file calling createServiceRoleClient( is on the checked-in allowlist", () => {
    const srcDir = join(ROOT, "src");
    const allowlist = new Set<string>(JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")).files);
    // The definition itself and its own re-export are naturally excluded —
    // they define the function, they don't call it.
    const definitionFile = join(srcDir, "supabase", "server.ts");

    const offenders: string[] = [];
    for (const file of listTsFiles(srcDir)) {
      if (file === definitionFile) continue;
      const relPath = relative(ROOT, file).split("\\").join("/");
      const content = readFileSync(file, "utf8");
      if (/createServiceRoleClient\(/.test(content) && !allowlist.has(relPath)) {
        offenders.push(relPath);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("every allowlisted file still actually exists and still actually calls createServiceRoleClient( (no stale entries silently widening the effective allowlist)", () => {
    const allowlist: string[] = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")).files;
    const stale: string[] = [];
    for (const relPath of allowlist) {
      const full = join(ROOT, relPath);
      let content: string;
      try {
        content = readFileSync(full, "utf8");
      } catch {
        stale.push(`${relPath} (file no longer exists)`);
        continue;
      }
      if (!/createServiceRoleClient\(/.test(content)) stale.push(`${relPath} (no longer calls createServiceRoleClient()`);
    }
    expect(stale).toEqual([]);
  });
});
