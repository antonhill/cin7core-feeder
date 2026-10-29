import "server-only";
// Reusable, version-controlled package -> Cin7 SKU mappings (migration 0109). A saved mapping is only ever OFFERED: applying one to a project is a
// normal audited resolution (the project stores its own copy plus the version it came from), so a later version never alters an existing project or
// a frozen quotation. Until the migration is applied every read reports "unavailable" (never "no mappings").
import type { createServiceRoleClient } from "@/supabase/server";
import { buildMappedLines, type LibraryMapping, type ResolveLineInput } from "./product-scope";

type Db = ReturnType<typeof createServiceRoleClient>;
function fail(message: string): never { throw new Error(message); }
const missingTable = (m: string) => /does not exist|schema cache|relation/i.test(m);

export interface PackageMapping {
  id: string; package_key: string; version: number; status: "ACTIVE" | "SUPERSEDED";
  lines: Array<{ sku: string; factor: number; unit: string; role: "FINISHED_GOOD" | "BOM_COMPONENT" }>;
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

/**
 * Saves a NEW version (the database assigns the number and supersedes the previous ACTIVE one). The lines are checked with the same rules as a
 * project resolution (real SKUs are verified against Cin7 by the caller's port). Quantity-independent: the factor is per ONE quoted unit.
 */
export async function saveMappingVersion(
  db: Db, port: { resolveProducts(skus: string[]): Promise<{ missing: string[] }> }, gates: { isManager: boolean }, email: string,
  input: { orgId: string; packageKey: string; lines: ResolveLineInput[]; reason: string },
): Promise<PackageMapping> {
  if (!gates.isManager) fail("Only a manager (org owner/admin) can save a reusable mapping.");
  const key = input.packageKey.trim();
  if (!key) fail("A mapping needs a package key.");
  if (!input.reason.trim()) fail("A reason is required.");
  const built = buildMappedLines(1, input.lines);
  if (!built.ok) fail(built.error);
  const res = await port.resolveProducts(built.lines.map((l) => l.sku));
  if (res.missing.length) fail(`SKU ${res.missing.join(", ")} does not exist in Cin7 (exact match). Nothing was saved.`);
  const ins = await db.from("newquip_package_mappings").insert({
    org_id: input.orgId, package_key: key, lines: built.lines.map((l) => ({ sku: l.sku, factor: l.factor, unit: l.unit, role: l.role })), reason: input.reason.trim(), created_by_email: email,
  }).select("*").single();
  if (ins.error || !ins.data) fail(missingTable(ins.error?.message ?? "") ? "Reusable mappings are not available yet (database migration pending)." : `save mapping: ${ins.error?.message ?? "no row"}`);
  return ins.data as PackageMapping;
}
