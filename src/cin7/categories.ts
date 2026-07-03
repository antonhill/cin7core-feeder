import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

/**
 * Confirmed via github.com/nnhansg/dear-openapi's Apiary spec transcription
 * (worked POST/PUT/DELETE examples), corroborated by a real wired-up call in
 * github.com/FalconEyeSolutions/CIN7-DearInventory's generated
 * ProductCategoriesApi.cs — not just a schema definition. Unlike Work
 * Centres/Resources, Category is referenced on the Product payload by plain
 * Name string, not by ID, so there's no ID to resolve for the push itself —
 * this only needs to ensure the name exists in Cin7 first. Confirmed live:
 * POST/PUT /Product rejects an unrecognized Category with "Category not
 * found." (unlike Cin7's own UI/CSV bulk-import, which auto-creates one).
 */
const CATEGORY_PATH = "/ref/category";

interface Cin7Category {
  ID?: string;
  Name?: string;
}

interface Cin7CategoryListResponse {
  CategoryList?: Cin7Category[];
}

async function categoryExists(creds: Cin7Credentials, name: string): Promise<boolean> {
  const response = await cin7Request<Cin7CategoryListResponse>(creds, CATEGORY_PATH, {
    query: { Page: 1, Limit: 100, Name: name },
  });
  return (response.CategoryList ?? []).some((c) => c.Name === name);
}

async function createCategory(creds: Cin7Credentials, name: string): Promise<void> {
  await cin7Request(creds, CATEGORY_PATH, { method: "POST", body: { Name: name } });
}

/**
 * Ensures a Category name exists in this Cin7 instance, creating it if
 * missing — mutates `cache` in place so a name checked once doesn't need a
 * second call for the rest of this sync run. Safe to auto-create: a
 * Category record has no fields beyond Name (max 50 chars — a longer
 * category name will fail creation even though the Product payload's own
 * Category field allows up to 256).
 */
export async function ensureCategoryExists(creds: Cin7Credentials, name: string, cache: Set<string>): Promise<void> {
  if (cache.has(name)) return;
  if (await categoryExists(creds, name)) {
    cache.add(name);
    return;
  }
  await createCategory(creds, name);
  cache.add(name);
}
