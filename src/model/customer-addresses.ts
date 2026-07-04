import { z } from "zod";
import { parseTrueFalse } from "@/model/csv-helpers";

/** Mirrors Cin7 Core's "CustomerAddresses" CSV export template — same shape as SupplierAddresses plus IsParent. */
export const customerAddressCsvRowSchema = z.object({
  Action: z.string().trim().optional().default("Create/Update"),
  Name: z.string().trim().min(1, "Name is required"),
  AddressType: z.string().trim().min(1, "AddressType is required"),
  AddressDefaultForType: z.string().trim().optional().default(""),
  AddressLine1: z.string().trim().optional().default(""),
  AddressLine2: z.string().trim().optional().default(""),
  City: z.string().trim().optional().default(""),
  State: z.string().trim().optional().default(""),
  Postcode: z.string().trim().optional().default(""),
  Country: z.string().trim().optional().default(""),
  IsParent: z.string().trim().optional().default(""),
});

export type CustomerAddressCsvRow = z.infer<typeof customerAddressCsvRowSchema>;

export interface CanonicalCustomerAddress {
  name: string;
  address_type: string;
  address_default_for_type: boolean;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
  is_parent: boolean;
}

export function toCanonicalCustomerAddress(row: CustomerAddressCsvRow): CanonicalCustomerAddress {
  return {
    name: row.Name,
    address_type: row.AddressType,
    address_default_for_type: parseTrueFalse(row.AddressDefaultForType),
    address_line_1: row.AddressLine1 || null,
    address_line_2: row.AddressLine2 || null,
    city: row.City || null,
    state: row.State || null,
    postcode: row.Postcode || null,
    country: row.Country || null,
    is_parent: parseTrueFalse(row.IsParent),
  };
}
