import type { ReadOnlyClient } from "./client";

export interface Collected<T> { rows: T[]; pages: number; reportedTotal: number | null; complete: boolean; problems: string[]; observedFields: string[] }
export type Row = Record<string, unknown>;

const MAX_PAGES = 500;
const fingerprint = (r: Row | undefined) => (r ? JSON.stringify(r) : "");

interface Shape { nonEmpty?: boolean; required?: string[][] }
async function paginate(client: ReadOnlyClient, path: string, listKey: string | null, pageSize: number, dupKey?: (r: Row) => string, shape: Shape = {}): Promise<Collected<Row>> {
  const rows: Row[] = [];
  const problems: string[] = [];
  const fields = new Set<string>();
  const seen = new Set<string>();
  let reportedTotal: number | null = null;
  let pages = 0;
  let prevFirst = "", prevLast = "";
  let duplicates = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await client.get<Row>(path, { Page: page, Limit: pageSize });
    pages++;
    if (typeof body.Total === "number") reportedTotal = body.Total;
    if (listKey && !Array.isArray(body[listKey])) { problems.push(`the expected list is not present on page ${page} (the response shape may have changed)`); break; }
    const list = (listKey ? body[listKey] : Object.values(body).find(Array.isArray) ?? []) as Row[];
    if (page > 1 && list.length > 0 && fingerprint(list[0]) === prevFirst && fingerprint(list[list.length - 1]) === prevLast) { problems.push(`page ${page} repeats page ${page - 1} (the server did not advance)`); break; }
    prevFirst = fingerprint(list[0]); prevLast = fingerprint(list[list.length - 1]);
    for (const r of list) {
      Object.keys(r).forEach((k) => fields.add(k));
      if (dupKey) { const k = dupKey(r); if (seen.has(k)) { duplicates++; continue; } seen.add(k); }
      rows.push(r);
    }
    if (list.length < pageSize) break;
    if (page === MAX_PAGES) problems.push("stopped at the page ceiling before a short page");
  }
  if (reportedTotal === null) problems.push("Cin7 did not report a total, so completeness cannot be confirmed");
  if (shape.nonEmpty && rows.length === 0) problems.push("no rows were returned");
  for (const alts of shape.required ?? []) if (rows.length > 0 && !alts.some((a) => fields.has(a))) problems.push(`the expected field ${alts.join(" / ")} was not seen in any row`);
  if (duplicates) problems.push(`${duplicates} duplicate row(s) were dropped, not counted twice`);
  if (reportedTotal !== null && rows.length + duplicates !== reportedTotal) problems.push(`received ${rows.length + duplicates} row(s) but Cin7 reported a total of ${reportedTotal}`);
  return { rows, pages, reportedTotal, complete: problems.length === 0, problems, observedFields: [...fields].sort() };
}

const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
export const collectAvailability = (c: ReadOnlyClient) =>
  paginate(c, "/ref/productavailability", "ProductAvailabilityList", 1000, (r) => [s(r.SKU), s(r.LocationID ?? r.LocationId ?? r.Location), s(r.Bin), s(r.Batch), s(r.ExpiryDate)].join("|"),
    { nonEmpty: true, required: [["SKU"], ["Location", "LocationID", "LocationId"], ["OnHand"], ["Allocated"]] });
export const collectProducts = (c: ReadOnlyClient) => paginate(c, "/product", "Products", 1000, (r) => s(r.ID), { required: [["ID"], ["SKU"]] });
export const collectLocations = (c: ReadOnlyClient) => paginate(c, "/ref/location", null, 100, (r) => s(r.ID).toLowerCase(), { nonEmpty: true, required: [["ID"], ["Name"]] });
