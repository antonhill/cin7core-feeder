import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

/**
 * Confirmed 2026-07-03 via github.com/nnhansg/dear-openapi's Apiary
 * transcription (specification/dearinventory.apib, ~lines 12315-13231),
 * corroborated by github.com/FalconEyeSolutions/CIN7-DearInventory's
 * generated C# client. Work Centres are safe to auto-create — minimal
 * required fields are Code, Name, IsActive, IsCoMan, IsCoManPurchase
 * (co-manufacturing fields only matter when true, which doesn't apply to a
 * normal in-house work centre). Unlike Resources (see resources.ts),
 * creation has no hidden constraint.
 */
const WORK_CENTRES_PATH = "/production/workcenters";

interface Cin7WorkCentre {
  WorkCenterID?: string;
  Code?: string;
  Name?: string;
}

interface Cin7WorkCentresResponse {
  Workcenters?: Cin7WorkCentre[];
  WorkCenters?: Cin7WorkCentre[];
}

function extractList(response: Cin7WorkCentresResponse): Cin7WorkCentre[] {
  return response.Workcenters ?? response.WorkCenters ?? [];
}

async function findWorkCentreByCode(creds: Cin7Credentials, code: string): Promise<{ id: string } | null> {
  // Confirmed live: GET without Page/Limit returns Cin7's branded "Page not
  // found" SPA shell (HTTP 200, not a real 404) instead of erroring — the
  // generated C# client always sends all three params, never just Name.
  const response = await cin7Request<Cin7WorkCentresResponse>(creds, WORK_CENTRES_PATH, {
    query: { Page: 1, Limit: 100, Name: code },
  });
  const match = extractList(response).find((w) => w.Code === code || w.Name === code);
  return match?.WorkCenterID ? { id: match.WorkCenterID } : null;
}

async function createWorkCentre(creds: Cin7Credentials, code: string): Promise<{ id: string }> {
  const response = await cin7Request<Cin7WorkCentresResponse>(creds, WORK_CENTRES_PATH, {
    method: "POST",
    body: {
      Workcenters: [
        { Code: code, Name: code, IsActive: true, IsCoMan: false, IsCoManPurchase: false, WorkCenterLocations: [] },
      ],
    },
  });
  const created = extractList(response)[0];
  if (!created?.WorkCenterID) {
    throw new Error(`Create Work Centre response had no WorkCenterID — raw response: ${JSON.stringify(response).slice(0, 500)}`);
  }
  return { id: created.WorkCenterID };
}

/**
 * Resolves a work centre code to its Cin7 ID, creating it if it doesn't
 * exist yet — mutates `cache` in place so a code looked up for one
 * operation doesn't need a second call for the next. Unlike
 * resolveResourceId, this never throws: Work Centre creation is safe.
 */
export async function resolveWorkCentreId(
  creds: Cin7Credentials,
  code: string,
  cache: Map<string, string | null | undefined>
): Promise<string> {
  const cached = cache.get(code);
  if (cached) return cached;

  const found = await findWorkCentreByCode(creds, code);
  if (found) {
    cache.set(code, found.id);
    return found.id;
  }

  const created = await createWorkCentre(creds, code);
  cache.set(code, created.id);
  return created.id;
}
