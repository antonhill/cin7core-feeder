import { createHash } from "node:crypto";
import { CIN7_API_ORIGIN } from "@/cin7/api-origin";
import type { Collected, Row } from "./collect";
import { ROLES, UNRESTRICTED_ROLES, type LocationMap, type Role, type RwtsaCredentials } from "./types";

export interface RoleQty { onHand: number; allocated: number; available: number; onOrder: number; inTransit: number }
export interface SkuStock {
  sku: string;
  byRole: Partial<Record<Role, RoleQty>>;
  /** Σ OnHand over the five mapped roles (Bond included). Locations outside the map are in `unmapped`, never in here. */
  physical: number;
  bond: number;
  /** physical − bond. */
  unrestricted: number;
  /** Σ Allocated over the four non-Bond roles. */
  allocatedUnrestricted: number;
  /** unrestricted − allocatedUnrestricted: the workbook's own Available rule (JHB + Durban + Cape Town + Factory − committed). Bond is never usable. */
  usable: number;
  unmapped: number;
  reportedAvailable: number;
  onOrder: number;
  inTransit: number;
}
export interface Snapshot {
  schemaVersion: 1;
  takenAt: string;
  source: { instanceLabel: string; apiOrigin: string; method: "GET"; readOnly: true };
  endpoints: Array<{ path: string; pages: number; records: number; reportedTotal: number | null; complete: boolean }>;
  contract: { availabilityFields: string[]; locationFields: string[]; productFields: string[] };
  completeness: { status: "COMPLETE" | "INCOMPLETE"; problems: string[] };
  locationMapping: {
    bond: { id: string; verifiedInLocationList: boolean; observedName: string | null };
    roles: Partial<Record<Role, { id: string; verifiedInLocationList: boolean; observedName: string | null }>>;
    unmappedLocationCount: number;
    joinKey: "location name, unique within this snapshot's location list, resolved to the verified ID";
  };
  counts: { products: number; locations: number; availabilityRows: number; skus: number };
  stock: SkuStock[];
  contentHash: string;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown) => (typeof v === "string" ? v : "");

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") { const o = v as Record<string, unknown>; return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`; }
  return JSON.stringify(v);
}
const hashOf = (s: Omit<Snapshot, "contentHash">) => createHash("sha256").update(canonical(s)).digest("hex");
export function verifySnapshotIntegrity(s: Snapshot): boolean {
  const { contentHash, ...rest } = s;
  return typeof contentHash === "string" && hashOf(rest) === contentHash;
}

