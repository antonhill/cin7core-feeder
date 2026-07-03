import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

/**
 * Confirmed 2026-07-03 via github.com/nnhansg/dear-openapi's Apiary
 * transcription (specification/dearinventory.apib), corroborated by
 * github.com/FalconEyeSolutions/CIN7-DearInventory's generated C# client.
 *
 * UNLIKE Work Centres, Resources are NOT auto-created here. Creation
 * requires a ResourceType (Labor/Machine/Other) and a CycleDuration (int,
 * seconds) — neither of which our schema models — and critically, a
 * Labor-type resource's Name must be the email of a registered Cin7 Core
 * user, which can't be inferred from a code like "LAB1". Guessing wrong
 * would create a broken or semantically-incorrect resource in the
 * customer's Cin7 account. So: look up only, and fail with a clear,
 * actionable message if not found — the user creates it once in Cin7's UI
 * (Manufacturing > Resources), and every subsequent sync resolves it fine.
 */
const RESOURCE_LIST_PATH = "/production/resourceList";

interface Cin7Resource {
  ResourceID?: string;
  Code?: string;
  Name?: string;
}

interface Cin7ResourceListResponse {
  Resources?: Cin7Resource[];
}

async function findResourceByCode(creds: Cin7Credentials, code: string): Promise<{ id: string } | null> {
  const response = await cin7Request<Cin7ResourceListResponse>(creds, RESOURCE_LIST_PATH, {
    query: { Name: code },
  });
  const match = (response.Resources ?? []).find((r) => r.Code === code || r.Name === code);
  return match?.ResourceID ? { id: match.ResourceID } : null;
}

/**
 * Resolves a resource code to its Cin7 ID — mutates `cache` in place, same
 * pattern as resolveWorkCentreId. Throws (does not auto-create) if the
 * resource doesn't exist in Cin7 yet.
 */
export async function resolveResourceId(
  creds: Cin7Credentials,
  code: string,
  cache: Map<string, string | null | undefined>
): Promise<string> {
  const cached = cache.get(code);
  if (cached) return cached;

  const found = await findResourceByCode(creds, code);
  if (!found) {
    throw new Error(
      `Resource "${code}" not found in Cin7 — create it manually first (Manufacturing > Resources). ` +
        `Resources need a type (Labor/Machine/Other) and a cycle duration, and Labor-type resources must be ` +
        `named as a valid Cin7 user email, which can't be safely inferred or auto-created.`
    );
  }

  cache.set(code, found.id);
  return found.id;
}
