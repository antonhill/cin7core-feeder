/**
 * Reads every row of a Supabase table query, paging explicitly.
 *
 * PostgREST caps any single response at its configured max-rows regardless of
 * how many rows the query actually matches. `src/reports/query.ts` already
 * records this for RPCs — "confirmed live 2026-08-04: Order Fulfillment's
 * 'All Orders' count was silently stuck at exactly 1000 while the DB itself
 * had 9,915 orders" — and the same cap applies to ordinary table selects.
 *
 * **It fails silently.** There is no error and no truncation flag: the caller
 * simply receives a prefix of the rows and cannot tell. That is what made this
 * expensive to find in the sync engine, where an unbounded `products` read had
 * been quietly considering a fraction of a large client's catalog.
 *
 * This is the table-select analogue of that file's own `fetchAllRpcRows`, kept
 * to the same shape deliberately — page until a short page, fail closed on any
 * error — so the codebase has one paging idea rather than two. It differs in
 * one respect: there is **no row ceiling**. `fetchAllRpcRows` throws past
 * MAX_RPC_ROWS because a report that large is a user-facing mistake worth
 * refusing; a sync must process whatever the client actually has, so a cap
 * here would reintroduce the very truncation this exists to prevent.
 *
 * **The caller must apply a deterministic total order** over a column set that
 * is unique within the query's own filters. Range paging over an unordered
 * query is not merely non-deterministic — rows can repeat across pages and
 * others never appear at all, because the planner is free to return a
 * different order per statement.
 */
export const SUPABASE_PAGE_SIZE = 1000;

interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/**
 * @param label   Identifies the query in any thrown error — the table name is
 *                usually right, since that is what a reader needs to locate it.
 * @param fetchPage Builds and runs one page. Apply the ordering and every
 *                filter here, then `.range(from, to)` with the given bounds.
 */
export async function fetchAllRows<T>(label: string, fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>): Promise<T[]> {
  const all: T[] = [];

  for (let from = 0; ; from += SUPABASE_PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + SUPABASE_PAGE_SIZE - 1);
    // Fail closed. A partial result that reads as complete is precisely the
    // defect this helper exists to remove, so an error on page 4 must abort
    // the whole read rather than return the first three pages.
    if (error) throw new Error(`${label}: ${error.message}`);

    const rows = data ?? [];
    all.push(...rows);

    // A short page means the end. An exact multiple of the page size costs one
    // extra empty request, which is the correct trade for not needing a count.
    if (rows.length < SUPABASE_PAGE_SIZE) break;
  }

  return all;
}
