import "server-only";
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { DEMO_TTL_SECONDS, isDemoSlot, type DemoSlot } from "./config";

// A server-issued, short-lived, signed Demo Mode context. The browser holds only an opaque cookie it cannot forge or extend: the claims are bound to the
// authenticated owner's user id and organisation, the key is derived from the server's ENCRYPTION_KEY (never sent anywhere), and there is NO client-supplied
// identity in it - only a slot name that the server maps to a fixed allowlisted account.

export interface DemoClaims { v: 1; owner: string; org: string; slot: Exclude<DemoSlot, "owner">; iat: number; exp: number; n: string }

function key(): Buffer {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) throw new Error("Demo Mode cannot be used: the server signing secret is not configured.");
  return Buffer.from(hkdfSync("sha256", secret, "newquip-demo-mode", "context-v1", 32));
}
const b64 = (b: Buffer) => b.toString("base64url");

export function signDemoClaims(c: { owner: string; org: string; slot: Exclude<DemoSlot, "owner"> }, nowMs = Date.now()): { token: string; claims: DemoClaims } {
  const claims: DemoClaims = { v: 1, owner: c.owner, org: c.org, slot: c.slot, iat: Math.floor(nowMs / 1000), exp: Math.floor(nowMs / 1000) + DEMO_TTL_SECONDS, n: b64(randomBytes(9)) };
  const body = b64(Buffer.from(JSON.stringify(claims)));
  return { token: `${body}.${b64(createHmac("sha256", key()).update(body).digest())}`, claims };
}

/** Returns the claims only for an unaltered, unexpired token; anything else is null. Never throws on garbage input. */
export function verifyDemoToken(token: string | undefined | null, nowMs = Date.now()): DemoClaims | null {
  if (!token || token.length > 2048) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  let expected: Buffer;
  try { expected = createHmac("sha256", key()).update(body).digest(); } catch { return null; }
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let c: Partial<DemoClaims>;
  try { c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (c.v !== 1 || typeof c.owner !== "string" || typeof c.org !== "string" || !isDemoSlot(c.slot) || (c.slot as string) === "owner" || typeof c.iat !== "number" || typeof c.exp !== "number" || typeof c.n !== "string") return null;
  if (Math.floor(nowMs / 1000) >= c.exp || c.iat > Math.floor(nowMs / 1000) + 60) return null;
  return c as DemoClaims;
}
