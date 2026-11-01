import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Exclusion } from "@/rwtsa-demo/engine";
import { assertOutputDirAllowed } from "@/rwtsa-demo/workbook/path-guard";

/**
 * Planner exclusions persisted as local demo state OUTSIDE every git working tree (default `~/.rwtsa-demo`, or `RWTSA_STATE_DIR`).
 * One small JSON file per data source (keyed by a hash of the source label, so exclusions made against one workbook can never
 * apply to another). Writes are atomic (temp file + rename) and owner-only. Nothing is written inside the repository, the
 * build output, or any cache, and nothing leaves the machine.
 */

const FileSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.string(),
  exclusions: z.array(z.object({ sku: z.string().min(1), month: z.string().regex(/^\d{4}-\d{2}$/), reason: z.string().trim().min(1), at: z.string() })),
});

export type StoredExclusion = Exclusion & { readonly at: string };

export class ExclusionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExclusionStoreError";
  }
}

export function defaultStateDir(): string {
  return path.join(os.homedir(), ".rwtsa-demo");
}

function fileFor(dir: string, sourceLabel: string): string {
  const key = createHash("sha256").update(sourceLabel).digest("hex").slice(0, 16);
  return path.join(dir, `exclusions-${key}.json`);
}

/** Validates the directory (outside every git working tree) and creates it owner-only. Throws ExclusionStoreError with a safe message. */
function safeDir(dir: string): string {
  try {
    const real = assertOutputDirAllowed(dir);
    try {
      chmodSync(real, 0o700);
    } catch {
      /* best effort on filesystems that do not support modes */
    }
    return real;
  } catch (e) {
    throw new ExclusionStoreError(e instanceof Error && e.name === "RwtsaSafeError" ? e.message : "The local state directory is not usable.");
  }
}

/** Reads the stored exclusions for one data source. A missing file is an empty list; a corrupt file is an error (never silently ignored). */
export function loadExclusions(dir: string, sourceLabel: string): StoredExclusion[] {
  const file = fileFor(dir, sourceLabel);
  if (!existsSync(file)) return [];
  let parsed: z.infer<typeof FileSchema>;
  try {
    parsed = FileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new ExclusionStoreError("The saved exclusions file is unreadable or corrupt. Nothing was applied; remove the file to start again.");
  }
  if (parsed.source !== sourceLabel) throw new ExclusionStoreError("The saved exclusions belong to a different data source. Nothing was applied.");
  return parsed.exclusions;
}

function write(dir: string, sourceLabel: string, list: readonly StoredExclusion[]): void {
  const real = safeDir(dir);
  const file = fileFor(real, sourceLabel);
  const tmp = `${file}.${randomUUID()}.tmp`;
  mkdirSync(real, { recursive: true });
  writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, source: sourceLabel, exclusions: list }, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Adds (or replaces, for the same SKU and month) exclusions. Each needs a non-empty reason. */
export function saveExclusions(dir: string, sourceLabel: string, add: readonly Exclusion[], now: Date = new Date()): StoredExclusion[] {
  for (const e of add) if (e.reason.trim() === "") throw new ExclusionStoreError("An exclusion needs a non-empty reason.");
  const current = loadExclusions(dir, sourceLabel);
  const key = (e: Exclusion) => `${e.sku}\u0000${e.month}`;
  const map = new Map(current.map((e) => [key(e), e] as const));
  for (const e of add) map.set(key(e), { sku: e.sku, month: e.month, reason: e.reason.trim(), at: now.toISOString() });
  const next = [...map.values()];
  write(dir, sourceLabel, next);
  return next;
}

/** Reverses exclusions (removes them). Reversing one that does not exist is not an error. */
export function removeExclusions(dir: string, sourceLabel: string, remove: readonly { sku: string; month: string }[]): StoredExclusion[] {
  const drop = new Set(remove.map((e) => `${e.sku}\u0000${e.month}`));
  const next = loadExclusions(dir, sourceLabel).filter((e) => !drop.has(`${e.sku}\u0000${e.month}`));
  write(dir, sourceLabel, next);
  return next;
}
