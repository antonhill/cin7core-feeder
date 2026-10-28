import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NEWQUIP_REQUIRED_SUPABASE_REF, cin7WritesEnabled, supabaseProjectRef, supabaseWiring } from "../write-flag";

const URL_OK = `https://${NEWQUIP_REQUIRED_SUPABASE_REF}.supabase.co`;
const WIRED = { SUPABASE_URL: URL_OK, NEXT_PUBLIC_SUPABASE_URL: URL_OK };

describe("Cin7 write flag", () => {
  it("is OFF with no variable, and for anything but the exact string 'true'", () => {
    expect(cin7WritesEnabled({ ...WIRED })).toBe(false);
    for (const v of ["", "TRUE", "True", "1", "yes", "on", " true", "true ", "false"]) expect(cin7WritesEnabled({ ...WIRED, NEWQUIP_CIN7_WRITES_ENABLED: v })).toBe(false);
  });
  it("is ON only for the exact string 'true' on a Preview/development deployment wired to the required Supabase project", () => {
    expect(cin7WritesEnabled({ ...WIRED, NEWQUIP_CIN7_WRITES_ENABLED: "true", VERCEL_ENV: "preview" })).toBe(true);
    expect(cin7WritesEnabled({ ...WIRED, NEWQUIP_CIN7_WRITES_ENABLED: "true" })).toBe(true);
  });
  it("is ALWAYS OFF on Production, even if the variable is 'true' (A20)", () => {
    expect(cin7WritesEnabled({ ...WIRED, NEWQUIP_CIN7_WRITES_ENABLED: "true", VERCEL_ENV: "production" })).toBe(false);
  });
  it("is OFF when the deployment points at a different, missing or unreadable Supabase project, even with the flag on", () => {
    const on = { NEWQUIP_CIN7_WRITES_ENABLED: "true", VERCEL_ENV: "preview" };
    expect(cin7WritesEnabled({ ...on })).toBe(false); // nothing configured
    expect(cin7WritesEnabled({ ...on, SUPABASE_URL: "https://aaaaaaaaaaaaaaaaaaaa.supabase.co", NEXT_PUBLIC_SUPABASE_URL: URL_OK })).toBe(false);
    expect(cin7WritesEnabled({ ...on, SUPABASE_URL: URL_OK, NEXT_PUBLIC_SUPABASE_URL: "https://aaaaaaaaaaaaaaaaaaaa.supabase.co" })).toBe(false);
    expect(cin7WritesEnabled({ ...on, SUPABASE_URL: URL_OK, NEXT_PUBLIC_SUPABASE_URL: "not a url" })).toBe(false);
    expect(cin7WritesEnabled({ ...on, SUPABASE_URL: `${URL_OK}.evil.com`, NEXT_PUBLIC_SUPABASE_URL: URL_OK })).toBe(false);
  });
  it("every Cin7-writing action derives its gate from this one function (no second reading of the variable)", () => {
    const src = readFileSync(join(__dirname, "..", "..", "..", "app", "projects", "cin7-actions.ts"), "utf8");
    expect(src).toMatch(/writesEnabled: cin7WritesEnabled\(process\.env\)/);
    expect(src).not.toMatch(/process\.env\.NEWQUIP_CIN7_WRITES_ENABLED/);
  });
});

describe("Supabase wiring", () => {
  it("extracts only the project ref, from the exact <ref>.supabase.co shape", () => {
    expect(supabaseProjectRef(URL_OK)).toBe(NEWQUIP_REQUIRED_SUPABASE_REF);
    expect(supabaseProjectRef(`${URL_OK}/`)).toBe(NEWQUIP_REQUIRED_SUPABASE_REF);
    for (const bad of [undefined, "", "http://x.supabase.co", "https://short.supabase.co", `${URL_OK}/rest/v1`, `https://user:pw@${NEWQUIP_REQUIRED_SUPABASE_REF}.supabase.co`]) expect(supabaseProjectRef(bad)).toBeNull();
  });
  it("reports which side is wrong without echoing anything but a project ref", () => {
    const w = supabaseWiring({ SUPABASE_URL: URL_OK, NEXT_PUBLIC_SUPABASE_URL: "https://witulfbpotimvbfiqbwq.supabase.co" });
    expect(w).toMatchObject({ ok: false, serverRef: NEWQUIP_REQUIRED_SUPABASE_REF, publicRef: "witulfbpotimvbfiqbwq" });
    expect(w.detail).toBe("SUPABASE_URL: required project; NEXT_PUBLIC_SUPABASE_URL: a different project (witulfbpotimvbfiqbwq)");
  });
});
