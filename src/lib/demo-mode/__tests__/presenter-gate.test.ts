import { describe, expect, it } from "vitest";
import { presenterGate, supabaseRef } from "../presenter";

const UAT = "wevhibjvinmdvuuyurql";
const PROD = "pnzwjqjovxxdikxtfngq";
const open = { VERCEL_ENV: "preview", NEWQUIP_PRESENTER_LOGIN_ENABLED: "true", NEWQUIP_PRESENTER_ACCESS_KEY: "k".repeat(32), NEWQUIP_PRESENTER_SUPABASE_REF: UAT, NEXT_PUBLIC_SUPABASE_URL: `https://${UAT}.supabase.co`, SUPABASE_URL: `https://${UAT}.supabase.co` };

describe("presenter sign-in gate", () => {
  it("opens only when every condition holds", () => expect(presenterGate(open).allowed).toBe(true));
  it.each([
    ["production", { VERCEL_ENV: "production" }],
    ["development", { VERCEL_ENV: "development" }],
    ["unset env", { VERCEL_ENV: undefined }],
    ["switch off", { NEWQUIP_PRESENTER_LOGIN_ENABLED: "false" }],
    ["short key", { NEWQUIP_PRESENTER_ACCESS_KEY: "short" }],
    ["no key", { NEWQUIP_PRESENTER_ACCESS_KEY: undefined }],
    ["production database in the public URL", { NEXT_PUBLIC_SUPABASE_URL: `https://${PROD}.supabase.co` }],
    ["production database in the server URL", { SUPABASE_URL: `https://${PROD}.supabase.co` }],
    ["ref not configured", { NEWQUIP_PRESENTER_SUPABASE_REF: undefined }],
    ["ref configured as production", { NEWQUIP_PRESENTER_SUPABASE_REF: PROD }],
  ])("stays closed: %s", (_n, o) => expect(presenterGate({ ...open, ...o }).allowed).toBe(false));
  it("parses refs strictly", () => {
    expect(supabaseRef(`https://${UAT}.supabase.co`)).toBe(UAT);
    expect(supabaseRef(`https://${UAT}.supabase.co.evil.com`)).toBeNull();
    expect(supabaseRef(undefined)).toBeNull();
  });
});
