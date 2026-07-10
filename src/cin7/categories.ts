import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

/**
 * Cin7's own category model (`GET /ref/category`, confirmed via the Apiary
 * spec) is just an `ID` (guid) + `Name` — no "code" concept at all. This
 * app's own `categories` table (populated so far only from imported product
 * CSVs, never from Cin7 directly) invented a `code` column that CSV imports
 * happen to fill with the same free-text value as `name` — kept that shape
 * here for continuity rather than introducing a second identifier scheme.
 */
export interface Cin7Category {
  ID: string;
  Name: string;
}

/** Every category on this Cin7 instance, paginated. */
export async function fetchAllCategories(creds: Cin7Credentials): Promise<Cin7Category[]> {
  const pageSize = 100;
  const all: Cin7Category[] = [];
  for (let page = 1; ; page++) {
    const response = await cin7Request<{ CategoryList?: Cin7Category[] }>(creds, "/ref/category", { query: { Page: page, Limit: pageSize } });
    const categories = response.CategoryList ?? [];
    all.push(...categories);
    if (categories.length < pageSize) break;
  }
  return all;
}
