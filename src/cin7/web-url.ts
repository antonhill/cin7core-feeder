/**
 * Deliberately its own file with zero other imports — `cin7SaleUrl` is pure
 * string formatting, but `src/cin7/sales.ts`/`http.ts` transitively import
 * `"server-only"`, which throws if bundled into client code. This file is
 * imported as a real runtime value (not just a type) by both a client
 * component (Invoicing Scheduler) and server code (P4's notification
 * pipeline), so it needs to stay safely import-able from either side.
 */

/**
 * Cin7's own web app — one shared domain regardless of instance/region
 * (confirmed live 2026-08-04, Invoicing Scheduler: a real Cin7 sale URL is
 * `https://inventory.dearsystems.com/SaleMultiple#{id}~{id}~tabOrder`), not
 * a per-instance subdomain. `origin` still comes from each instance's own
 * stored base_url rather than being hardcoded, in case a different Cin7
 * region ever uses a different host.
 */
export function cin7SaleUrl(origin: string, cin7SaleId: string): string {
  return `${origin}/SaleMultiple#${cin7SaleId}~${cin7SaleId}~tabOrder`;
}
