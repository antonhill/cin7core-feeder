import { describe, expect, it } from "vitest";
import { z } from "zod";
import { commaNumber, parseTrueFalse } from "@/model/csv-helpers";

describe("parseTrueFalse", () => {
  it("treats 'True' (any case/whitespace) as true", () => {
    expect(parseTrueFalse("True")).toBe(true);
    expect(parseTrueFalse("  true  ")).toBe(true);
    expect(parseTrueFalse("TRUE")).toBe(true);
  });

  it("treats anything else (including undefined) as false", () => {
    expect(parseTrueFalse("False")).toBe(false);
    expect(parseTrueFalse("")).toBe(false);
    expect(parseTrueFalse(undefined)).toBe(false);
  });
});

describe("commaNumber", () => {
  const schema = z.object({ Amount: commaNumber });

  it("strips thousand-separator commas before parsing", () => {
    expect(schema.parse({ Amount: "20,000,000.00" }).Amount).toBe(20000000);
  });

  it("parses a plain number string with no commas", () => {
    expect(schema.parse({ Amount: "1500.50" }).Amount).toBe(1500.5);
  });

  it("treats an empty string as absent, not zero", () => {
    expect(schema.parse({ Amount: "" }).Amount).toBeUndefined();
  });
});
