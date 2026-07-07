import { describe, expect, it } from "vitest";
import {
  findNoContacts,
  findMissingEmail,
  findMissingPhone,
  findMissingTaxNumber,
  findMissingAddressCountry,
  findMissingAddressPostcode,
  findMissingTags,
  findMissingSalesRep,
  findMissingLocation,
  runPartyAudit,
  type RawParty,
} from "@/audit/party-audit";

function party(overrides: Partial<RawParty> = {}): RawParty {
  return {
    ID: "id-1",
    Name: "Acme Co",
    TaxNumber: "TAX123",
    Tags: "vip",
    SalesRepresentative: "Jane",
    Location: "Main Warehouse",
    Addresses: [{ Country: "South Africa", Postcode: "8001" }],
    Contacts: [{ Name: "Bob", Email: "bob@acme.com", Phone: "0123456789" }],
    ...overrides,
  };
}

describe("findNoContacts", () => {
  it("flags a party with no Contacts array", () => {
    const issues = findNoContacts([party({ Contacts: undefined })]);
    expect(issues).toEqual([{ type: "no_contacts", partyId: "id-1", name: "Acme Co" }]);
  });

  it("flags a party whose only contact has no Name", () => {
    expect(findNoContacts([party({ Contacts: [{ Name: "", Email: "a@b.com" }] })])).toHaveLength(1);
  });

  it("does not flag a party with at least one named contact", () => {
    expect(findNoContacts([party()])).toEqual([]);
  });
});

describe("findMissingEmail", () => {
  it("flags a party where no contact has an Email", () => {
    const issues = findMissingEmail([party({ Contacts: [{ Name: "Bob", Email: "" }] })]);
    expect(issues).toEqual([{ type: "missing_email", partyId: "id-1", name: "Acme Co" }]);
  });

  it("flags a party with zero contacts too, since it has no email either", () => {
    expect(findMissingEmail([party({ Contacts: [] })])).toHaveLength(1);
  });

  it("does not flag a party where any contact has an Email", () => {
    expect(findMissingEmail([party()])).toEqual([]);
  });
});

describe("findMissingPhone", () => {
  it("flags a party where no contact has Phone or MobilePhone", () => {
    const issues = findMissingPhone([party({ Contacts: [{ Name: "Bob", Phone: "", MobilePhone: "" }] })]);
    expect(issues).toEqual([{ type: "missing_phone", partyId: "id-1", name: "Acme Co" }]);
  });

  it("does not flag when MobilePhone alone is set", () => {
    expect(findMissingPhone([party({ Contacts: [{ Name: "Bob", Phone: "", MobilePhone: "082" }] })])).toEqual([]);
  });
});

describe("findMissingTaxNumber", () => {
  it("flags a blank TaxNumber", () => {
    expect(findMissingTaxNumber([party({ TaxNumber: "" })])).toHaveLength(1);
  });

  it("treats whitespace-only as blank", () => {
    expect(findMissingTaxNumber([party({ TaxNumber: "  " })])).toHaveLength(1);
  });

  it("does not flag a set TaxNumber", () => {
    expect(findMissingTaxNumber([party()])).toEqual([]);
  });
});

describe("findMissingAddressCountry", () => {
  it("flags a party with an address missing Country", () => {
    const issues = findMissingAddressCountry([party({ Addresses: [{ Country: "", Postcode: "8001" }] })]);
    expect(issues).toEqual([{ type: "missing_address_country", partyId: "id-1", name: "Acme Co" }]);
  });

  it("does not flag a party with zero addresses — nothing to check yet", () => {
    expect(findMissingAddressCountry([party({ Addresses: [] })])).toEqual([]);
  });

  it("flags if any one of several addresses is missing Country, even if another has it", () => {
    const issues = findMissingAddressCountry([
      party({
        Addresses: [
          { Country: "South Africa", Postcode: "8001" },
          { Country: "", Postcode: "8002" },
        ],
      }),
    ]);
    expect(issues).toHaveLength(1);
  });
});

describe("findMissingAddressPostcode", () => {
  it("flags a party with an address missing Postcode", () => {
    expect(findMissingAddressPostcode([party({ Addresses: [{ Country: "South Africa", Postcode: "" }] })])).toHaveLength(1);
  });

  it("does not flag a party with zero addresses", () => {
    expect(findMissingAddressPostcode([party({ Addresses: [] })])).toEqual([]);
  });
});

describe("findMissingTags / findMissingSalesRep / findMissingLocation", () => {
  it("flag blank values", () => {
    expect(findMissingTags([party({ Tags: "" })])).toHaveLength(1);
    expect(findMissingSalesRep([party({ SalesRepresentative: "" })])).toHaveLength(1);
    expect(findMissingLocation([party({ Location: "" })])).toHaveLength(1);
  });

  it("do not flag set values", () => {
    expect(findMissingTags([party()])).toEqual([]);
    expect(findMissingSalesRep([party()])).toEqual([]);
    expect(findMissingLocation([party()])).toEqual([]);
  });
});

describe("runPartyAudit", () => {
  it("includes Tags/SalesRep/Location checks for customers", () => {
    const result = runPartyAudit([party({ Tags: "", SalesRepresentative: "", Location: "" })], "customer");
    const types = result.issues.map((i) => i.type);
    expect(types).toContain("missing_tags");
    expect(types).toContain("missing_sales_rep");
    expect(types).toContain("missing_location");
  });

  it("omits Tags/SalesRep/Location checks for suppliers — those fields don't exist on Cin7's Supplier model", () => {
    const result = runPartyAudit([party({ Tags: "", SalesRepresentative: "", Location: "" })], "supplier");
    const types = result.issues.map((i) => i.type);
    expect(types).not.toContain("missing_tags");
    expect(types).not.toContain("missing_sales_rep");
    expect(types).not.toContain("missing_location");
  });

  it("still runs the shared checks for suppliers", () => {
    const result = runPartyAudit([party({ TaxNumber: "" })], "supplier");
    expect(result.issues.map((i) => i.type)).toContain("missing_tax_number");
  });

  it("returns every party in the roster regardless of issues", () => {
    const result = runPartyAudit([party(), party({ ID: "id-2", Name: "Other Co" })], "customer");
    expect(result.parties).toEqual([
      { partyId: "id-1", name: "Acme Co" },
      { partyId: "id-2", name: "Other Co" },
    ]);
  });
});
