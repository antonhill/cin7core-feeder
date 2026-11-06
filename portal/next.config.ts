import path from "node:path";
import type { NextConfig } from "next";

// The PUBLIC customer portal. Shares source with the internal Toolbox (the '@/' alias points at ../src) but ships only the routes under portal/app.
const repoRoot = path.join(__dirname, "..");

// Everything the page needs is same-origin: no third-party script, style, font, frame or connection, and the browser never talks to Supabase (all data goes through server actions).
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: CSP },
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Cache-Control", value: "no-store, max-age=0" },
        { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
      ],
    }];
  },
  // Responses are small JSON forms; nothing here accepts uploads.
  experimental: { serverActions: { bodySizeLimit: "100kb" } },
};

export default nextConfig;
