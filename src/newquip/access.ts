// Who can see the NewQuip Grower POC. Deliberately client-safe (no server-only imports) so the
// guard in require-newquip-poc-org.ts and any client check share ONE list.
//
// This follows the existing single-client precedent (src/lib/casa-das-natas.ts): an immutable org id,
// not a hostname/email/name. Chosen over a new MODULES entry because a module toggle is ON by default
// for every org and would need a migration (disabled_modules seed) to hide — and migrations are out of
// scope for this interim build. If this POC is productised, replace with a per-org flag.
//
// Looked up read-only on 2026-10-13: two organisations are named "NewQuip POC"; only this one has a
// connected Cin7 instance (also named "NewQuip POC"). The other (1a1a7fd8-…) has none and is NOT listed.
export const NEWQUIP_POC_ORG_IDS: readonly string[] = ["e1aea782-d095-47ad-90fb-4fa65c9bf855"];

export function isNewquipPocOrg(orgId: string): boolean {
  return NEWQUIP_POC_ORG_IDS.includes(orgId);
}

/**
 * The ONE Cin7 instance ("NewQuip POC") the acceptance proofs may use. P0 refuses to run against any other instance, and never picks one for
 * you: if the org has zero, several, or a different active instance, P0 fails with the facts.
 */
export const NEWQUIP_POC_CIN7_INSTANCE_ID = "30eac8f2-d55c-486c-be70-a5f2d778a761";

/** Customers that must never be used by a proof (operational customers). Matched case-insensitively as a substring of the name. */
export const OPERATIONAL_CUSTOMER_DENYLIST: readonly string[] = ["AGRICO", "AFGRI", "AMANZIMNENGI"];
