import { describe, expect, it } from "vitest";
import { parseCsv, parseMoney, reconcileOpportunity, type OppExpectations } from "@/rwtsa-live/opportunities";

const EXP: OppExpectations = { number: "OP-T1", sourceReference: "Q-T1", status: "LOST", customer: "Test Customer", rep: "Rep Z", valueExTax: 1000, valueInclTax: 1150, reason: "Stock/availability" };
const H = "Opportunity Number,Status,Reference,Customer,Sales Representative,Value Ex Tax,Value Incl Tax";
const ROW = "OP-T1,LOST,Q-T1 Stock availability,Test Customer,Rep Z,1000.00,1150.00";
const csv = (...rows: string[]) => [H, ...rows].join("\n");
const st = (e: ReturnType<typeof reconcileOpportunity>, id: string) => e.checks.find((c) => c.id === id)?.status;

describe("parseCsv / parseMoney", () => {
  it("handles quotes, doubled quotes, CRLF, BOM; an open quote is null", () => {
    expect(parseCsv('﻿a,"b,1","c ""x"""\r\n1,2,3\r\n')).toEqual([["a", "b,1", 'c "x"'], ["1", "2", "3"]]);
    expect(parseCsv('a,"b')).toBeNull();
  });
  it("accepts only unambiguous money", () => {
    expect(parseMoney("R150,000.00")).toBe(150000);
    expect(parseMoney("ZAR 172 500")).toBe(172500);
    expect(parseMoney("1000")).toBe(1000);
    for (const bad of ["1,00", "150.000,00", "1,2345", "abc", "", "1e3", null]) expect(parseMoney(bad as string | null)).toBeNull();
  });
});

describe("reconcileOpportunity", () => {
  it("MATCH when the native status is LOST, the reference holds the source reference and loss reason (punctuation ignored), and values match", () => {
    const e = reconcileOpportunity(csv(ROW), EXP);
    expect(e.verdict).toBe("MATCH");
    expect(e.checks.map((c) => c.status)).toEqual(Array(8).fill("PASS"));
    expect(e.observed).toMatchObject({ status: "LOST", valueExTax: 1000, valueInclTax: 1150 });
  });
  it("status comes ONLY from the native status column: a quotation word is never mapped (Rejected/Declined are not LOST)", () => {
    for (const s of ["Rejected", "Declined", "Closed Lost", "Won", "Open"]) {
      const e = reconcileOpportunity(csv(ROW.replace("LOST", s)), EXP);
      expect(st(e, "nativeStatus")).toBe("FAIL");
      expect(e.verdict).toBe("MISMATCH");
    }
    expect(st(reconcileOpportunity(csv(ROW.replace("LOST", "lost")), EXP), "nativeStatus")).toBe("PASS");
  });
  it("reference: source reference must be a whole token; wrong reference or reason FAILs", () => {
    expect(st(reconcileOpportunity(csv(ROW.replace("Q-T1", "Q-T10")), EXP), "sourceReference")).toBe("FAIL");
    expect(st(reconcileOpportunity(csv(ROW.replace("Stock availability", "Lead time")), EXP), "lossReason")).toBe("FAIL");
    expect(st(reconcileOpportunity(csv(ROW.replace("Stock availability", "Stockavailability")), EXP), "lossReason")).toBe("FAIL");
  });
  it("values: compared to the cent; ex/incl swapped or wrong FAIL; unparseable is UNVERIFIED", () => {
    expect(st(reconcileOpportunity(csv(ROW.replace("1000.00,1150.00", "1150.00,1000.00")), EXP), "valueExTax")).toBe("FAIL");
    expect(st(reconcileOpportunity(csv(ROW.replace("1000.00", "1000.004")), EXP), "valueExTax")).toBe("PASS");
    const e = reconcileOpportunity(csv(ROW.replace("1000.00", "\"1,00\"")), EXP);
    expect(st(e, "valueExTax")).toBe("UNVERIFIED");
    expect(e.verdict).toBe("UNVERIFIED");
  });
  it("customer and rep mismatches FAIL and beat UNVERIFIED", () => {
    expect(reconcileOpportunity(csv(ROW.replace("Rep Z", "Rep Q")), EXP).verdict).toBe("MISMATCH");
    expect(st(reconcileOpportunity(csv(ROW.replace("Test Customer", "Other")), EXP), "customer")).toBe("FAIL");
  });
  it("an absent Opportunity is UNVERIFIED (an export may be filtered), never a definitive not-found; duplicates are UNVERIFIED", () => {
    const none = reconcileOpportunity(csv(ROW.replace("OP-T1", "OP-T2")), EXP);
    expect(none.verdict).toBe("UNVERIFIED");
    expect(none.checks[0]).toMatchObject({ id: "opportunityPresent", status: "UNVERIFIED" });
    expect(JSON.stringify(none)).not.toMatch(/NOT_FOUND/);
    expect(reconcileOpportunity(csv(ROW, ROW), EXP).verdict).toBe("UNVERIFIED");
  });
  it("unrecognised or ambiguous headers are UNVERIFIED, never guessed; an explicit mapping resolves them", () => {
    const odd = "Opp,Stage X,Ref,Cust,Rep,A,B\nOP-T1,LOST,Q-T1 Stock availability,Test Customer,Rep Z,1000,1150";
    const e = reconcileOpportunity(odd, EXP);
    expect(e.verdict).toBe("UNVERIFIED");
    expect(e.columnIssues.join(" ")).toMatch(/number column is not recognised/);
    const mapped = reconcileOpportunity(odd, EXP, { mapping: { number: "Opp", status: "Stage X", reference: "Ref", customer: "Cust", rep: "Rep", valueExTax: "A", valueInclTax: "B" } });
    expect(mapped.verdict).toBe("MATCH");
    const amb = reconcileOpportunity("Opportunity Number,Opportunity No,Status\nOP-T1,OP-T1,LOST", EXP);
    expect(amb.verdict).toBe("UNVERIFIED");
    expect(amb.columnIssues.join(" ")).toMatch(/More than one header/);
    expect(reconcileOpportunity(csv(ROW), EXP, { mapping: { status: "Nope" } }).columnIssues.join(" ")).toMatch(/not found exactly once/);
  });
  it("a bare Total/Value header is NOT assumed to be ex- or incl-tax", () => {
    const e = reconcileOpportunity("Opportunity Number,Status,Reference,Customer,Sales Representative,Value\nOP-T1,LOST,Q-T1 Stock availability,Test Customer,Rep Z,1000", EXP);
    expect(st(e, "valueExTax")).toBe("UNVERIFIED");
    expect(st(e, "valueInclTax")).toBe("UNVERIFIED");
    expect(e.verdict).toBe("UNVERIFIED");
  });
  it("malformed exports are UNVERIFIED: empty, open quote, ragged rows, duplicate headers", () => {
    for (const t of ["", '"a,b', H + "\nOP-T1,LOST", "Status,Status\nA,B"]) expect(reconcileOpportunity(t, EXP).verdict).toBe("UNVERIFIED");
  });
  it("missing status or reference columns are UNVERIFIED, not PASS", () => {
    const e = reconcileOpportunity("Opportunity Number,Customer\nOP-T1,Test Customer", EXP);
    expect(st(e, "nativeStatus")).toBe("UNVERIFIED");
    expect(st(e, "sourceReference")).toBe("UNVERIFIED");
    expect(st(e, "lossReason")).toBe("UNVERIFIED");
  });
});
