import { guardRequest } from "@/rwtsa-demo/state/host-guard";

/**
 * Host and Origin gate for the standalone RWTSA demonstration app (fail closed).
 *
 * It also SHADOWS the Toolbox's production middleware. `next.config.ts` sets `turbopack.root` to the repository root (so this
 * app can import the audited `src/rwtsa-demo/**` code), and Turbopack looks for the middleware/proxy file in this app's
 * directory AND its parents up to that root. Without a proxy file here it would bundle `src/middleware.ts`, the Toolbox's
 * Supabase session and auth gate, and every request would fail. This file takes precedence, so the Toolbox middleware is never
 * loaded. `__tests__/standalone-build.test.ts` fails if it ever reappears in the bundle.
 *
 * Every request (pages, API routes, static files) must carry a loopback Host; state-changing requests must also carry a
 * matching same-origin Origin (or Sec-Fetch-Site: same-origin). Rejections are a bare 403: no redirect, no echo of the header.
 */
export function proxy(request: Request): Response | undefined {
  const verdict = guardRequest(request.method, request.headers);
  if (verdict.ok) return undefined;
  return new Response("Forbidden: this demonstration only answers requests addressed to a loopback host.", {
    status: 403,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export const config = { matcher: ["/:path*"] };
