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
 */
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

describe("Cin7 HTTP gateway boundary", () => {
  it("no file under src/cin7/ other than http.ts calls fetch() directly", () => {
    const cin7Dir = join(__dirname, "..", "..", "cin7");
    const offenders: { file: string; line: number }[] = [];

    for (const file of listTsFiles(cin7Dir)) {
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
});
