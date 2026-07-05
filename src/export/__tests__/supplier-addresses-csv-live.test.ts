import { describe, expect, it } from "vitest";
import { toFullSupplierAddressesCsv } from "@/export/supplier-addresses-csv-live";

const LIVE_SUPPLIER = {
  Name: "ABC Suppliers",
  Addresses: [
    { Type: "Billing", DefaultForType: true, Line1: "1 Pear Tree Circle", Line2: "", City: "Epping", State: "Western Cape", Postcode: "8121", Country: "South Africa" },
  ],
};

describe("toFullSupplierAddressesCsv", () => {
  it("includes the exact SupplierAddresses template header (no IsParent, unlike CustomerAddresses)", () => {
    const csv = toFullSupplierAddressesCsv([]);
    expect(csv.split("\r\n")[0]).toBe(
      '"Action","Name","AddressType","AddressDefaultForType","AddressLine1","AddressLine2","City","State","Postcode","Country"'
    );
  });

  it("maps a real live address", () => {
    const csv = toFullSupplierAddressesCsv([LIVE_SUPPLIER]);
    const dataLine = csv.split("\r\n")[1];
    expect(dataLine).toContain('"ABC Suppliers"');
    expect(dataLine).toContain('"Billing"');
    expect(dataLine).toContain('"Epping"');
  });

  it("emits no rows for a supplier with no addresses", () => {
    const csv = toFullSupplierAddressesCsv([{ Name: "No Address Co", Addresses: [] }]);
    expect(csv.trim().split("\r\n")).toHaveLength(1);
  });
});
