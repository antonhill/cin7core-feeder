import { z } from "zod";

/** "True"/"False" (Cin7's boolean convention for Customers/Suppliers CSVs, distinct from Products' "Yes"/"No"). Case-insensitive; anything else defaults to false. */
export function parseTrueFalse(value: string | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "true";
}

/** Money-like fields (CreditLimit, Discount) can carry thousand-separator commas, e.g. "20,000,000.00" — z.coerce.number() alone rejects that. */
export const commaNumber = z.preprocess((val) => {
  if (typeof val === "string") {
    const stripped = val.replace(/,/g, "").trim();
    return stripped === "" ? undefined : stripped;
  }
  return val;
}, z.coerce.number().optional());
