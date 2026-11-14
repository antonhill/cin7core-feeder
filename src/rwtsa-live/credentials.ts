import { homedir } from "node:os";
import path from "node:path";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { ROLES, RwtsaLiveError, type LocationMap, type Role, type RwtsaCredentials } from "./types";

const fail = (m: string): never => { throw new RwtsaLiveError("CREDENTIALS", m); };
const K_ACCOUNT = "RWTSA_CIN7_ACCOUNT_ID";
const K_APP = "RWTSA_CIN7_APPLICATION_KEY";
const K_LABEL = "RWTSA_CIN7_INSTANCE_LABEL";
const KEYS = [K_ACCOUNT, K_APP, K_LABEL] as const;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function expectedDir(home: string): string { return path.join(home, "rwtsa-local", "credentials"); }

function assertPrivateDir(dir: string, home: string): void {
  if (path.resolve(dir) !== path.resolve(expectedDir(home))) fail("Credentials must live in ~/rwtsa-local/credentials.");
  if (!existsSync(dir)) fail("The credentials directory does not exist.");
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) fail("The credentials directory must be a real directory (no symlink).");
  if (realpathSync(dir) !== path.join(realpathSync(home), "rwtsa-local", "credentials")) fail("The credentials directory resolves outside ~/rwtsa-local/credentials.");
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) fail("Directory permission too open: restrict it to the current user (chmod 700).");
  for (let d = path.dirname(dir); d !== path.dirname(d); d = path.dirname(d)) if (existsSync(path.join(d, ".git"))) fail("The credentials directory is inside a git working tree.");
}
export function assertPrivateFile(file: string): void {
  if (!existsSync(file) && !lstatSafe(file)) fail("A required RWTSA file is missing.");
  const st = lstatSync(file);
  if (st.isSymbolicLink()) fail("Refusing a symlink: the file must be a regular file in the credentials directory.");
  if (!st.isFile()) fail("Not a regular file.");
  if (process.platform !== "win32") {
    if ((st.mode & 0o077) !== 0) fail("File permission too open: restrict it to the current user (chmod 600).");
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) fail("The file is not owned by the current user.");
  }
}
function lstatSafe(f: string) { try { return lstatSync(f); } catch { return null; } }

/** Loads ONLY the three allowed keys from ~/rwtsa-local/credentials/cin7.env. Reads no environment variable. */
export function loadRwtsaCredentials(opts: { home?: string; dirOverride?: string } = {}): RwtsaCredentials {
  const home = opts.home ?? homedir();
  const dir = opts.dirOverride ?? expectedDir(home);
  assertPrivateDir(dir, home);
  const file = path.join(dir, "cin7.env");
  assertPrivateFile(file);
  const found = new Map<string, string>();
  readFileSync(file, "utf8").split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const eq = line.indexOf("=");
    const key = eq > 0 ? line.slice(0, eq).trim() : "";
    if (!(KEYS as readonly string[]).includes(key)) fail(`A key is not allowed in the RWTSA credentials file (line ${i + 1}).`);
    if (found.has(key)) fail(`A key is repeated in the RWTSA credentials file (line ${i + 1}).`);
    found.set(key, line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2"));
  });
  for (const k of KEYS) if (!found.get(k)) fail(`Missing required key ${k}.`);
  return { accountId: found.get(KEYS[0])!, applicationKey: found.get(KEYS[1])!, instanceLabel: found.get(KEYS[2])! };
}

/** ~/rwtsa-local/credentials/locations.json: { "BOND": "<location GUID>", "JHB": ... }. Non-secret, but same private-file rules. */
export function loadLocationMap(dir: string): LocationMap {
  const file = path.join(dir, "locations.json");
  assertPrivateFile(file);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { return fail("locations.json is not valid JSON."); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("locations.json must be an object of role -> location ID.");
  const o = raw as Record<string, unknown>;
  const ids = new Set<string>();
  for (const [k, v] of Object.entries(o)) {
    if (!(ROLES as readonly string[]).includes(k)) fail("locations.json has a role that is not allowed.");
    if (typeof v !== "string" || !GUID.test(v)) fail(`locations.json: ${k} must be a Cin7 location GUID (a display name is not an identity).`);
    if (ids.has((v as string).toLowerCase())) fail("locations.json: two roles share one location ID.");
    ids.add((v as string).toLowerCase());
  }
  if (!o.BOND) fail("locations.json must name the Bond location ID.");
  return o as unknown as LocationMap;
}
export type { Role };
