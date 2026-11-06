import type { NextConfig } from "next";
import { buildContentSecurityPolicy } from "./src/lib/csp";

// Security re-audit P1-9: this app has no legitimate need to be
// framed/embedded (confirmed: no <iframe> usage anywhere in src/app) and
// loads no third-party scripts/styles/fonts (confirmed: no <script>/<link>
// tags to an external origin; fonts are self-hosted at build time via
// next/font/google). The only external origin the browser genuinely talks
// to is this app's own Supabase project (API calls + the org-logos storage
// bucket for <img> sources) — everything else can be locked to 'self'.
//
// script-src keeps 'unsafe-inline': Next.js's App Router streams RSC
// payloads to the client via inline <script>self.__next_f.push(...)</script>
// tags injected into the initial HTML — removing 'unsafe-inline' without a
// per-request nonce wired through middleware breaks hydration entirely.
// A nonce-based strict CSP is a further-hardening step, deliberately not
// attempted here without its own dedicated, separately-verified change (see
// PROJECT-NOTES.md's P1-9 entry).
// The Supabase origin is derived from NEXT_PUBLIC_SUPABASE_URL (see src/lib/csp.ts), not hard-coded:
// production keeps allowing the production project, and any other environment (e.g. a branch-specific
// Preview pointing at an isolated test project) allows exactly its own origin.
const CSP = buildContentSecurityPolicy(process.env.NEXT_PUBLIC_SUPABASE_URL);

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

const nextConfig: NextConfig = {
  // Identifies the build in the UI (see BuildStamp) so a user can tell which deployment/commit they are actually on. Vercel sets these at build time.
  env: {
    NEXT_PUBLIC_BUILD_SHA: (process.env.VERCEL_GIT_COMMIT_SHA ?? "local").slice(0, 7),
    NEXT_PUBLIC_BUILD_REF: process.env.VERCEL_GIT_COMMIT_REF ?? "",
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  // Security re-audit P1-7: Next's own Server Action default is 1MB —
  // raised to genuinely fit the largest legitimate CSV import (Products has
  // the widest template, ~118 columns) rather than relying on that opaque
  // framework default alone. The app's own explicit checkUploadSize()
  // (src/lib/csv-upload-limits.ts) still enforces the real limit and
  // returns a clear message; this only raises the framework's outer ceiling
  // so a legitimate large-but-valid file doesn't fail with a generic
  // "Body exceeded 1mb limit" error before the app's own check ever runs.
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
