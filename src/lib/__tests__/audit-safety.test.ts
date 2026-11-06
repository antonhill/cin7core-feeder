import { describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REDACTED, redactSecrets } from "../audit-safety";
import { logActivity } from "../activity-log";

const ENV = { SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2lnbmF0dXJlLXNlbnRpbmVs", CRON_SECRET: "cron-secret-0123456789", SHORT_KEY: "abc", NEXT_PUBLIC_X: "public-value-xyz" };

describe("redactSecrets (defence in depth for audit details)", () => {
  it("removes a secret value wherever it appears, including inside longer strings and nested objects/arrays", () => {
    const out = JSON.stringify(redactSecrets({ a: "x", nested: { list: [`prefix ${ENV.CRON_SECRET} suffix`, "ok"] }, jwt: ENV.SUPABASE_SERVICE_ROLE_KEY }, ENV));
    expect(out).not.toContain(ENV.CRON_SECRET); expect(out).not.toContain(ENV.SUPABASE_SERVICE_ROLE_KEY); expect(out).not.toContain("eyJ");
    expect(out).toContain("ok"); expect(out).toContain(REDACTED);
  });
  it("replaces an environment-shaped object wholesale (the incident's shape), even when no value is recognised as secret", () => {
    const env = { NODE_ENV: "production", VERCEL_ENV: "preview", SOME_FLAG: "1", ANOTHER_ONE: "2", FIFTH_ONE: "3" };
    expect(redactSecrets({ environment: env }, {}).environment).toBe(`${REDACTED} (environment-like object)`);
  });
  it("redacts values under credential-named keys, but keeps legitimate evidence such as idempotency keys and validation labels", () => {
    const out = redactSecrets({ apiKey: "abcdefghijkl", password: "hunter2hunter2", idempotencyKey: "key-send-portal-1", tokenValidation: "VALID", documentHash: "a".repeat(64) }, {});
    expect(out.apiKey).toBe(REDACTED); expect(out.password).toBe(REDACTED);
    expect(out.idempotencyKey).toBe("key-send-portal-1"); expect(out.tokenValidation).toBe("VALID"); expect(out.documentHash).toBe("a".repeat(64));
  });
  it("leaves ordinary details untouched and does not mutate its input", () => {
    const d = { quoteId: "q-1", count: 3, ok: true, none: null, when: "2026-10-31T07:02:18Z" }; const before = JSON.stringify(d);
    expect(redactSecrets(d, ENV)).toEqual(d); expect(JSON.stringify(d)).toBe(before);
  });
  it("logActivity applies the guard to every audit record it writes", async () => {
    const inserted: Array<Record<string, unknown>> = []; vi.stubEnv("CRON_SECRET", "stubbed-cron-secret-9876543210");
    const db = { from: () => ({ insert: async (row: Record<string, unknown>) => { inserted.push(row); return { error: null }; } }) };
    await logActivity(db as never, { orgId: "o", actor: "system", action: "t", summary: "s", detail: { leaked: "value stubbed-cron-secret-9876543210" } });
    expect(JSON.stringify(inserted)).not.toContain("stubbed-cron-secret-9876543210"); vi.unstubAllEnvs();
  });
});

describe("static guard: no source file persists the process environment into an audit/activity detail", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? (f === "node_modules" || f === ".next" || f === "__tests__" ? [] : walk(p)) : /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) ? [p] : []; });
  it("no `detail:` value references process.env or ctx.env directly", () => {
    const offenders = [...walk("src"), ...walk("portal")].filter((f) => /detail:[^\n]*\b(process\.env|ctx\.env)\b/.test(readFileSync(f, "utf8").replace(/environmentOf\([^)]*\)/g, "environmentOf()")));   // environmentOf(env) yields a label, not the environment
    expect(offenders).toEqual([]);
  });
});
