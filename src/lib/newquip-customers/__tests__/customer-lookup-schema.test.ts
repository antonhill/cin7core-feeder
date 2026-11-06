import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CUSTOMER_LOOKUP_COLUMNS } from "../cin7-customer-read";

// The customer lookup reads `customers` and `customer_contacts`. The real-database proof (columns exist in the fully migrated schema, queries run, organisation scoping) is
// supabase/tests/newquip_customer_lookup_schema.test.sql, executed in CI against the migrated database. This test ties the TypeScript column list to that SQL test's
// marker lines, so changing the lookup without changing (and thereby re-proving) the schema contract fails here.
const sql = readFileSync(join(__dirname, "..", "..", "..", "..", "supabase", "tests", "newquip_customer_lookup_schema.test.sql"), "utf8");
const marker = (table: string) => (new RegExp(`^-- lookup-columns ${table}: (.+)$`, "m").exec(sql)?.[1] ?? "").split(",").map((c) => c.trim());

describe("customer lookup column contract", () => {
  it("the SQL schema test lists exactly the columns the lookup selects, for both tables", () => {
    expect(marker("customers")).toEqual([...CUSTOMER_LOOKUP_COLUMNS.customers]);
    expect(marker("customer_contacts")).toEqual([...CUSTOMER_LOOKUP_COLUMNS.customer_contacts]);
  });
  it("never asks `customers` for contact or email columns (they live in customer_contacts since migration 0015)", () => {
    for (const bad of ["contact_name", "email", "phone", "mobile_phone", "contact_default"]) expect(CUSTOMER_LOOKUP_COLUMNS.customers as readonly string[]).not.toContain(bad);
  });
  it("the real schema test also asserts the model (customers has no contact columns) so a future change to it is deliberate", () => {
    expect(sql).toContain("customers.% unexpectedly exists");
  });
});
