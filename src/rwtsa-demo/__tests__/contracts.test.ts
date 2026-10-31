import { describe, expect, it } from "vitest";
import { MONTH_HEADER_RE, normaliseHeader } from "@/rwtsa-demo/contracts/fields";
import { TAB_CONTRACTS, TAB_NAMES } from "@/rwtsa-demo/contracts/tabs";
import { coerceCell } from "@/rwtsa-demo/workbook/coerce";

describe("contracts", () => {
  it("covers the 11 named tabs of the brief, each with a natural key made of its own fields", () => {
    expect(TAB_NAMES).toHaveLength(11);
    for (const tab of TAB_NAMES) {
      const c = TAB_CONTRACTS[tab];
      const keys = new Set(c.fields.map((f) => f.key));
      expect(c.naturalKey.length).toBeGreaterThan(0);
      for (const k of c.naturalKey) expect(keys.has(k)).toBe(true);
    }
  });

  it("has no duplicate field keys and no header alias claimed by two fields within a tab", () => {
    for (const tab of TAB_NAMES) {
      const c = TAB_CONTRACTS[tab];
      expect(new Set(c.fields.map((f) => f.key)).size).toBe(c.fields.length);
      const seen = new Map<string, string>();
      for (const f of c.fields)
        for (const h of f.headers) {
          const n = normaliseHeader(h);
          // Redundant spellings within ONE field (e.g. "Unit price USD" / "Unit price (USD)") are harmless; two DIFFERENT fields claiming one name is not.
          const owner = seen.get(n);
          expect(owner === undefined || owner === f.key ? "ok" : `${tab}: ${h} claimed by both ${owner} and ${f.key}`).toBe("ok");
          seen.set(n, f.key);
        }
    }
  });

  it("every enum field declares its values", () => {
    for (const tab of TAB_NAMES) for (const f of TAB_CONTRACTS[tab].fields) if (f.kind === "enum") expect(f.values?.length ?? 0).toBeGreaterThan(0);
  });

  it("normalises headers by name only", () => {
    expect(normaliseHeader("Style code")).toBe(normaliseHeader("STYLE_CODE"));
    expect(normaliseHeader("Planned fabric (m)")).toBe("plannedfabricm");
  });

  it("recognises only YYYY-MM as a month header", () => {
    expect(MONTH_HEADER_RE.test("2026-08")).toBe(true);
    for (const bad of ["2026-8", "2026-13", "2026-00", "08-2026", "2026/08", "Aug 2026"]) expect(MONTH_HEADER_RE.test(bad)).toBe(false);
  });
});

describe("cell coercion (strict, never guesses locale, never echoes values)", () => {
  const num = { key: "n", headers: ["n"], kind: "num", required: false } as const;
  const date = { key: "d", headers: ["d"], kind: "date", required: false } as const;
  const bool = { key: "b", headers: ["b"], kind: "bool", required: false } as const;
  const en = { key: "e", headers: ["e"], kind: "enum", required: false, values: ["Import", "Local"] } as const;

  it("numbers", () => {
    expect(coerceCell(num, 12)).toEqual({ ok: true, value: 12 });
    expect(coerceCell(num, " 1 234.5 ")).toEqual({ ok: true, value: 1234.5 });
    expect(coerceCell(num, "-3")).toEqual({ ok: true, value: -3 });
    expect(coerceCell(num, null)).toEqual({ ok: true, value: null });
    expect(coerceCell(num, "  ")).toEqual({ ok: true, value: null });
    for (const bad of ["1,5", "15%", "abc", "1e3", NaN, Infinity]) expect(coerceCell(num, bad)).toMatchObject({ ok: false });
  });

  it("dates: a Date or an unambiguous ISO-like string; never an Excel serial or free text", () => {
    expect(coerceCell(date, new Date(Date.UTC(2026, 9, 31)))).toEqual({ ok: true, value: "2026-10-31" });
    expect(coerceCell(date, "2026-10-31")).toEqual({ ok: true, value: "2026-10-31" });
    expect(coerceCell(date, "2026/10/31")).toEqual({ ok: true, value: "2026-10-31" });
    for (const bad of ["31/10/2026", "next week", 46326, "2026-02-30", new Date("invalid")]) expect(coerceCell(date, bad)).toMatchObject({ ok: false, reason: "date_format" });
  });

  it("booleans and enums", () => {
    expect(coerceCell(bool, "Yes")).toEqual({ ok: true, value: true });
    expect(coerceCell(bool, "n")).toEqual({ ok: true, value: false });
    expect(coerceCell(bool, "maybe")).toMatchObject({ ok: false });
    expect(coerceCell(en, "import")).toEqual({ ok: true, value: "Import" });
    expect(coerceCell(en, "Both")).toMatchObject({ ok: false, reason: "enum_value" });
  });

  it("failure results carry only a reason class, never the offending value", () => {
    const r = coerceCell(num, "SENTINEL-VALUE-123");
    expect(JSON.stringify(r)).not.toContain("SENTINEL");
  });
});
