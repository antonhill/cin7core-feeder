import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cin7WritesEnabled } from "../write-flag";

describe("Cin7 write flag", () => {
  it("is OFF with no variable, and for anything but the exact string 'true'", () => {
    expect(cin7WritesEnabled({})).toBe(false);
    for (const v of ["", "TRUE", "True", "1", "yes", "on", " true", "true ", "false"]) expect(cin7WritesEnabled({ NEWQUIP_CIN7_WRITES_ENABLED: v })).toBe(false);
  });
  it("is ON only for the exact string 'true' on a Preview/development deployment", () => {
    expect(cin7WritesEnabled({ NEWQUIP_CIN7_WRITES_ENABLED: "true", VERCEL_ENV: "preview" })).toBe(true);
    expect(cin7WritesEnabled({ NEWQUIP_CIN7_WRITES_ENABLED: "true" })).toBe(true);
  });
  it("is ALWAYS OFF on Production, even if the variable is 'true' (A20)", () => {
    expect(cin7WritesEnabled({ NEWQUIP_CIN7_WRITES_ENABLED: "true", VERCEL_ENV: "production" })).toBe(false);
  });
  it("every Cin7-writing action derives its gate from this one function (no second reading of the variable)", () => {
    const src = readFileSync(join(__dirname, "..", "..", "..", "app", "projects", "cin7-actions.ts"), "utf8");
    expect(src).toMatch(/writesEnabled: cin7WritesEnabled\(process\.env\)/);
    expect(src).not.toMatch(/process\.env\.NEWQUIP_CIN7_WRITES_ENABLED/);
  });
});
