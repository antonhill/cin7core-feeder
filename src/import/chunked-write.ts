/**
 * Splits a bulk upsert/insert into fixed-size chunks instead of one call
 * covering the whole array — a large enough source dataset (e.g. a live
 * Migrate pull) can make a single call exceed Postgres's statement timeout.
 * Confirmed live 2026-07-21, first on import_rows, then on products itself —
 * the same class of bug lurks in every other commit-*.ts bulk write, so this
 * is applied uniformly rather than fixed one table at a time as each is hit.
 * Stops and returns the first error encountered, matching the `{ error }`
 * shape every call site already destructures.
 */
export async function chunkedWrite<T>(
  rows: T[],
  write: (chunk: T[]) => PromiseLike<{ error: { message: string } | null }>,
  chunkSize = 500
): Promise<{ error: { message: string } | null }> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const { error } = await write(rows.slice(i, i + chunkSize));
    if (error) return { error };
  }
  return { error: null };
}
