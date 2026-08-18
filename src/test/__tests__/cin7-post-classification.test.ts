import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Security re-audit final closure, regression guardrail #5. Every Cin7
 * create call in this codebase must be explicitly classified — see
 * docs/cin7-post-classification.json for what each classification means and
 * the investigation it snapshots. A new file sending a Cin7 POST/PUT that
 * isn't registered there (or explicitly exempted, with a reason) fails this
 * test, forcing a deliberate classification decision before merge rather
 * than a silently-unreviewed new create path (the exact "fixed the examples,
 * missed a sibling" pattern this whole closure pass exists to stop — see
 * brief item 6.2).
 */

const ROOT = join(__dirname, "..", "..", "..");
const REGISTRY_PATH = join(ROOT, "docs", "cin7-post-classification.json");

interface Registry {
  entries: { file: string; function: string; classification: string }[];
  exemptFiles: string[];
}

function listTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "__tests__") continue;
      files.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts") && entry !== "http.ts") {
      files.push(full);
    }
  }
  return files;
}

const VALID_CLASSIFICATIONS = new Set(["IDEMPOTENT_POST", "NON_IDEMPOTENT_CREATE", "RECONCILE_BEFORE_RETRY", "VERIFIED_SAFE_POST_UPDATE"]);

describe("Cin7 POST/PUT classification registry", () => {
  const registry: Registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  const registeredFiles = new Set(registry.entries.map((e) => e.file));
  const exemptFiles = new Set(registry.exemptFiles);

  it("every entry has a valid classification", () => {
    for (const entry of registry.entries) {
      expect(VALID_CLASSIFICATIONS.has(entry.classification), `${entry.file}:${entry.function} has an unrecognized classification "${entry.classification}"`).toBe(true);
    }
  });

  it("every registered entry's function still exists in its file (no stale registry rows)", () => {
    const stale: string[] = [];
    for (const entry of registry.entries) {
      const full = join(ROOT, entry.file);
      let content: string;
      try {
        content = readFileSync(full, "utf8");
      } catch {
        stale.push(`${entry.file} (file no longer exists)`);
        continue;
      }
      if (!new RegExp(`function\\s+${entry.function}\\s*\\(`).test(content)) {
        stale.push(`${entry.file}:${entry.function} (function no longer found)`);
      }
    }
    expect(stale).toEqual([]);
  });

  it("no unregistered, non-exempt file under src/cin7/ or src/audit/ sends a Cin7 POST or PUT", () => {
    const methodPattern = /method:\s*["'](POST|PUT)["']/;
    const offenders: string[] = [];

    for (const dir of [join(ROOT, "src", "cin7"), join(ROOT, "src", "audit")]) {
      for (const file of listTsFiles(dir)) {
        const relPath = relative(ROOT, file).split("\\").join("/");
        if (registeredFiles.has(relPath) || exemptFiles.has(relPath)) continue;
        const content = readFileSync(file, "utf8");
        if (methodPattern.test(content)) offenders.push(relPath);
      }
    }

    expect(offenders).toEqual([]);
  });
});
