import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { referencesKey, saleRequirements, saleSteps, type SaleStepInput } from "../cin7-sale-steps";

const base: SaleStepInput = { blockerCount: 0, unresolvedCount: 0, customer: "Spark", location: "MSTR", account: "200", taxRule: "Standard Rate Sales", preflight: null, confirmed: false, creationState: null };
const status = (over: Partial<SaleStepInput>, id: string) => saleSteps({ ...base, ...over }).find((s) => s.id === id)!.status;

describe("Cin7 Sale steps (pure)", () => {
  it("has four steps in order", () => { expect(saleSteps(base).map((s) => s.id)).toEqual(["scope", "refs", "preflight", "confirm"]); });
  it("scope: complete only with no blockers and nothing unresolved; otherwise needs attention", () => {
    expect(status({}, "scope")).toBe("complete");
    expect(status({ blockerCount: 1 }, "scope")).toBe("attention");
    expect(status({ unresolvedCount: 2 }, "scope")).toBe("attention");
  });
  it("references: complete only when all four are non-blank (whitespace is blank), and names what is missing", () => {
    expect(status({}, "refs")).toBe("complete");
    expect(status({ account: "  " }, "refs")).toBe("incomplete");
    expect(saleSteps({ ...base, account: "", location: "" }).find((s) => s.id === "refs")!.note).toBe("Missing: location, revenue account");
  });
  it("preflight is optional and derives from the last result; a result for different references is stale", () => {
    expect(status({}, "preflight")).toBe("incomplete");
    const key = referencesKey(base);
    expect(status({ preflight: { verdictReady: true, inputsKey: key } }, "preflight")).toBe("complete");
    expect(status({ preflight: { verdictReady: false, inputsKey: key } }, "preflight")).toBe("attention");
    expect(status({ preflight: { verdictReady: true, inputsKey: key }, account: "300" }, "preflight")).toBe("incomplete");
  });
  it("confirm & create: never complete from the tick alone; complete only once the Sale is RECONCILED", () => {
    expect(status({ confirmed: true }, "confirm")).toBe("incomplete");
    expect(status({ creationState: "RECONCILED" }, "confirm")).toBe("complete");
    expect(status({ creationState: "FAILED_UNCERTAIN" }, "confirm")).toBe("attention");
    expect(status({ creationState: "CREATED" }, "confirm")).toBe("attention");
  });
  it("once a creation record exists the form steps are unavailable", () => {
    expect(status({ creationState: "CREATED" }, "refs")).toBe("unavailable");
    expect(status({ creationState: "CREATED" }, "preflight")).toBe("unavailable");
  });
  it("the three requirements follow scope, references and the tick", () => {
    expect(saleRequirements({ ...base, confirmed: false }).map((r) => r.met)).toEqual([true, true, false]);
    expect(saleRequirements({ ...base, blockerCount: 1, taxRule: "", confirmed: true }).map((r) => r.met)).toEqual([false, false, true]);
  });
  it("imports no server action or store", () => {
    const src = readFileSync(`${process.cwd()}/src/lib/projects/cin7-sale-steps.ts`, "utf8");
    for (const m of src.matchAll(/from\s+"([^"]+)"/g)) expect(m[1]).not.toMatch(/actions|-store|supabase|server-only/);
  });
});
