// Phase 2 S2: the owner-maintained clearance register. An append-only, hash-chained JSON-lines file under ~/rwtsa-local/bond (dir 0700, file 0600),
// outside any git tree. Every append re-validates the WHOLE history through the S1 engine, so an invalid event can never be stored; every read verifies
// the chain, so an edited, deleted, reordered or injected line fails closed. No network, no Cin7, no Supabase.
import { closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { BondRegisterError, foldRegister, type RegisterEvent } from "./engine";

const fail = (m: string): never => { throw new BondRegisterError(m); };
const GENESIS = "0".repeat(64);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export const bondDir = (home: string = homedir()) => path.join(home, "rwtsa-local", "bond");
export const registerFile = (home: string = homedir()) => path.join(bondDir(home), "register.jsonl");

function assertOutsideGit(dir: string): void {
  for (let d = dir; d !== path.dirname(d); d = path.dirname(d)) if (existsSync(path.join(d, ".git"))) fail("Refusing to use a register inside a git working tree.");
}
function ensureDir(home: string): string {
  const dir = bondDir(home);
  assertOutsideGit(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const real = realpathSync(dir);
  assertOutsideGit(real);
  if (process.platform !== "win32" && (statSync(real).mode & 0o077) !== 0) fail("Register directory permission too open: restrict it to the current user (chmod 700).");
  return real;
}

interface Line { seq: number; at: string; prevHash: string; event: RegisterEvent; hash: string }
const lineHash = (l: Omit<Line, "hash">) => sha(JSON.stringify({ seq: l.seq, at: l.at, prevHash: l.prevHash, event: l.event }));

export interface RegisterRead { events: RegisterEvent[]; tipHash: string; count: number }

export function readRegister(i: { home?: string }): RegisterRead {
  const file = registerFile(i.home);
  if (!existsSync(file) && !(() => { try { lstatSync(file); return true; } catch { return false; } })()) return { events: [], tipHash: GENESIS, count: 0 };
  const st = lstatSync(file);
  if (st.isSymbolicLink() || !st.isFile()) fail("The register must be a regular file, not a symlink.");
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) fail("Register file permission too open: restrict it to the current user (chmod 600).");
  const raw = readFileSync(file, "utf8");
  const lines = raw.length === 0 ? [] : raw.endsWith("\n") ? raw.slice(0, -1).split("\n") : fail("Register integrity failure: the last line is incomplete.");
  const events: RegisterEvent[] = [];
  let prev = GENESIS;
  lines.forEach((text, idx) => {
    let l: Line;
    try { l = JSON.parse(text) as Line; } catch { return fail(`Register integrity failure at line ${idx + 1}: not valid JSON.`); }
    const ok = l && typeof l === "object" && l.seq === idx + 1 && typeof l.at === "string" && l.prevHash === prev && typeof l.hash === "string" && l.event && typeof l.event === "object" && lineHash(l) === l.hash;
    if (!ok) fail(`Register integrity failure at line ${idx + 1}: the chain does not verify (edited, deleted, reordered or injected).`);
    events.push(l.event); prev = l.hash;
  });
  return { events, tipHash: prev, count: events.length };
}

/** Validates `event` against the whole verified history, then appends one line (O_APPEND, 0600, fsync). Throws, leaving the file untouched, if invalid. */
export function appendRegisterEvent(i: { home?: string; event: RegisterEvent; at: string; today: string }): { seq: number; hash: string } {
  const dir = ensureDir(i.home ?? homedir());
  const cur = readRegister({ home: i.home });
  foldRegister([...cur.events, i.event], { asOf: i.today });
  const base = { seq: cur.count + 1, at: i.at, prevHash: cur.tipHash, event: i.event };
  const line: Line = { ...base, hash: lineHash(base) };
  const fd = openSync(path.join(dir, "register.jsonl"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
  try { writeSync(fd, JSON.stringify(line) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  return { seq: line.seq, hash: line.hash };
}

/** Atomic, owner-only report write. Re-writing byte-identical content is a no-op; different content under the same name is refused (never overwritten). */
export function writeBondFileAtomic(i: { home?: string; name: string; text: string }): { file: string; existed: boolean } {
  const dir = ensureDir(i.home ?? homedir());
  const final = path.join(dir, i.name);
  const tmp = path.join(dir, `.${i.name}.${process.pid}-${Date.now()}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try { writeSync(fd, i.text); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(tmp, final); return { file: final, existed: false }; }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    if (readFileSync(final, "utf8") === i.text) return { file: final, existed: true };
    return fail("A different file with this name already exists; nothing was overwritten.");
  } finally { try { unlinkSync(tmp); } catch { /* temp already gone */ } }
}
