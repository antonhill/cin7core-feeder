/** Case-insensitive substring match against any of the given fields — null/undefined fields are treated as empty. An empty query matches everything. */
export function matchesSearch(query: string, ...values: (string | null | undefined)[]): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return values.some((v) => (v ?? "").toLowerCase().includes(needle));
}
