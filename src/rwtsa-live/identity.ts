import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { assertPrivateFile } from "./credentials";
import { RwtsaLiveError } from "./types";

/**
 * Account identity is NOT the instance label. It is established from two independent facts:
 *  1. the configured account ID, compared as a SHA-256 against the owner-approved value (the ID itself is never copied into a second file);
 *  2. a fingerprint of the SET of location IDs the account returns (location IDs are GUIDs unique to a Cin7 account), compared with the
 *     fingerprint the OWNER approved. There is no trust-on-first-use: with no approved fingerprint the run stops and reports the one to approve.
 */
export interface IdentityApproval { accountIdSha256: string; approvedFingerprint?: string }
export type IdentityStatus = "VERIFIED" | "ACCOUNT_MISMATCH" | "FINGERPRINT_MISMATCH" | "NOT_APPROVED";
export interface IdentityResult { status: IdentityStatus; fingerprint: string; locationCount: number; accountIdSha256: string }

const HEX64 = /^[0-9a-f]{64}$/;
const fail = (m: string): never => { throw new RwtsaLiveError("CREDENTIALS", m); };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function computeFingerprint(locationIds: readonly string[]): string {
  const set = [...new Set(locationIds.map((i) => i.toLowerCase()))].sort();
  return sha(`rwtsa-location-set-v1|${set.length}|${set.join(",")}`);
}

/** ~/rwtsa-local/credentials/identity.json: { "accountIdSha256": "<64 hex>", "approvedFingerprint": "<64 hex>" (added by the owner after review) } */
export function loadIdentityApproval(dir: string): IdentityApproval {
  const file = path.join(dir, "identity.json");
  if (!existsSync(file)) fail("identity.json is missing in ~/rwtsa-local/credentials: create it with the SHA-256 of the RWTSA account ID (see the module README). Nothing was read from Cin7.");
  assertPrivateFile(file);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { return fail("identity.json is not valid JSON."); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("identity.json must be an object.");
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== "accountIdSha256" && k !== "approvedFingerprint") fail("identity.json has a key that is not allowed.");
  if (typeof o.accountIdSha256 !== "string" || !HEX64.test(o.accountIdSha256)) fail("identity.json: accountIdSha256 must be 64 lowercase hex characters.");
  if (o.approvedFingerprint !== undefined && (typeof o.approvedFingerprint !== "string" || !HEX64.test(o.approvedFingerprint))) fail("identity.json: approvedFingerprint must be 64 lowercase hex characters.");
  return { accountIdSha256: o.accountIdSha256 as string, approvedFingerprint: o.approvedFingerprint as string | undefined };
}

export function verifyIdentity(i: { accountId: string; approval: IdentityApproval; locationIds: readonly string[] }): IdentityResult {
  const fingerprint = computeFingerprint(i.locationIds);
  const accountIdSha256 = sha(i.accountId);
  const base = { fingerprint, locationCount: new Set(i.locationIds.map((x) => x.toLowerCase())).size, accountIdSha256 };
  if (accountIdSha256 !== i.approval.accountIdSha256) return { status: "ACCOUNT_MISMATCH", ...base };
  if (base.locationCount === 0) return { status: "NOT_APPROVED", ...base };
  if (!i.approval.approvedFingerprint) return { status: "NOT_APPROVED", ...base };
  return { status: fingerprint === i.approval.approvedFingerprint ? "VERIFIED" : "FINGERPRINT_MISMATCH", ...base };
}
