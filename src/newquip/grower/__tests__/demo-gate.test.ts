import { describe, expect, it } from "vitest";
import { demoToolsEnabled } from "../demo-gate";

describe("where the UAT demonstration tools are available", () => {
  it("on a Preview deployment", () => { expect(demoToolsEnabled({ VERCEL_ENV: "preview" })).toBe(true); });
  it("on newquip-uat (its own Production target) ONLY when BOTH explicit settings are present", () => {
    expect(demoToolsEnabled({ VERCEL_ENV: "production", NEWQUIP_UAT_DEMO_TOOLS: "true", CIN7_CREDENTIAL_STORE: "uat" })).toBe(true);
  });
  it("NOT on Toolbox Production (neither setting), and one setting alone is not enough", () => {
    expect(demoToolsEnabled({ VERCEL_ENV: "production" })).toBe(false);
    expect(demoToolsEnabled({ VERCEL_ENV: "production", NEWQUIP_UAT_DEMO_TOOLS: "true" })).toBe(false);
    expect(demoToolsEnabled({ VERCEL_ENV: "production", CIN7_CREDENTIAL_STORE: "uat" })).toBe(false);
    expect(demoToolsEnabled({ VERCEL_ENV: "production", NEWQUIP_UAT_DEMO_TOOLS: "TRUE", CIN7_CREDENTIAL_STORE: "uat" })).toBe(false); // exact value only
    expect(demoToolsEnabled({ VERCEL_ENV: "production", NEWQUIP_UAT_DEMO_TOOLS: "true", CIN7_CREDENTIAL_STORE: "live" })).toBe(false);
    expect(demoToolsEnabled({})).toBe(false);
    expect(demoToolsEnabled({ VERCEL_ENV: "development" })).toBe(false);
  });
});
