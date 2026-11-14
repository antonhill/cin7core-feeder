import { buildCin7Url } from "@/cin7/api-origin";
import { RwtsaLiveError } from "./types";

/**
 * The ONLY Cin7 resources this module may read, all by GET. Phase 3 adds the production read paths HERE (one reviewed line each);
 * nothing else in the module needs to change, so the isolation boundary stays put.
 */
export const ALLOWED_GET_PATHS = ["/ref/location", "/ref/productavailability", "/product"] as const;

/** Throws unless this is a GET on an allowlisted path; returns the URL rooted at the one fixed Cin7 origin. */
export function assertReadOnlyRequest(method: string, path: string): URL {
  if (method !== "GET") throw new RwtsaLiveError("POLICY", "RWTSA live access is read-only: only GET is permitted.");
  if (!(ALLOWED_GET_PATHS as readonly string[]).includes(path)) throw new RwtsaLiveError("POLICY", "RWTSA live access: this Cin7 path is not on the read allowlist.");
  return buildCin7Url(path);
}
