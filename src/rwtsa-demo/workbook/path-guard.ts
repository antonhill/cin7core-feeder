import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { RwtsaSafeError } from "@/rwtsa-demo/findings";

/** Largest workbook the adapter will open. The demonstration slice is a few hundred KB; this is a resource guard, not a size target. */
export const MAX_WORKBOOK_BYTES = 25 * 1024 * 1024;

/**
 * The protected advisor workbook must live OUTSIDE the repository (owner direction). This refuses any file
 * that sits inside ANY git working tree: it walks up from the file's real path and rejects if it meets a
 * `.git` entry (a directory in a normal checkout, a file in a linked worktree). That also covers the main
 * checkout and every sibling worktree, not just the one this code runs from.
 *
 * Returns the resolved real path. Messages never include the path itself, because a path can be identifying.
 */
export function assertWorkbookPathAllowed(file: string): string {
  let real: string;
  try {
    real = realpathSync(path.resolve(file));
  } catch {
    throw new RwtsaSafeError("not_a_workbook", "The workbook path does not exist or cannot be read.");
  }
  const stat = statSync(real);
  if (!stat.isFile()) throw new RwtsaSafeError("not_a_workbook", "The workbook path is not a regular file.");
  if (stat.size > MAX_WORKBOOK_BYTES) {
    throw new RwtsaSafeError("file_too_large", `The workbook exceeds the ${MAX_WORKBOOK_BYTES / (1024 * 1024)} MB limit.`);
  }

  let dir = path.dirname(real);
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) {
      throw new RwtsaSafeError(
        "path_inside_repository",
        "Refusing to read a workbook that is inside a git working tree. Keep the protected workbook outside every repository."
      );
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return real;
}

/**
 * Output (certificate / reconciliation / state) directory must ALSO be outside every git working tree, so a
 * validation artefact derived from the protected workbook can never be written into a repository by accident.
 * Creates the directory if needed and returns its real path.
 */
export function assertOutputDirAllowed(dir: string): string {
  const resolved = path.resolve(dir);
  let probe = resolved;
  // Check the nearest existing ancestor first, so we refuse BEFORE creating anything inside a repository.
  while (!existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let cur = realpathSync(probe);
  for (;;) {
    if (existsSync(path.join(cur, ".git"))) {
      throw new RwtsaSafeError("path_inside_repository", "Refusing to write output inside a git working tree. Use a directory outside every repository.");
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  mkdirSync(resolved, { recursive: true });
  return realpathSync(resolved);
}
