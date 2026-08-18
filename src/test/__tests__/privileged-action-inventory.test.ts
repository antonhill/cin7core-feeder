import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Security re-audit final closure, regression guardrail #1. Every Server
 * Action that writes credentials, org/membership state, or performs a Cin7
 * create/update/delete must call one of the approved authorization guards —
 * enforced here so a newly-added privileged action can't silently ship
 * without one (the exact "a fix covers the examples an audit named, a
 * sibling ships unguarded later" pattern this whole closure pass exists to
 * stop). Complements the narrower, function-specific diagnostics-guard scan
 * in src/app/settings/instances/__tests__/actions.test.ts.
 *
 * Deliberately targets the credential/membership-state tables named in the
 * closure matrix's own Blocker 1-3 findings (`cin7_instances`,
 * `organizations`, `org_members`, `super_admins`) rather than every table —
 * a narrower, high-confidence signal beats a broad one that would also flag
 * every ordinary business-data write (products, sales, etc.) this app makes
 * by design without special privilege.
 */

const SENSITIVE_WRITE_PATTERN = /\.from\(\s*["'](cin7_instances|organizations|org_members|super_admins)["']\s*\)[\s\S]{0,200}?\.(update|insert|delete|upsert)\(/;
const APPROVED_GUARD_PATTERN = /require(CurrentOrg|OrgAdmin|PrivilegedOrgAdmin|ModuleAccess|ModuleWrite|SuperAdmin|PrivilegedSuperAdmin|WriteAllowed)\(/;
const EXEMPTION_MARKER = /privileged-action-scan:\s*reviewed-safe/;

function listActionFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      files.push(...listActionFiles(full));
    } else if (entry === "actions.ts") {
      files.push(full);
    }
  }
  return files;
}

function extractExportedFunctions(source: string): { name: string; body: string }[] {
  const re = /^export async function (\w+)\(/gm;
  const matches: { name: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) matches.push({ name: m[1], index: m.index });

  return matches.map((match, i) => {
    const end = i + 1 < matches.length ? matches[i + 1].index : source.length;
    return { name: match.name, body: source.slice(match.index, end) };
  });
}

describe("privileged action inventory", () => {
  const root = join(__dirname, "..", "..", "..");
  const appActionFiles = listActionFiles(join(root, "src", "app"));
  const srcActionsDir = join(root, "src", "actions");
  const srcActionFiles = readdirSync(srcActionsDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(srcActionsDir, f));
  const allFiles = [...appActionFiles, ...srcActionFiles];

  it("finds at least the known privileged-action-bearing files (fails loudly rather than silently passing on zero files)", () => {
    expect(allFiles.length).toBeGreaterThanOrEqual(10);
  });

  it("every exported action that writes credentials/org/membership state calls an approved authorization guard, or carries an explicit reviewed exemption", () => {
    const offenders: { file: string; action: string }[] = [];

    for (const file of allFiles) {
      const relPath = relative(root, file).split("\\").join("/");
      const source = readFileSync(file, "utf8");
      for (const { name, body } of extractExportedFunctions(source)) {
        if (!SENSITIVE_WRITE_PATTERN.test(body)) continue;
        if (APPROVED_GUARD_PATTERN.test(body)) continue;
        if (EXEMPTION_MARKER.test(body)) continue;
        offenders.push({ file: relPath, action: name });
      }
    }

    expect(offenders).toEqual([]);
  });
});