export function buildSnapshot(i: { creds: RwtsaCredentials; locationMap: LocationMap; locations: Collected<Row>; availability: Collected<Row>; products: Collected<Row>; takenAt: string }): Snapshot {
  const problems: string[] = [];
  for (const [n, c] of [["location list", i.locations], ["stock availability", i.availability], ["product list", i.products]] as const) for (const p of c.problems) problems.push(`${n}: ${p}`);

  // Location identity: ID -> {name} from the account's own location list. Names are only a join key, and only if unique.
  const idToName = new Map<string, string>();
  const nameToIds = new Map<string, string[]>();
  for (const l of i.locations.rows) {
    const id = str(l.ID).toLowerCase(), name = str(l.Name);
    if (!id) continue;
    idToName.set(id, name);
    nameToIds.set(name, [...(nameToIds.get(name) ?? []), id]);
  }
  const ambiguous = [...nameToIds.values()].filter((ids) => ids.length > 1).length;
  if (ambiguous) problems.push(`location join is ambiguous: ${ambiguous} display name(s) are shared by more than one location`);

  const idToRole = new Map<string, Role>();
  const roles: Snapshot["locationMapping"]["roles"] = {};
  for (const r of ROLES) {
    const id = i.locationMap[r]; if (!id) continue;
    idToRole.set(id.toLowerCase(), r);
    roles[r] = { id, verifiedInLocationList: idToName.has(id.toLowerCase()), observedName: idToName.get(id.toLowerCase()) ?? null };
  }
  const bond = roles.BOND!;
  if (!bond.verifiedInLocationList) problems.push("the configured Bond location ID is not in the account's location list");
  for (const r of ROLES) if (roles[r] && !roles[r]!.verifiedInLocationList && r !== "BOND") problems.push(`the configured ${r} location ID is not in the account's location list`);
  const unmappedLocationCount = [...idToName.keys()].filter((id) => !idToRole.has(id)).length;

  const bySku = new Map<string, SkuStock>();
  let unknownLocationRows = 0;
  for (const a of i.availability.rows) {
    const sku = str(a.SKU); if (!sku) continue;
    const directId = str(a.LocationID ?? a.LocationId).toLowerCase();
    const name = str(a.Location);
    const ids = directId ? [directId] : nameToIds.get(name) ?? [];
    let s = bySku.get(sku);
    if (!s) bySku.set(sku, (s = { sku, byRole: {}, physical: 0, bond: 0, unrestricted: 0, allocatedUnrestricted: 0, usable: 0, unmapped: 0, reportedAvailable: 0, onOrder: 0, inTransit: 0 }));
    if (ids.length !== 1 || !idToName.has(ids[0])) { unknownLocationRows++; continue; }
    const role = idToRole.get(ids[0]);
    s.onOrder += num(a.OnOrder); s.inTransit += num(a.InTransit); s.reportedAvailable += num(a.Available);
    if (!role) { s.unmapped += num(a.OnHand); continue; }
    const q = (s.byRole[role] ??= { onHand: 0, allocated: 0, available: 0, onOrder: 0, inTransit: 0 });
    q.onHand += num(a.OnHand); q.allocated += num(a.Allocated); q.available += num(a.Available); q.onOrder += num(a.OnOrder); q.inTransit += num(a.InTransit);
  }
  if (unknownLocationRows) problems.push(`${unknownLocationRows} stock row(s) name a location that cannot be resolved to exactly one known location ID`);

  for (const s of bySku.values()) {
    s.physical = ROLES.reduce((t, r) => t + (s.byRole[r]?.onHand ?? 0), 0);
    s.bond = s.byRole.BOND?.onHand ?? 0;
    s.unrestricted = s.physical - s.bond;
    s.allocatedUnrestricted = UNRESTRICTED_ROLES.reduce((t, r) => t + (s.byRole[r]?.allocated ?? 0), 0);
    s.usable = s.unrestricted - s.allocatedUnrestricted;
  }

  const body: Omit<Snapshot, "contentHash"> = {
    schemaVersion: 1,
    takenAt: i.takenAt,
    source: { instanceLabel: i.creds.instanceLabel, apiOrigin: CIN7_API_ORIGIN, method: "GET", readOnly: true },
    endpoints: ([["/ref/location", i.locations], ["/ref/productavailability", i.availability], ["/product", i.products]] as const).map(([path, c]) => ({ path, pages: c.pages, records: c.rows.length, reportedTotal: c.reportedTotal, complete: c.complete })),
    contract: { availabilityFields: i.availability.observedFields, locationFields: i.locations.observedFields, productFields: i.products.observedFields },
    completeness: { status: problems.length === 0 ? "COMPLETE" : "INCOMPLETE", problems },
    locationMapping: { bond: { id: bond.id, verifiedInLocationList: bond.verifiedInLocationList, observedName: bond.observedName }, roles, unmappedLocationCount, joinKey: "location name, unique within this snapshot's location list, resolved to the verified ID" },
    counts: { products: i.products.rows.length, locations: i.locations.rows.length, availabilityRows: i.availability.rows.length, skus: bySku.size },
    stock: [...bySku.values()].sort((a, b) => a.sku.localeCompare(b.sku)),
  };
  return { ...body, contentHash: hashOf(body) };
}
