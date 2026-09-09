import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A `"use server"` module may export ONLY async functions.
 *
 * One non-function export fails the WHOLE module at runtime request time,
 * taking down every action in the file rather than just the offending one —
 * and `next build` does not catch it. That has caused two separate
 * production outages in this project.
 *
 * This check is static because the failure is static: the rule is about the
 * shape of a module's export list, and importing these modules for real
 * would drag in `next/headers` and a live Supabase client. Type-only exports
 * (`interface` / `type`) are erased before the module ever runs and are the
 * one safe exception.
 *
 * Added while bounding the three calendars' fetches (migration 0090), which
 * touched three action files — CLAUDE.md requires verifying this rule after
 * any such change, and a test is the only form of that verification which
 * keeps working after the change is merged.
 */
const SRC = join(__dirname, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

const serverModules = walk(SRC).filter((p) => /^\s*["']use server["'];/.test(readFileSync(p, "utf8").slice(0, 200)));

describe('"use server" modules export only async functions', () => {
  it("finds the action modules at all (guards against the glob silently breaking)", () => {
    expect(serverModules.length).toBeGreaterThan(20);
  });

  it.each(serverModules.map((p) => [p.slice(SRC.length + 1), p]))("%s", (_label, path) => {
    const offenders = [...readFileSync(path, "utf8").matchAll(/^export\s+(.*)$/gm)]
      .map((m) => m[1])
      .filter((decl) => !decl.startsWith("interface ") && !decl.startsWith("type "))
      .filter((decl) => !decl.startsWith("async function"));

    expect(offenders).toEqual([]);
  });
});
