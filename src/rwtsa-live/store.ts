import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { verifySnapshotIntegrity, type Snapshot } from "./snapshot";
import { RwtsaLiveError } from "./types";

const fail = (m: string): never => { throw new RwtsaLiveError("STORE", m); };

export function snapshotDir(home: string = homedir()): string { return path.join(home, "rwtsa-local", "cin7-snapshots"); }

function assertOutsideGit(dir: string): void {
  for (let d = dir; d !== path.dirname(d); d = path.dirname(d)) if (existsSync(path.join(d, ".git"))) fail("Refusing to write a snapshot inside a git working tree.");
}

/** Atomic, never-overwriting, owner-only write into ~/rwtsa-local/cin7-snapshots (also used for reconciliation reports). */
export function writeTextAtomic(i: { home?: string; name: string; text: string }): { file: string } {
  const dir = snapshotDir(i.home);
  assertOutsideGit(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const real = realpathSync(dir);
  assertOutsideGit(real); // a symlinked directory is judged by where it really is
  if (process.platform !== "win32" && (statSync(real).mode & 0o077) !== 0) fail("Snapshot directory permission too open: restrict it to the current user (chmod 700).");
  const final = path.join(real, i.name);
  const tmp = path.join(real, `.${i.name}.${process.pid}-${Date.now()}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try { writeSync(fd, i.text); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(tmp, final); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") fail("A file with this name already exists; nothing was overwritten."); throw e; } finally { try { unlinkSync(tmp); } catch { /* temp already gone */ } }
  return { file: final };
}

export function writeSnapshotAtomic(i: { home?: string; snapshot: Snapshot; creds: { accountId: string; applicationKey: string } }): { file: string } {
  const text = JSON.stringify(i.snapshot, null, 2);
  const esc = (v: string) => JSON.stringify(v).slice(1, -1);
  if ([i.creds.accountId, i.creds.applicationKey].some((v) => text.includes(v) || text.includes(esc(v)))) fail("Refusing to write: the snapshot contains credential material.");
  if (!verifySnapshotIntegrity(i.snapshot)) fail("Refusing to write: the snapshot failed its own integrity check.");
  return writeTextAtomic({ home: i.home, name: `snapshot-${i.snapshot.takenAt.replace(/[:.]/g, "-")}.json`, text });
}

export function readSnapshotFile(file: string): Snapshot {
  let s: Snapshot;
  try { s = JSON.parse(readFileSync(file, "utf8")) as Snapshot; } catch { return fail("The snapshot file is not valid JSON."); }
  if (!verifySnapshotIntegrity(s)) fail("The snapshot failed its integrity check (content hash mismatch).");
  return s;
}
