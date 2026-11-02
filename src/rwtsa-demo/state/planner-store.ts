import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assertOutputDirAllowed } from "@/rwtsa-demo/workbook/path-guard";

/**
 * Planner decisions (tender classification, temporary minimums, order overrides, local-make assumptions) persisted as local demo
 * state OUTSIDE every git working tree (the same directory rules as planner exclusions). One JSON file per data source. Writes are
 * atomic and owner-only. Nothing here changes the protected workbook, and nothing leaves the machine.
 */

const Iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Sku = z.string().min(1).max(200);
const Reason = z.string().trim().min(1).max(500);

const Schema = z.object({
  schemaVersion: z.literal(1),
  source: z.string(),
  classification: z.array(z.object({ sku: Sku, value: z.enum(["ordinary", "tender"]), reason: z.string().max(500).nullable(), at: z.string() })),
  minOverrides: z.array(z.object({ sku: Sku, originalMin: z.number().nullable(), replacement: z.number().min(0), effectiveFrom: Iso, expires: Iso.nullable(), reason: Reason, at: z.string() })),
  orderOverrides: z.array(z.object({ sku: Sku, quantity: z.number().int().min(0), calculatedAtOverride: z.number().int().min(0).nullable(), reason: Reason, at: z.string() })),
  localMake: z.array(z.object({ sku: Sku, quantity: z.number().int().min(0), capacityUnits: z.number().int().min(0), leadTimeWeeks: z.number().int().min(0).max(52), completionWeek: z.number().int().min(1).max(52), at: z.string() })),
});

export type PlannerState = Omit<z.infer<typeof Schema>, "schemaVersion" | "source">;
export const EMPTY_PLANNER: PlannerState = { classification: [], minOverrides: [], orderOverrides: [], localMake: [] };

export class PlannerStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlannerStoreError";
  }
}

function fileFor(dir: string, sourceLabel: string): string {
  const key = createHash("sha256").update(sourceLabel).digest("hex").slice(0, 16);
  return path.join(dir, `planner-${key}.json`);
}

function safeDir(dir: string): string {
  try {
    const real = assertOutputDirAllowed(dir);
    try {
      chmodSync(real, 0o700);
    } catch {
      /* best effort */
    }
    return real;
  } catch (e) {
    throw new PlannerStoreError(e instanceof Error && e.name === "RwtsaSafeError" ? e.message : "The local state directory is not usable.");
  }
}

/** A missing file is an empty state; a corrupt file or one for another source is an error (never silently ignored). */
export function loadPlanner(dir: string, sourceLabel: string): PlannerState {
  const file = fileFor(dir, sourceLabel);
  if (!existsSync(file)) return EMPTY_PLANNER;
  let parsed: z.infer<typeof Schema>;
  try {
    parsed = Schema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new PlannerStoreError("The saved planner decisions file is unreadable or corrupt. Nothing was applied; remove the file to start again.");
  }
  if (parsed.source !== sourceLabel) throw new PlannerStoreError("The saved planner decisions belong to a different data source. Nothing was applied.");
  return { classification: parsed.classification, minOverrides: parsed.minOverrides, orderOverrides: parsed.orderOverrides, localMake: parsed.localMake };
}

function write(dir: string, sourceLabel: string, state: PlannerState): void {
  const real = safeDir(dir);
  const file = fileFor(real, sourceLabel);
  const tmp = `${file}.${randomUUID()}.tmp`;
  mkdirSync(real, { recursive: true });
  writeFileSync(tmp, JSON.stringify({ schemaVersion: 1, source: sourceLabel, ...state }, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Applies `change` to the stored state and writes it back; the change is validated by the schema before anything is written. */
export function updatePlanner(dir: string, sourceLabel: string, change: (s: PlannerState) => PlannerState): PlannerState {
  const next = change(loadPlanner(dir, sourceLabel));
  try {
    Schema.parse({ schemaVersion: 1, source: sourceLabel, ...next });
  } catch {
    throw new PlannerStoreError("The planner decision is not valid. Nothing was changed.");
  }
  write(dir, sourceLabel, next);
  return next;
}
