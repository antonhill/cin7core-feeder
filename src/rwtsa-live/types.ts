/** The five RWTSA stock roles. Identity comes from the owner-verified Cin7 location ID, never from a display name. */
export const ROLES = ["JHB", "DURBAN", "CAPE_TOWN", "FACTORY_STORE", "BOND"] as const;
export type Role = (typeof ROLES)[number];
export type LocationMap = Partial<Record<Role, string>> & { BOND: string };
export const UNRESTRICTED_ROLES: readonly Role[] = ["JHB", "DURBAN", "CAPE_TOWN", "FACTORY_STORE"];

export interface RwtsaCredentials { readonly accountId: string; readonly applicationKey: string; readonly instanceLabel: string }

export type RwtsaLiveErrorCode = "POLICY" | "AUTH_REJECTED" | "RATE_LIMITED" | "NETWORK" | "REDIRECT_REFUSED" | "BAD_RESPONSE" | "SERVER_ERROR" | "NOT_FOUND" | "REQUEST_REJECTED" | "CREDENTIALS" | "STORE";
/** Carries a code and an allowlisted path only: never a credential, a query value or a response body. */
export class RwtsaLiveError extends Error {
  constructor(public readonly code: RwtsaLiveErrorCode, message: string, public readonly status?: number) { super(message); this.name = "RwtsaLiveError"; }
}
