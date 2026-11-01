/**
 * Build output directory for the standalone shell. The default is the shell's own directory; the automated build test
 * passes a unique suffix so it owns its output and never touches the directory a developer's running server uses.
 * Letters, digits, "_" and "-" only: the suffix can never contain a path separator or "..", so output stays under
 * node_modules/.cache.
 */
export function distDirFor(suffix: string | undefined): string {
  if (suffix !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(suffix)) throw new Error("RWTSA_DIST_SUFFIX must be 1-64 letters, digits, '_' or '-'");
  return `../node_modules/.cache/rwtsa-demo-next${suffix ? `-${suffix}` : ""}`;
}
