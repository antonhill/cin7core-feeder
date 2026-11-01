/**
 * Intentionally a no-op. It exists to SHADOW the Toolbox's production middleware.
 *
 * `next.config.ts` sets `turbopack.root` to the repository root (so this app can import the audited `src/rwtsa-demo/**`
 * code). Turbopack then looks for the middleware/proxy file in this app's directory AND in its parents up to that root,
 * and would find and bundle `src/middleware.ts`: the Toolbox's Supabase session and auth gate. Every request would then
 * fail without Supabase credentials (HTTP 500 in production mode). A proxy file in this app's own directory takes
 * precedence, so the Toolbox middleware is never loaded here.
 *
 * This shell has no authentication, no Supabase and no sessions by design. The matcher matches no route, so this
 * function never runs. `__tests__/standalone-build.test.ts` fails if the Toolbox middleware ever reappears in the bundle.
 */
export function proxy(): void {}

export const config = { matcher: ["/__rwtsa_no_such_route__"] };
