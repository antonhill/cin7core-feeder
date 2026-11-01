import type { NextConfig } from "next";
import path from "node:path";
import { distDirFor } from "./lib/dist-dir";

/**
 * Standalone, local-only RWTSA demonstration shell. It lives beside the Toolbox app but is NOT part of it: its own
 * config, no middleware, no Supabase, no Cin7, not deployed.
 *
 * - turbopack.root is the repository root so the shell can import the audited `src/rwtsa-demo/**` code and the
 *   approved presentational Toolbox components (Turbopack does not resolve files outside its root).
 * - build output is kept out of the source tree (see distDir below).
 * - exceljs is loaded by Node at runtime, not bundled (it is a Node-only library).
 * - no fonts, analytics, images or remote resources are configured anywhere in this app.
 */
const nextConfig: NextConfig = {
  // Build/dev output goes under node_modules/.cache (already ignored by git, ESLint and tsc) so running this shell never
  // pollutes the Toolbox app's own `.next`, root lint or root type-check, and nothing workbook-derived is left in the tree.
  distDir: distDirFor(process.env.RWTSA_DIST_SUFFIX),
  turbopack: { root: path.join(__dirname, "..") },
  serverExternalPackages: ["exceljs"],
  poweredByHeader: false,
};

export default nextConfig;
