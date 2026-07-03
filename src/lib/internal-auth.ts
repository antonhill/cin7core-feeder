/**
 * Interim guard for internal API routes (import, sync) before real
 * Supabase-Auth-backed user sessions are wired into the Settings/Import UI.
 * Requires `Authorization: Bearer <SYNC_SHARED_SECRET>`.
 */
export function assertInternalAuth(req: Request) {
  const expected = process.env.SYNC_SHARED_SECRET;
  if (!expected) throw new Error("SYNC_SHARED_SECRET is not configured");
  const header = req.headers.get("authorization") ?? "";
  const provided = header.replace(/^Bearer\s+/i, "");
  if (provided !== expected) {
    throw new UnauthorizedError();
  }
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}
