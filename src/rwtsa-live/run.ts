import type { ReadOnlyClient } from "./client";
import { collectAvailability, collectLocations, collectProducts } from "./collect";
import { verifyIdentity, type IdentityApproval, type IdentityResult } from "./identity";
import { buildSnapshot, type Snapshot } from "./snapshot";
import type { LocationMap, RwtsaCredentials } from "./types";

export interface IdentityFailureEvidence { takenAt: string; identity: IdentityResult; locationsComplete: boolean; locationProblems: string[]; requests: number; methodsUsed: string[]; stockRead: false }
export type RunResult = { kind: "SNAPSHOT"; snapshot: Snapshot } | { kind: "IDENTITY_FAILED"; evidence: IdentityFailureEvidence };

/**
 * Establishes WHICH account this is from a single bounded GET of the location list, and only then reads stock.
 * Anything short of VERIFIED (or an incomplete location list) stops here: no stock or product endpoint is called.
 */
export async function runSnapshot(i: { client: ReadOnlyClient; creds: RwtsaCredentials; locationMap: LocationMap; approval: IdentityApproval; takenAt: string }): Promise<RunResult> {
  const locations = await collectLocations(i.client);
  const identity = verifyIdentity({ accountId: i.creds.accountId, approval: i.approval, locationIds: locations.rows.map((r) => String(r.ID ?? "")).filter(Boolean) });
  if (identity.status !== "VERIFIED" || !locations.complete) {
    return { kind: "IDENTITY_FAILED", evidence: { takenAt: i.takenAt, identity, locationsComplete: locations.complete, locationProblems: locations.problems, requests: i.client.requests(), methodsUsed: i.client.methodsUsed(), stockRead: false } };
  }
  const availability = await collectAvailability(i.client);
  const products = await collectProducts(i.client);
  return { kind: "SNAPSHOT", snapshot: buildSnapshot({ creds: i.creds, locationMap: i.locationMap, locations, availability, products, takenAt: i.takenAt, identity, clientStats: { methodsUsed: i.client.methodsUsed(), requests: i.client.requests() } }) };
}
