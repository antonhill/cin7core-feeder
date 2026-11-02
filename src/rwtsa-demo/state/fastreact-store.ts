import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DATE_FORMATS, LIMITS } from "@/rwtsa-demo/fastreact/contract";
import type { ExportOptions, Supplement } from "@/rwtsa-demo/fastreact/export";
import { EMPTY_RETURNS, type StoredReturns } from "@/rwtsa-demo/fastreact/return-reconcile";
import { assertOutputDirAllowed } from "@/rwtsa-demo/workbook/path-guard";

/**
 * Fast React exchange state persisted as local demo state OUTSIDE every git working tree (the same directory and rules as the planner
 * exclusions: `RWTSA_STATE_DIR` or `~/.rwtsa-demo`). One small JSON file per data source, written atomically with owner-only
 * permissions. It holds only what the planner entered (customer / delivery date / status per order, product type per style, export
 * options), the applied return-file results, and at most one pending (previewed, not yet applied) return file.
 *
 * Nothing here is ever written into the repository, the build output or the workbook, and nothing leaves the machine.
 */

const Str = z.string().max(2000);
const SupplementSchema = z.object({
  orders: z.record(z.string().max(100), z.object({ customer: Str.nullable(), deliveryDate: Str.nullable(), status: Str.nullable() })),
  productTypes: z.record(z.string().max(100), z.object({ code: Str, workContent: z.record(z.string().max(20), z.number()).optional() })),
});
const RecordFields = {
  line: Str,
  section: Str,
  start: Str,
  end: Str,
  delivery: Str,
  status: z.enum(["PLANNED", "IN_PROGRESS", "COMPLETE", "HELD"]),
  qtyDone: z.number().int().nonnegative(),
  updatedAt: Str,
};
const SourceKind = z.enum(["synthetic-sample", "upload"]);
const FileSchema = z.object({
  schemaVersion: z.literal(1),
  source: Str,
  supplement: SupplementSchema,
  options: z.object({
    delimiter: z.enum(["tab", "csv"]),
    dateFormat: z.enum(DATE_FORMATS as unknown as [string, ...string[]]),
    headerStyle: z.enum(["standard", "compliant"]),
    selectedOrders: z.array(Str).max(LIMITS.maxExportRows).nullable(),
  }),
  returns: z.object({
    orders: z.record(
      z.string().max(100),
      z.object({ ...RecordFields, fileHash: z.string().length(64), appliedAt: Str, sourceKind: SourceKind }),
    ),
    history: z
      .array(
        z.object({
          fileHash: z.string().length(64),
          appliedAt: Str,
          sourceKind: SourceKind,
          rows: z.number().int(),
          accepted: z.number().int(),
          rejected: z.number().int(),
          duplicates: z.number().int(),
          stale: z.number().int(),
          conflicts: z.number().int(),
          superseded: z.number().int(),
        }),
      )
      .max(100),
  }),
  pending: z
    .object({ fileHash: z.string().length(64), text: z.string().max(LIMITS.maxReturnBytes), sourceKind: SourceKind, createdAt: Str })
    .nullable(),
});

export interface ExchangeState {
  readonly supplement: Supplement;
  readonly options: Pick<ExportOptions, "delimiter" | "dateFormat" | "headerStyle" | "selectedOrders">;
  readonly returns: StoredReturns;
  readonly pending: { readonly fileHash: string; readonly text: string; readonly sourceKind: "synthetic-sample" | "upload"; readonly createdAt: string } | null;
}

export const EMPTY_EXCHANGE: ExchangeState = {
  supplement: { orders: {}, productTypes: {} },
  options: { delimiter: "tab", dateFormat: "YYYY-MM-DD", headerStyle: "standard", selectedOrders: null },
  returns: EMPTY_RETURNS,
  pending: null,
};

export class ExchangeStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExchangeStoreError";
  }
}

function fileFor(dir: string, label: string): string {
  const key = createHash("sha256").update(label).digest("hex").slice(0, 16);
  return path.join(dir, `fastreact-${key}.json`);
}

function safeDir(dir: string): string {
  try {
    const real = assertOutputDirAllowed(dir);
    try {
      chmodSync(real, 0o700);
    } catch {
      /* best effort on filesystems without modes */
    }
    return real;
  } catch (e) {
    throw new ExchangeStoreError(e instanceof Error && e.name === "RwtsaSafeError" ? e.message : "The local state directory is not usable.");
  }
}

/** A missing file is the empty state; a corrupt or foreign file is an error and is never treated as empty. */
export function loadExchange(dir: string, label: string): ExchangeState {
  const file = fileFor(dir, label);
  if (!existsSync(file)) return EMPTY_EXCHANGE;
  let parsed: z.infer<typeof FileSchema>;
  try {
    parsed = FileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new ExchangeStoreError("The saved Fast React exchange file is unreadable or corrupt. Nothing was applied; remove the file to start again.");
  }
  if (parsed.source !== label) throw new ExchangeStoreError("The saved Fast React exchange data belongs to a different data source. Nothing was applied.");
  return { supplement: parsed.supplement, options: parsed.options as ExchangeState["options"], returns: parsed.returns as StoredReturns, pending: parsed.pending };
}

/** Reads, transforms and atomically writes. If `fn` throws, nothing is written (and no file is created). */
export function updateExchange(dir: string, label: string, fn: (current: ExchangeState) => ExchangeState): ExchangeState {
  const real = safeDir(dir);
  const next = fn(loadExchange(real, label));
  const body = JSON.stringify({ schemaVersion: 1, source: label, ...next }, null, 2);
  try {
    FileSchema.parse(JSON.parse(body));
  } catch {
    throw new ExchangeStoreError("The Fast React exchange data failed its own validation; nothing was saved.");
  }
  const file = fileFor(real, label);
  const tmp = `${file}.${randomUUID()}.tmp`;
  mkdirSync(real, { recursive: true });
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, file);
  return next;
}
