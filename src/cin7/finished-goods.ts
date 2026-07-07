import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

/**
 * Confirmed live (2026-07-06): the resource representing an actual assembly
 * build/job (distinct from an Assembly BOM *definition*, which lives on
 * /Product — see assembly-bom.ts) is `/finishedGoodsList` (capital-case
 * `Page`/`Limit`), list key `FinishedGoods`. Every other candidate path
 * (`/assembly`, `/AssemblyList`, `/production/assembly`, etc.) returns Cin7's
 * branded "Page not found" HTML with HTTP 200 — not a real endpoint. Real
 * `Status` value set is DRAFT/AUTHORISED/IN PROGRESS/COMPLETED/VOIDED. No
 * deadline/due-date field exists anywhere on this resource, even at detail
 * level (`ExpiryDate` is a batch/perishable-tracking field, always null on
 * every record checked; `Date`/`WIPDate`/`CompletionDate` are all
 * progress timestamps, not target dates) — confirmed, not a gap in this
 * client.
 *
 * Confirmed live (2026-07-07), via `findFinishedGoodsExample` in debug.ts,
 * ahead of adding quantity/cost to the Assemblies report: **the list
 * response already carries `Quantity` and `UnitCost`** — no per-record
 * detail call needed (the detail endpoint, `/finishedgoods?TaskID=`, does
 * also work, confirmed the same pass, but isn't used here — an N+1 detail
 * call per assembly would be a real rate-limit cost for no gain once the
 * total's already available on the list). On the one real example checked
 * (`Quantity: 1`, `UnitCost: 2000`), `Quantity * UnitCost` exactly matched
 * the detail endpoint's own `OrderLines[].TotalCost` sum (2000) — the
 * standard unit-cost × quantity = total-cost reading, though only actually
 * observed against a `Quantity: 1` example (so the multiplication itself is
 * the conventional interpretation, not independently confirmed against a
 * `Quantity > 1` record — revisit if that ever looks wrong on real data).
 */
export interface Cin7FinishedGoodsListEntry {
  TaskID: string;
  AssemblyNumber?: string;
  ProductCode?: string;
  ProductName?: string;
  Status?: string;
  Date?: string | null;
  Quantity?: number;
  UnitCost?: number;
}

/** Fetches every finished-goods assembly record on the account. Paginates until a short page signals the end, same pattern as fetchAllSalesList. */
export async function fetchAllFinishedGoodsList(creds: Cin7Credentials): Promise<Cin7FinishedGoodsListEntry[]> {
  const pageSize = 100;
  const all: Cin7FinishedGoodsListEntry[] = [];
  for (let page = 1; ; page++) {
    const response = await cin7Request<{ FinishedGoods?: Cin7FinishedGoodsListEntry[] }>(creds, "/finishedGoodsList", {
      query: { Page: page, Limit: pageSize },
    });
    const goods = response.FinishedGoods ?? [];
    all.push(...goods);
    if (goods.length < pageSize) break;
  }
  return all;
}

/** A planned BOM component line on the build — confirmed live 2026-07-07 (see debug.ts's findFinishedGoodsExample). `TotalCost` is the estimated/planned cost for this component across the whole build. */
export interface Cin7FinishedGoodsOrderLine {
  ProductID?: string;
  ProductCode?: string;
  Name?: string;
  Quantity?: number;
  Unit?: string;
  WastagePercent?: number;
  WastageQuantity?: number;
  TotalQuantity?: number;
  TotalCost?: number;
}

/** An actual picked/consumed batch line on the build — confirmed live 2026-07-07. `Cost` is per-unit; multiply by `Quantity` for this line's actual cost. */
export interface Cin7FinishedGoodsPickLine {
  ProductID?: string;
  ProductCode?: string;
  Name?: string;
  BatchSN?: string | null;
  Quantity?: number;
  Unit?: string;
  Cost?: number;
  NonInventory?: boolean;
}

/**
 * Full detail for one assembly build — confirmed live 2026-07-07 via
 * `/finishedgoods?TaskID=` (lowercase-singular path, same pattern as Stock
 * Transfer's confirmed detail endpoint). `OrderLines` are the BOM's planned
 * components (their `TotalCost` sums to the build's *estimated* cost);
 * `PickLines` are the actual batches consumed (`Quantity * Cost` per line
 * sums to the build's *actual* cost) — these two totals can genuinely
 * differ if wastage or substitution happened during the real build.
 *
 * **No confirmed "resources/additional costs" (labor/overhead) array on this
 * resource yet.** Product's Assembly BOM *definition* has a parallel
 * `BillOfMaterialsServices[]` (see assembly-bom.ts / docs/cin7-api-findings.md
 * §3) for exactly this kind of non-product cost line, but whether a *built*
 * assembly's own detail response carries a matching services/resources array
 * hasn't been confirmed — the one live example checked had no services
 * attached to its BOM, and Cin7 appears to omit empty arrays entirely rather
 * than send them empty (same documented convention for the BOM definition),
 * so its absence here doesn't prove the field doesn't exist. Needs a live
 * check against an assembly whose product BOM actually has services
 * configured — see `surveyFinishedGoodsFields` in debug.ts.
 */
export interface Cin7FinishedGoodsDetail {
  TaskID: string;
  AssemblyNumber?: string;
  Status?: string;
  ProductCode?: string;
  ProductName?: string;
  Location?: string;
  Quantity?: number;
  CompletionDate?: string | null;
  OrderLines?: Cin7FinishedGoodsOrderLine[];
  PickLines?: Cin7FinishedGoodsPickLine[];
}

export async function fetchFinishedGoodsDetail(creds: Cin7Credentials, taskId: string): Promise<Cin7FinishedGoodsDetail> {
  return cin7Request<Cin7FinishedGoodsDetail>(creds, "/finishedgoods", { query: { TaskID: taskId } });
}
