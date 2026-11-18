import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// NQ-008A transferability: the NewQuip pricing modules stay identifiable, free of Spark organisation identities, and free of Spark billing / internal-infrastructure
// dependencies. They may use only NewQuip's own modules and the generic quote-engine / database-client interfaces they already used.
const ROOT = path.resolve(__dirname, "../../../..");
const FILES = [
  ...readdirSync(path.join(ROOT, "src/newquip/pricing")).filter((f) => f.endsWith(".ts")).map((f) => `src/newquip/pricing/${f}`),
  "src/lib/newquip-quotes/indicative-store.ts",
  "src/app/newquip-grower/[id]/PricingFeedbackNote.tsx",
  "src/app/newquip-grower/[id]/IndicativeComparisonPanel.tsx",
];
const src = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
const imports = (f: string) => [...src(f).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);

describe("NQ-008A modules are NewQuip-specific and transferable", () => {
  it("found the modules", () => expect(FILES.length).toBeGreaterThanOrEqual(8));
  it("contain no organisation or instance identifier (UUID) and no Spark identity", () => {
    for (const f of FILES) {
      expect(src(f), f).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(src(f), f).not.toMatch(/sparkconsulting|spark18|NEWQUIP_POC_ORG_IDS|isNewquipPocOrg|DEMO_ORG_ID/i);
    }
  });
  it("import nothing from Spark billing, subscriptions, plans or the Cin7 / Xero integrations", () => {
    for (const f of FILES) for (const i of imports(f)) {
      expect(i, `${f} -> ${i}`).not.toMatch(/billing|lemon|subscription|plan|@\/cin7|xero|@\/sync|@\/migrate|@\/lib\/email/i);
    }
  });
  it("the pricing modules (excluding the UI and the store) import only NewQuip modules and the quote engine", () => {
    for (const f of FILES.filter((x) => x.startsWith("src/newquip/pricing/") && !x.includes("__tests__"))) for (const i of imports(f)) {
      expect(i.startsWith(".") || i.startsWith("@/newquip/"), `${f} -> ${i}`).toBe(true);
    }
  });
  it("add no commercial rule: no markup, margin-limit, freight or installation formula or constant in the new pricing modules", () => {
    for (const f of FILES.filter((x) => x.startsWith("src/newquip/pricing/") && !x.includes("__tests__"))) {
      expect(src(f), f).not.toMatch(/\b(marginFloor|minMargin|freightPct|freightRate|installationRate|installationPct|categoryMarkup)\b/i);
    }
  });
});
