import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { distDirFor } from "../lib/dist-dir";
import { buildSyntheticWorkbook } from "@/rwtsa-demo/fixtures/synthetic";

/**
 * Builds and starts the REAL standalone shell (production mode) with a minimal environment: no Supabase or Cin7
 * variables, only RWTSA_* and PATH/HOME. This is the regression guard for the failure found during PR-2: with
 * turbopack.root at the repo root, Turbopack's upward lookup found and bundled the Toolbox's src/middleware.ts, so every
 * request returned HTTP 500 without Supabase credentials. It also proves nothing workbook-derived reaches the build
 * output or the server log, and that the pages are rendered per request.
 *
 * It uses a local workbook that is a SYNTHETIC file with sentinel text, kept in the OS temp directory (outside any repo).
 */

const ROOT = join(__dirname, "..", "..");
const APP = join(ROOT, "rwtsa-demo");
// Test-owned output directory: unique per run, so a developer's running demo server (default directory) is never
// disturbed and concurrent runs cannot delete one another's artefacts. Cleanup is confined to exactly this directory.
const CACHE = join(ROOT, "node_modules", ".cache");
const DEFAULT_DIST = join(CACHE, "rwtsa-demo-next");
const SUFFIX = `test-${process.pid}-${randomUUID().slice(0, 8)}`;
const DEFAULT_MARKER = join(DEFAULT_DIST, `.test-marker-${SUFFIX}`);
const DIST = join(CACHE, `rwtsa-demo-next-${SUFFIX}`);
const NEXT_BIN = join(ROOT, "node_modules", "next", "dist", "bin", "next");
const S = "SENTINEL_STANDALONE_C07D";
const PORT = 41000 + Math.floor(Math.random() * 8000);
const BASE = `http://127.0.0.1:${PORT}`;

let tmp: string;
let workbook: string;
let server: ChildProcess | null = null;
let serverLog = "";
let buildLog = "";

function minimalEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: process.env.HOME, NEXT_TELEMETRY_DISABLED: "1", RWTSA_DIST_SUFFIX: SUFFIX, ...extra } as unknown as NodeJS.ProcessEnv;
}
function get(path: string): { status: number; body: string } {
  const out = execFileSync("curl", ["-s", "-m", "20", "-w", "\n%{http_code}", `${BASE}${path}`], { encoding: "utf8" });
  const i = out.lastIndexOf("\n");
  return { status: Number(out.slice(i + 1)), body: out.slice(0, i) };
}
function* files(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) yield* files(f);
    else yield f;
  }
}
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("the standalone shell builds and runs without Toolbox middleware, Supabase or credentials", { timeout: 300_000 }, () => {
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "rwtsa-standalone-"));
    workbook = join(tmp, `${S}_workbook.xlsx`);
    const { workbook: wb } = buildSyntheticWorkbook();
    const items = wb.getWorksheet("Items")!;
    for (let r = 2; r <= items.rowCount; r++) items.getRow(r).getCell(3).value = `${S}_description_${r}`;
    wb.getWorksheet("Customers")!.getRow(2).getCell(1).value = `${S}_customer`;
    wb.addWorksheet(`${S}_sheet`).addRow([`${S}_cell`]);
    writeFileSync(workbook, Buffer.from(await wb.xlsx.writeBuffer()));

    // Stand-in for a developer's running demo server: a file in the DEFAULT output directory that must survive.
    mkdirSync(DEFAULT_DIST, { recursive: true });
    writeFileSync(DEFAULT_MARKER, "running-demo-server-artefact");
    expect(existsSync(DIST)).toBe(false);
    try {
      buildLog = execFileSync(process.execPath, [NEXT_BIN, "build"], { cwd: APP, env: minimalEnv({ RWTSA_WORKBOOK_PATH: workbook }), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 240_000 });
    } catch (e) {
      const x = e as { stdout?: string; stderr?: string };
      throw new Error(`standalone build failed:\n${x.stdout ?? ""}\n${x.stderr ?? ""}`.slice(0, 4000));
    }

    server = spawn(process.execPath, [NEXT_BIN, "start", "-H", "127.0.0.1", "-p", String(PORT)], { cwd: APP, env: minimalEnv({ RWTSA_WORKBOOK_PATH: workbook }), stdio: ["ignore", "pipe", "pipe"] });
    server.stdout?.on("data", (d) => (serverLog += String(d)));
    server.stderr?.on("data", (d) => (serverLog += String(d)));
    for (let i = 0; i < 60; i++) {
      try {
        if (get("/").status === 200) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }, 300_000);

  afterAll(() => {
    server?.kill();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(DEFAULT_MARKER, { force: true }); // our own marker file only; never the default directory itself
    // Only the test-owned directory, and only if it is exactly where we expect it.
    if (resolve(DIST).startsWith(CACHE + "/rwtsa-demo-next-test-")) rmSync(DIST, { recursive: true, force: true });
  });

  it("the production build does not bundle the Toolbox middleware or any Supabase client", () => {
    const manifest = JSON.parse(readFileSync(join(DIST, "server", "middleware-manifest.json"), "utf8"));
    expect(manifest.middleware).toEqual({});
    const offenders = [...files(DIST)].filter((f) => /\.(js|mjs|json)$/.test(f) && /createServerClient|NEXT_PUBLIC_SUPABASE|supabase\.co/i.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => f.slice(DIST.length))).toEqual([]);
  });

  it("every page is server-rendered on demand (dynamic), not prerendered at build time", () => {
    for (const route of ["/", "/scenario-a", "/scenario-b", "/scenario-c", "/scenario-d", "/validation"]) {
      expect(buildLog, route).toMatch(new RegExp(`ƒ ${route === "/" ? "/" : route}\\s*$`, "m"));
    }
  });

  it("no workbook-derived text, file name or path is in the build output, the build log or the server log", () => {
    const hits = [...files(DIST)].filter((f) => {
      try {
        return readFileSync(f, "utf8").includes(S) || readFileSync(f, "utf8").includes(tmp);
      } catch {
        return false;
      }
    });
    expect(hits).toEqual([]);
    expect(buildLog).not.toContain(S);
    expect(buildLog).not.toContain(tmp);
    expect(serverLog).not.toContain(S);
    expect(serverLog).not.toContain(tmp);
  });

  it("serves all six pages with HTTP 200 and the local-workbook provenance, with no credentials in the environment", () => {
    for (const path of ["/", "/scenario-a", "/scenario-b", "/scenario-c", "/scenario-d", "/validation"]) {
      const r = get(path);
      expect(r.status, path).toBe(200);
      expect(text(r.body), path).toContain("LOCAL WORKBOOK");
      expect(r.body, path).not.toContain(S);
      expect(r.body, path).not.toContain(tmp);
    }
    expect(text(get("/").body)).toContain("STRUCTURE PASS");
    expect(serverLog).not.toMatch(/supabase|error/i);
  });

  it("the server listens on loopback only", () => {
    expect(serverLog).toContain("127.0.0.1");
    expect(existsSync(join(DIST, "BUILD_ID"))).toBe(true);
  });

  // --- cache isolation (must run before afterAll removes the test-owned directory and marker) ---
  it("builds into a unique test-owned directory, never the default one", () => {
    expect(DIST).not.toBe(DEFAULT_DIST);
    expect(DIST.startsWith(join(CACHE, "rwtsa-demo-next-test-"))).toBe(true);
    expect(existsSync(join(DIST, "BUILD_ID"))).toBe(true);
  });

  it("leaves another run's default output directory untouched (the old test deleted it)", () => {
    expect(existsSync(DEFAULT_MARKER)).toBe(true);
    expect(readFileSync(DEFAULT_MARKER, "utf8")).toBe("running-demo-server-artefact");
  });

  it("two runs get different directories", () => {
    const other = `test-${process.pid}-${randomUUID().slice(0, 8)}`;
    expect(other).not.toBe(SUFFIX);
  });

  it("the dist directory honours the suffix and rejects anything that could escape node_modules/.cache", () => {
    expect(distDirFor(undefined)).toBe("../node_modules/.cache/rwtsa-demo-next");
    expect(distDirFor("abc-1_X")).toBe("../node_modules/.cache/rwtsa-demo-next-abc-1_X");
    for (const bad of ["../x", "a/b", "", "a b", "x".repeat(65)]) expect(() => distDirFor(bad), bad).toThrow(/RWTSA_DIST_SUFFIX/);
  });
});
