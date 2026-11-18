import "server-only";
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { ACTIVE_ROLE_TTL_SECONDS, isSwitchRole, type SwitchRole } from "./active-role";

// A server-issued, signed record of WHICH of their own roles a person chose to act as. It is bound to the authenticated user and organisation, expires, and is
// verified (never trusted) on every request; the roles it can name are re-checked against the person's current explicit assignments. It can only narrow.

export interface ActiveRoleClaims { v: 1; user: string; org: string; role: SwitchRole; iat: number; exp: number; n: string }

function key(): Buffer {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret) throw new Error("The role switch cannot be used: the server signing secret is not configured.");
  return Buffer.from(hkdfSync("sha256", secret, "newquip-active-role", "context-v1", 32));
}
const b64 = (b: Buffer) => b.toString("base64url");

export function signActiveRole(c: { user: string; org: string; role: SwitchRole }, nowMs = Date.now()): string {
  const claims: ActiveRoleClaims = { v: 1, user: c.user, org: c.org, role: c.role, iat: Math.floor(nowMs / 1000), exp: Math.floor(nowMs / 1000) + ACTIVE_ROLE_TTL_SECONDS, n: b64(randomBytes(9)) };
  const body = b64(Buffer.from(JSON.stringify(claims)));
  return `${body}.${b64(createHmac("sha256", key()).update(body).digest())}`;
}

/** Claims only for an unaltered, unexpired token; anything else is null. Never throws on garbage input. */
export function verifyActiveRole(token: string | undefined | null, nowMs = Date.now()): ActiveRoleClaims | null {
  if (!token || token.length > 1024) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  let expected: Buffer;
  try { expected = createHmac("sha256", key()).update(body).digest(); } catch { return null; }
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let c: Partial<ActiveRoleClaims>;
  try { c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (c.v !== 1 || typeof c.user !== "string" || typeof c.org !== "string" || !isSwitchRole(c.role) || typeof c.iat !== "number" || typeof c.exp !== "number" || typeof c.n !== "string") return null;
  const now = Math.floor(nowMs / 1000);
  if (now >= c.exp || c.iat > now + 60) return null;
  return c as ActiveRoleClaims;
}
