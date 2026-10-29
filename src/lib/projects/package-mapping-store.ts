import "server-only";
// Reusable, version-controlled package -> Cin7 SKU mappings (migration 0109). A saved mapping is only ever OFFERED: applying one to a project is a
// normal audited resolution (the project stores its own copy plus the version it came from), so a later version never alters an existing project or
// a frozen quotation. Until the migration is applied every read reports "unavailable" (never "no mappings").
import type { createServiceRoleClient } from "@/supabase/server";
import type { LibraryMapping } from "./product-scope";

type Db = ReturnType<typeof createServiceRoleClient>;
function fail(message: string): never { throw new Error(message); }
const missingTable = (m: string) => /does not exist|schema cache|relation/i.test(m);

export interface PackageMapping {
  id: string; package_key: string; version: number; status: "ACTIVE" | "SUPERSEDED";
  lines: Array<{ sku: string; factor: number; unit: string; role: "FINISHED_GOOD" | "BOM_COMPONENT"; assembly?: boolean | null; quantityBasis?: "PER_QUOTED_UNIT" | "MANAGER_CONFIRM" }>;
  reason: string; created_by_email: string; created_at: string; superseded_at: string | null;
}

/** Every version of a package's mapping (newest first), or null when the table does not exist yet. */
export async function listMappingVersions(db: Db, orgId: string, packageKey: string): Promise<PackageMapping[] | null> {
  const r = await db.from("newquip_package_mappings").select("*").eq("org_id", orgId).eq("package_key", packageKey).order("version", { ascending: false });
  if (r.error) { if (missingTable(r.error.message)) return null; fail(r.error.message); }
  return (r.data ?? []) as PackageMapping[];
}

export const libraryOf = (m: ReadonlyMap<string, PackageMapping>): Map<string, LibraryMapping> =>
  new Map([...m].map(([k, v]) => [k, { packageKey: v.package_key, version: v.version, lines: v.lines }]));

/** Every ACTIVE mapping of the organisation keyed by package, or null when the table does not exist yet (approval then simply applies none). */
export async function listActiveMappings(db: Db, orgId: string): Promise<Map<string, PackageMapping> | null> {
  const r = await db.from("newquip_package_mappings").select("*").eq("org_id", orgId).eq("status", "ACTIVE");
  if (r.error) { if (missingTable(r.error.message)) return null; fail(r.error.message); }
  return new Map(((r.data ?? []) as PackageMapping[]).map((m) => [m.package_key, m]));
}

export async function activeMapping(db: Db, orgId: string, packageKey: string): Promise<PackageMapping | null | "UNAVAILABLE"> {
  const all = await listMappingVersions(db, orgId, packageKey);
  if (all === null) return "UNAVAILABLE";
  return all.find((m) => m.status === "ACTIVE") ?? null;
}

export interface SaveMappingLine { sku: string; /** SKU units per ONE quoted unit. Ignored when confirmQuantity is set. */ factor: number; unit?: string; /** The quantity depends on the layout: no formula is stored and a manager confirms it per quotation. */ confirmQuantity?: boolean }

/**
 * Saves a NEW version (the database assigns the number and supersedes the previous ACTIVE one). A mapping lists the SELLABLE Cin7 products NewQuip
 * supplies for one quoted package (standard stock or Cin7 assembly products alike); the internal components of an assembly are Cin7's concern and
 * cannot be listed. Every SKU is verified to exist (exact, read-only); the assembly flag is read from Cin7 where available and kept for display only.
 */
export async function saveMappingVersion(
  db: Db, port: { resolveProducts(skus: string[]): Promise<{ missing: string[] }>; assemblySkus?(skus: string[]): Promise<string[]> }, gates: { isManager: boolean }, email: string,
  input: { orgId: string; packageKey: string; lines: SaveMappingLine[]; reason: string },
): Promise<PackageMapping> {
  if (!gates.isManager) fail("Only a manager (org owner/admin) can save a reusable mapping.");
  const key = input.packageKey.trim();
  if (!key) fail("A mapping needs a package key.");
  if (!input.reason.trim()) fail("A reason is required.");
  if (!input.lines || input.lines.length === 0) fail("Add at least one Cin7 SKU line.");
  if (input.lines.some((l) => (l as { role?: string }).role === "BOM_COMPONENT")) fail("Internal components of a Cin7 assembly are managed in Cin7. List only the products NewQuip supplies.");
  const seen = new Set<string>();
  for (const l of input.lines) {
    const sku = (l.sku ?? "").trim();
    if (!sku) fail("Every line needs a Cin7 SKU.");
    if (seen.has(sku)) fail(`${sku} is listed twice; combine it into one line.`);
    seen.add(sku);
    if (!l.confirmQuantity && !(typeof l.factor === "number" && Number.isFinite(l.factor) && l.factor > 0)) fail(`${sku}: the quantity per quoted unit must be a positive number (or mark the quantity as manager-confirmed).`);
  }
  const skus = input.lines.map((l) => l.sku.trim());
  const res = await port.resolveProducts(skus);
  if (res.missing.length) fail(`SKU ${res.missing.join(", ")} does not exist in Cin7 (exact match). Nothing was saved.`);
  let assembly: Set<string> | null = null;
  try { assembly = port.assemblySkus ? new Set(await port.assemblySkus(skus)) : null; } catch { assembly = null; } // unknown, never "not an assembly"
  const lines = input.lines.map((l) => ({
    sku: l.sku.trim(), factor: l.confirmQuantity ? 1 : l.factor, unit: (l.unit ?? "").trim() || "each", role: "FINISHED_GOOD" as const,
    quantityBasis: l.confirmQuantity ? "MANAGER_CONFIRM" as const : "PER_QUOTED_UNIT" as const, assembly: assembly ? assembly.has(l.sku.trim()) : null,
  }));
  const ins = await db.from("newquip_package_mappings").insert({ org_id: input.orgId, package_key: key, lines, reason: input.reason.trim(), created_by_email: email }).select("*").single();
  if (ins.error || !ins.data) fail(missingTable(ins.error?.message ?? "") ? "Reusable mappings are not available yet (database migration pending)." : `save mapping: ${ins.error?.message ?? "no row"}`);
  return ins.data as PackageMapping;
}
