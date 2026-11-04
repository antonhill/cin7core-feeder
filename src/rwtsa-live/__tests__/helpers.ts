import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const ACCOUNT = "acc-11111111-SECRET";
export const APPKEY = "key-22222222-SECRET";
export const G = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const LOC = { JHB: G(1), DURBAN: G(2), CAPE_TOWN: G(3), FACTORY_STORE: G(4), BOND: G(5) };

/** A throwaway HOME containing ~/rwtsa-local/credentials with correct permissions. */
export function makeHome(opts: { env?: string; locations?: unknown; envMode?: number; dirMode?: number } = {}): { home: string; dir: string } {
  const home = mkdtempSync(path.join(tmpdir(), "rwtsa-home-"));
  const dir = path.join(home, "rwtsa-local", "credentials");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, opts.dirMode ?? 0o700);
  const env = opts.env ?? `RWTSA_CIN7_ACCOUNT_ID=${ACCOUNT}\nRWTSA_CIN7_APPLICATION_KEY=${APPKEY}\nRWTSA_CIN7_INSTANCE_LABEL=rwtsa-demo-instance\n`;
  writeFileSync(path.join(dir, "cin7.env"), env, { mode: opts.envMode ?? 0o600 });
  chmodSync(path.join(dir, "cin7.env"), opts.envMode ?? 0o600);
  writeFileSync(path.join(dir, "locations.json"), JSON.stringify(opts.locations ?? LOC), { mode: 0o600 });
  return { home, dir };
}

export interface Call { method: string; url: string; headers: Record<string, string>; redirect?: string }
/** A fake fetch serving scripted JSON by path+Page. Records every call. */
export function fakeFetch(routes: Record<string, (page: number, call: Call) => { status?: number; body?: unknown; throws?: boolean }>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const call: Call = { method: String(init?.method), url: u.toString(), headers: (init?.headers ?? {}) as Record<string, string>, redirect: init?.redirect };
    calls.push(call);
    const key = u.pathname.replace("/ExternalApi/v2", "");
    const route = routes[key];
    if (!route) return new Response("{}", { status: 404 });
    const r = route(Number(u.searchParams.get("Page") ?? 1), call);
    if (r.throws) throw new TypeError("network down");
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}
export const noSleep = async () => {};

export const FP_LOCS = [{ ID: LOC.JHB, Name: "JHB" }, { ID: LOC.DURBAN, Name: "Durban" }, { ID: LOC.CAPE_TOWN, Name: "Cape Town" }, { ID: LOC.FACTORY_STORE, Name: "Factory Store" }, { ID: LOC.BOND, Name: "Bond" }];
