import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Security re-audit P0-1: "exactly one network boundary capable of
 * transmitting Cin7 credentials." Every file under src/cin7/ (where every
 * Cin7Credentials-bearing header gets attached) other than http.ts itself —
 * the gateway (cin7Request) and its one sanctioned raw escape hatch
 * (cin7RawRequest, for diagnostics that need a raw response cin7Request
 * would otherwise throw away) — must never call fetch() directly. A new
 * raw fetch() added anywhere else in this directory would be a second,
 * unaudited place capable of leaking the account ID / application key
 * (e.g. by building its URL from a DB-stored, member-editable base_url
 * again, as client.ts and debug.ts both used to).
 *
 * Security re-audit final closure (regression guardrail #4): widened
 * repo-wide, not just src/cin7/ — a credential-bearing helper accidentally
 * introduced outside this directory would previously have evaded the
 * narrower scan entirely. Paired with a second check on the two literal
 * Cin7 auth header names, which must appear ONLY inside http.ts's two
 * gateway functions — this catches a wrapper-function or aliased-fetch
 * bypass that a token-level `fetch(` scan alone would miss (the closure
 * matrix's own §6.1 finding).
 */
function listTsFiles(dir: string, excludeName?: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      files.push(...listTsFiles(full, excludeName));
    } else if ((entry.endsWith(".ts") || entry.endsWith(".tsx")) && entry !== excludeName) {
      files.push(full);
    }
  }
  return files;
}

describe("Cin7 HTTP gateway boundary", () => {
  it("no file under src/cin7/ other than http.ts calls fetch() directly", () => {
    const cin7Dir = join(__dirname, "..", "..", "cin7");
    const offenders: { file: string; line: number }[] = [];

    for (const file of listTsFiles(cin7Dir, "http.ts")) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        // A bare `fetch(` call — not a comment/string mention of the word, and
        // not e.g. `someFetchWrapper(` (word-boundary before "fetch").
        if (/(?<![\w.])fetch\(/.test(line) && !line.trim().startsWith("*") && !line.trim().startsWith("//")) {
          offenders.push({ file, line: i + 1 });
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it("no file under the whole src/ tree other than cin7/http.ts calls fetch() directly (repo-wide widening), except two known-unrelated, reviewed non-Cin7 API calls", () => {
    const srcDir = join(__dirname, "..", "..");
    const httpTsPath = join(srcDir, "cin7", "http.ts");
    // Reviewed and confirmed unrelated to Cin7 — neither carries a Cin7Credentials
    // header, and both are independently network-bounded (fx.ts: a public FX-rate
    // API for a price-estimate widget; lemonsqueezy.ts: this app's own billing
    // provider's API, authenticated with LEMONSQUEEZY_API_KEY, never Cin7 creds).
    const allowlist = new Set([join(srcDir, "lib", "fx.ts"), join(srcDir, "lib", "lemonsqueezy.ts")]);
    const offenders: { file: string; line: number }[] = [];

    for (const file of listTsFiles(srcDir)) {
      if (file === httpTsPath || allowlist.has(file)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/(?<![\w.])fetch\(/.test(line) && !line.trim().startsWith("*") && !line.trim().startsWith("//")) {
          offenders.push({ file, line: i + 1 });
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it("the two literal Cin7 auth header names appear only inside cin7/http.ts's gateway functions", () => {
    const srcDir = join(__dirname, "..", "..");
    const httpTsPath = join(srcDir, "cin7", "http.ts");
    const headerPattern = /api-auth-(accountid|applicationkey)/i;
    const offenders: { file: string; line: number }[] = [];

    for (const file of listTsFiles(srcDir)) {
      if (file === httpTsPath) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (headerPattern.test(line)) offenders.push({ file, line: i + 1 });
      });
    }

    expect(offenders).toEqual([]);
  });
});
