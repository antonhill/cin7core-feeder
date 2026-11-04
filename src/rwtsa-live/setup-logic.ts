import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { loadIdentityApproval } from "./identity";
import { loadLocationMap } from "./credentials";
import { ROLES, RwtsaLiveError, type LocationMap, type Role } from "./types";

const fail = (m: string): never => { throw new RwtsaLiveError("CREDENTIALS", m); };
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const credentialsDir = (home: string) => path.join(home, "rwtsa-local", "credentials");

function assertNotInGit(dir: string): void {
  for (let d = dir; d !== path.dirname(d); d = path.dirname(d)) if (existsSync(path.join(d, ".git"))) fail("Refusing to create credentials inside a git working tree.");
}
function ensureDir(home: string): string {
  const dir = credentialsDir(home);
  assertNotInGit(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}
/** Owner-only file written via a temp file. Without `overwrite` an existing file is never replaced. */
function writePrivate(dir: string, name: string, text: string, overwrite: boolean): void {
  const final = path.join(dir, name);
  const tmp = path.join(dir, `.${name}.${process_pid()}-${Date.now()}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    if (overwrite) renameSync(tmp, final);
    else linkSync(tmp, final);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") fail(`${name} already exists; nothing was overwritten.`);
    throw e;
  } finally { try { unlinkSync(tmp); } catch { /* already moved */ } }
  chmodSync(final, 0o600);
}
const process_pid = () => Math.floor(Math.random() * 1e9); // unique temp suffix without touching `process`

const clean = (v: string, what: string): string => {
  const t = v.trim();
  if (!t) fail(`${what} must not be empty.`);
  if (/[\r\n]/.test(t)) fail(`${what} must be a single line.`);
  return t;
};

/** Creates ~/rwtsa-local/credentials (700), cin7.env and identity.json (600). The identity hash is derived here; the ID is never copied. */
export function writeInitialCredentials(i: { home: string; accountId: string; applicationKey: string; instanceLabel: string; replace: boolean }): void {
  const accountId = clean(i.accountId, "The Account ID"), key = clean(i.applicationKey, "The Application Key"), label = clean(i.instanceLabel, "The instance label");
  const dir = ensureDir(i.home);
  if (!i.replace && (existsSync(path.join(dir, "cin7.env")) || existsSync(path.join(dir, "identity.json")))) fail("Credentials already exist; nothing was overwritten (choose to replace them explicitly).");
  const env = `RWTSA_CIN7_ACCOUNT_ID=${accountId}\nRWTSA_CIN7_APPLICATION_KEY=${key}\nRWTSA_CIN7_INSTANCE_LABEL=${label}\n`;
  writePrivate(dir, "cin7.env", env, i.replace);
  writePrivate(dir, "identity.json", JSON.stringify({ accountIdSha256: createHash("sha256").update(accountId).digest("hex") }, null, 2) + "\n", i.replace);
}

/** Adds the owner-approved fingerprint to identity.json (keeps the account hash). */
export function recordApprovedFingerprint(i: { home: string; fingerprint: string }): void {
  if (!/^[0-9a-f]{64}$/.test(i.fingerprint)) fail("The fingerprint must be 64 lowercase hex characters.");
  const dir = credentialsDir(i.home);
  const cur = loadIdentityApproval(dir);
  writePrivate(dir, "identity.json", JSON.stringify({ accountIdSha256: cur.accountIdSha256, approvedFingerprint: i.fingerprint }, null, 2) + "\n", true);
}

/** Writes locations.json (all five roles, GUIDs, unique) and proves the real loader accepts it. */
export function writeLocationMap(i: { home: string; map: LocationMap }): void {
  const ids = new Set<string>();
  for (const r of ROLES) {
    const v = i.map[r];
    if (!v || !GUID.test(v)) fail(`The ${r} location is missing or is not a Cin7 location GUID.`);
    if (ids.has(v!.toLowerCase())) fail("Two roles share one location ID.");
    ids.add(v!.toLowerCase());
  }
  const dir = credentialsDir(i.home);
  writePrivate(dir, "locations.json", JSON.stringify(Object.fromEntries(ROLES.map((r) => [r, i.map[r]])), null, 2) + "\n", true);
  loadLocationMap(dir);
}

// ---- location mapping proposal -------------------------------------------------------------------------------------------------
export interface NamedLocation { id: string; name: string }
/** Exact (case- and spacing-insensitive) display names that may be PROPOSED for a role. Anything else is left for the owner to choose. */
const NAMES: Record<Role, readonly string[]> = {
  JHB: ["jhb", "johannesburg", "jhb store", "jhb stores"],
  DURBAN: ["durban", "dbn", "durban store", "durban stores"],
  CAPE_TOWN: ["cape town", "capetown", "cpt", "cape town store", "cape town stores"],
  FACTORY_STORE: ["factory store", "factory stores", "factory", "factory-store"],
  BOND: ["bond", "bonded", "bond store", "bonded store", "bond warehouse", "bonded warehouse"],
};
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export function proposeLocationMap(locations: readonly NamedLocation[]) {
  const proposed: Partial<Record<Role, NamedLocation>> = {};
  const ambiguous: Role[] = [], unmatched: Role[] = [];
  const candidates = {} as Record<Role, NamedLocation[]>;
  for (const r of ROLES) {
    const hits = locations.filter((l) => NAMES[r].includes(norm(l.name)));
    candidates[r] = hits;
    if (hits.length === 1) proposed[r] = hits[0];
    else if (hits.length === 0) unmatched.push(r);
    else ambiguous.push(r);
  }
  return { proposed, ambiguous, unmatched, candidates };
}
