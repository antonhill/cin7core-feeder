import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Navigation/orientation modules are pure derivation + presentation: they must not import a server action or a store.
const FILES = ["src/lib/projects/claim-stepper.ts", "src/lib/projects/nothing-claimable.ts", "src/lib/projects/variation-next-step.ts", "src/app/projects/[id]/ClaimStepper.tsx"];
describe("UX-006 f modules import no server action or store", () => {
  for (const f of FILES) {
    it(f, () => {
      const src = readFileSync(resolve(process.cwd(), f), "utf8");
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      for (const i of imports) expect(i, `${f} imports ${i}`).not.toMatch(/actions|-store|\/store|supabase|server-only/);
      expect(src).not.toMatch(/"use server"/);
    });
  }
});
