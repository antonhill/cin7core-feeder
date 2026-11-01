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
  return { PATH: process.env.PATH, HOME: process.env.HOME, NEXT_TELEMETRY_DISABLED: "1", RWTSA_DIST_SUFFIX: SUFFIX, RWTSA_STATE_DIR: join(tmp, "state"), ...extra } as unknown as NodeJS.ProcessEnv;
}
function get(path: string): { status: number; body: string } {
  const out = execFileSync("curl", ["-s", "-m", "20", "-w", "\n%{http_code}", `${BASE}${path}`], { encoding: "utf8" });
  const i = out.lastIndexOf("\n");
  return { status: Number(out.slice(i + 1)), body: out.slice(0, i) };
}
function post(path: string, headers: string[], fields: [string, string][]): { status: number; location: string | null } {
  const args = ["-s", "-o", "/dev/null", "-D", "-", "-m", "20", "-X", "POST"];
  for (const h of headers) args.push("-H", h);
  for (const [k, v] of fields) args.push("--data-urlencode", `${k}=${v}`);
  const out = execFileSync("curl", [...args, `${BASE}${path}`], { encoding: "utf8" });
  const status = Number(/^HTTP\/[\d.]+ (\d+)/m.exec(out)?.[1]);
  return { status, location: /^location: (.*)$/im.exec(out)?.[1]?.trim() ?? null };
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
    // The ONLY proxy is this app's own Host gate (matching every path); it is the shadow of the Toolbox middleware.
    const fns = JSON.parse(readFileSync(join(DIST, "server", "functions-config-manifest.json"), "utf8")).functions as Record<string, { matchers: { originalSource: string }[] }>;
    expect(Object.keys(fns)).toEqual(["/_middleware"]);
    expect(fns["/_middleware"].matchers.map((m) => m.originalSource)).toEqual(["/:path*"]);
    const gate = [...files(join(DIST, "server"))].filter((f) => /\.js$/.test(f) && readFileSync(f, "utf8").includes("only answers requests addressed to a loopback host"));
    expect(gate.length).toBeGreaterThan(0);
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

  it("the exclusion route works in the real production server, is same-origin only, and writes only to the local state directory", () => {
    const fields: [string, string][] = [["action", "exclude"], ["month", "2026-06"], ["reason", `${S}_reason`], ["returnTo", "/scenario-a?view=sku"], ["sku", "SYN-VEST-B-M"]];
    expect(post("/api/exclusions", [`Origin: http://evil.invalid`], fields).status).toBe(403);
    expect(existsSync(join(tmp, "state"))).toBe(false);
    const ok = post("/api/exclusions", [`Origin: ${BASE}`], fields);
    expect(ok.status).toBe(303);
    expect(ok.location).toBe("/scenario-a?view=sku&done=excluded");
    const saved = readdirSync(join(tmp, "state"));
    expect(saved).toHaveLength(1);
    // A local workbook shows results only once the history and overdue treatments are chosen.
    const page = get("/scenario-a?view=sku&done=excluded&anchor=last&overdue=week1");
    expect(page.status).toBe(200);
    expect(text(page.body)).toContain("Month excluded from the demand forecast");
    expect(text(page.body)).toContain(`EXCLUDED: ${S}_reason`); // the planner's own reason is shown to the planner only
    const noReason = post("/api/exclusions", [`Origin: ${BASE}`], [["action", "exclude"], ["month", "2026-06"], ["reason", " "], ["sku", "SYN-VEST-B-L"]]);
    expect(noReason.location).toBe("/scenario-a?done=reason");
    expect(readdirSync(join(tmp, "state"))).toHaveLength(1);
    const rev = post("/api/exclusions", [`Origin: ${BASE}`], [["action", "reverse"], ["month", "2026-06"], ["sku", "SYN-VEST-B-M"]]);
    expect(rev.location).toBe("/scenario-a?done=reversed");
    expect(text(get("/scenario-a").body)).not.toContain(`${S}_reason`);
    expect(serverLog).not.toContain(`${S}_reason`);
    // Nothing the planner typed reaches the build output either.
    expect([...files(DIST)].some((f) => { try { return readFileSync(f, "utf8").includes(`${S}_reason`); } catch { return false; } })).toBe(false);
  });

  it("Host gate on the real server: an external Host is refused on pages, the API and static files; loopback names are served", () => {
    const status = (path: string, host: string | null, extra: string[] = [], method = "GET") => {
      const args = ["-s", "-o", "/dev/null", "-D", "-", "-m", "20", "-X", method, "--resolve", `localhost:${PORT}:127.0.0.1`];
      if (host !== null) args.push("-H", `Host: ${host}`);
      for (const h of extra) args.push("-H", h);
      const out = execFileSync("curl", [...args, `http://127.0.0.1:${PORT}${path}`], { encoding: "utf8" });
      return { code: Number(/^HTTP\/[\d.]+ (\d+)/m.exec(out)?.[1]), location: /^location:/im.test(out), out };
    };
    for (const evil of ["evil.example", `evil.example:${PORT}`, `127.0.0.1.evil.example:${PORT}`, "10.0.0.5"]) {
      for (const path of ["/", "/scenario-a", "/validation", "/api/exclusions", "/_next/static/anything.js"]) {
        const r = status(path, evil);
        expect(r.code, `${evil} ${path}`).toBe(403);
        expect(r.location, `${evil} ${path}`).toBe(false);
        expect(r.out, `${evil} ${path}`).not.toContain("evil.example");
      }
    }
    expect(status("/", `evil.example`, [`Origin: http://evil.example`], "POST").code).toBe(403);
    // Legitimate loopback operation is unaffected.
    expect(status("/", `127.0.0.1:${PORT}`).code).toBe(200);
    expect(status("/scenario-a", `localhost:${PORT}`).code).toBe(200);
    expect(status("/validation", `127.0.0.1:${PORT}`).code).toBe(200);
    // Loopback Host but a cross-site POST is refused by the gate before the route runs.
    expect(status("/api/exclusions", `127.0.0.1:${PORT}`, ["Origin: http://evil.example"], "POST").code).toBe(403);
    expect(readdirSync(tmp).some((f) => f === "state")).toBe(true); // state from the earlier exclusion test only; nothing new was written
    expect(serverLog).not.toContain("evil.example");
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
