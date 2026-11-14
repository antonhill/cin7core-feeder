// RWTSA (read-only): does ONE finished-good SKU have a production BOM? Two GETs: /product?Sku= (resolve the Cin7 product ID; the BOM resource is addressed by ID, not SKU) and /production/productionBOM?ProductID=.
// Never writes, never creates a BOM, never invents a count: when the response does not carry operations/components the count is null and the field NAMES are reported instead.
import type { ReadOnlyClient } from "./client";
import { RwtsaLiveError } from "./types";

type Row = Record<string, unknown>;
const isRow = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.filter(isRow) : []);
const bad = (m: string): never => { throw new RwtsaLiveError("BAD_RESPONSE", m); };

export interface BomVersion { version: string | null; name: string | null; isDefault: boolean | null; operations: number | null; components: number | null }
export interface BomEvidence {
  takenAt: string; requests: number; methodsUsed: string[]; sku: string;
  productFound: boolean; status: "BOM_PRESENT" | "NO_BOM_FOUND" | "PRODUCT_NOT_FOUND";
  versions: BomVersion[]; responseFields: string[];
  /** Top-level key NAMES of the BOM response (never values): distinguishes 'no BOM' from 'a response shape this collector did not recognise'. */
  responseTopLevelFields: string[];
}

export async function inspectProductionBom(client: ReadOnlyClient, sku: string, opts: { takenAt?: string } = {}): Promise<BomEvidence> {
  const takenAt = opts.takenAt ?? new Date().toISOString();
  const done = (status: BomEvidence["status"], versions: BomVersion[], responseFields: string[], productFound: boolean, responseTopLevelFields: string[] = []): BomEvidence =>
    ({ takenAt, requests: client.requests(), methodsUsed: client.methodsUsed(), sku, productFound, status, versions, responseFields, responseTopLevelFields });
  const prod = await client.get<Row>("/product", { Sku: sku, Page: 1, Limit: 5 });
  if (!isRow(prod) || !Array.isArray(prod.Products)) bad("Unexpected response shape from the product lookup (Products is missing).");
  const exact = rows(prod.Products).filter((p) => p.SKU === sku);
  if (exact.length === 0) return done("PRODUCT_NOT_FOUND", [], [], false);
  const ids = [...new Set(exact.map((p) => (typeof p.ID === "string" ? p.ID : "")).filter(Boolean))];
  if (ids.length !== 1) bad("The product lookup did not return exactly one product ID for this SKU; no BOM request was made.");
  const res = await client.get<Row>("/production/productionBOM", { ProductID: ids[0] });
  if (!isRow(res)) bad("Unexpected response shape from the production BOM request.");
  const list = rows(res.ProductionBOMs);
  const count = (v: unknown, f: (x: Row) => number): number | null => (Array.isArray(v) ? rows(v).reduce((n, x) => n + f(x), 0) : null);
  const versions = list.map((v): BomVersion => {
    const ops = v.Operations;
    return {
      version: typeof v.Version === "string" ? v.Version : null,
      name: typeof v.VersionName === "string" ? v.VersionName : typeof v.Name === "string" ? v.Name : null,
      isDefault: typeof v.IsDefault === "boolean" ? v.IsDefault : null,
      operations: Array.isArray(ops) ? ops.length : null,
      components: count(ops, (o) => (Array.isArray(o.Components) ? o.Components.length : 0)),
    };
  });
  const names = [...new Set(list.flatMap((v) => Object.keys(v)))].sort();
  return done(versions.length > 0 ? "BOM_PRESENT" : "NO_BOM_FOUND", versions, names, true, Object.keys(res).sort());
}
