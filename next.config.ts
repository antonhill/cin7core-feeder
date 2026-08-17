import type { NextConfig } from "next";

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
const SUPABASE_ORIGIN = "https://pnzwjqjovxxdikxtfngq.supabase.co";

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: ${SUPABASE_ORIGIN}`,
  "font-src 'self' data:",
  `connect-src 'self' ${SUPABASE_ORIGIN}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' https://*.lemonsqueezy.com",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
