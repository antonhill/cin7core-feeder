import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Static guard for the NewQuip privilege pattern (migrations 0112 / 0113 / 0116): every table 0115 creates must be stripped of anon / authenticated / PUBLIC privileges
// (TRUNCATE ignores RLS and row triggers) and re-granted SELECT only to authenticated. The real-Postgres proof is supabase/tests/0116_*.test.sql.
const root = join(__dirname, "..", "..", "..", "supabase", "migrations");
const m0115 = readFileSync(join(root, "0115_newquip_customer_quotation_delivery.sql"), "utf8");
const m0116 = readFileSync(join(root, "0116_newquip_delivery_privilege_hardening.sql"), "utf8");
const tables = [...m0115.matchAll(/create table if not exists (\w+)/g)].map((m) => m[1]);
const functions = [...m0115.matchAll(/create or replace function (\w+)\(\)/g)].map((m) => m[1]);

describe("0116 hardens every table and trigger function that 0115 creates", () => {
  it("0115 creates the five delivery tables and seven trigger functions", () => {
    expect(tables.sort()).toEqual(["newquip_company_profiles", "newquip_quote_customers", "newquip_quote_documents", "newquip_quote_responses", "newquip_quote_sends"]);
    expect(functions).toHaveLength(7);
  });
  it("revokes ALL from public, anon and authenticated for each table, then grants authenticated SELECT only", () => {
    const revoke = /revoke all on ([^;]+?) from public, anon, authenticated;/.exec(m0116)?.[1] ?? "";
    const grant = /grant select on ([^;]+?) to authenticated;/.exec(m0116)?.[1] ?? "";
    for (const t of tables) { expect(revoke, t).toContain(t); expect(grant, t).toContain(t); }
    expect(m0116).not.toMatch(/to\s+(anon|public)\b/i);
    expect(m0116).not.toMatch(/grant\s+(all|insert|update|delete|truncate)[^;]*\bauthenticated/i);
  });
  it("revokes direct EXECUTE of every new trigger function from public, anon and authenticated", () => {
    const block = /revoke all on function([\s\S]+?)from public, anon, authenticated;/.exec(m0116)?.[1] ?? "";
    for (const f of functions) expect(block, f).toContain(`${f}()`);
  });
  it("changes no data and no schema (privileges only)", () => {
    expect(m0116.replace(/--.*$/gm, "")).not.toMatch(/\b(insert|update|delete|drop|alter|create|truncate)\b/i);
  });
});
