import { describe, expect, it } from "vitest";
import { toFullCustomerAddressesCsv } from "@/export/customer-addresses-csv-live";

const LIVE_CUSTOMER = {
  Name: "Woolworths",
  Addresses: [
    { Type: "Billing", DefaultForType: true, Line1: "1 Tree Lane", Line2: "", City: "Cape Town", State: "WC", Postcode: "8005", Country: "South Africa" },
    { Type: "Shipping", DefaultForType: false, Line1: "2 Dock Road", Line2: "", City: "Cape Town", State: "WC", Postcode: "8001", Country: "South Africa" },
  ],
};

describe("toFullCustomerAddressesCsv", () => {
  it("includes the exact CustomerAddresses template header", () => {
    const csv = toFullCustomerAddressesCsv([]);
    expect(csv.split("\r\n")[0]).toBe(
      '"Action","Name","AddressType","AddressDefaultForType","AddressLine1","AddressLine2","City","State","Postcode","Country","IsParent"'
    );
  });

  it("emits one row per address", () => {
    const csv = toFullCustomerAddressesCsv([LIVE_CUSTOMER]);
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(3); // header + 2 addresses
    expect(lines[1]).toContain('"Billing"');
    expect(lines[1]).toContain('"True"');
    expect(lines[2]).toContain('"Shipping"');
    expect(lines[2]).toContain('"False"');
  });

  it("emits no rows for a customer with no addresses", () => {
    const csv = toFullCustomerAddressesCsv([{ Name: "No Address Co", Addresses: [] }]);
    expect(csv.trim().split("\r\n")).toHaveLength(1); // header only
  });
});
