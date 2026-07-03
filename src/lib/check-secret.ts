/**
 * Shared passphrase check used by every Server Action gating a mutation or
 * export — a stand-in for real per-user Supabase Auth, kept deliberately
 * simple for now.
 */
export function checkSecret(secret: unknown): string | null {
  const expected = process.env.SYNC_SHARED_SECRET;
  if (!expected) return "SYNC_SHARED_SECRET is not configured on the server.";
  if (secret !== expected) return "Incorrect passphrase.";
  return null;
}
