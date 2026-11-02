import { afterEach, describe, expect, it } from "vitest";
import { formatZar, formatZarCents } from "../format-money";

const N = "\u00A0"; // literal, independent of the module constant
describe("formatZarCents", () => {
  it.each([
    [0, `R${N}0,00`],
    [1, `R${N}0,01`],
    [5, `R${N}0,05`],
    [99, `R${N}0,99`],
    [100, `R${N}1,00`],
    [99999, `R${N}999,99`],
    [100000, `R${N}1${N}000,00`],
    [123456789, `R${N}1${N}234${N}567,89`],
    [1234567890, `R${N}12${N}345${N}678,90`],
    [-123450, `-R${N}1${N}234,50`],
    [-1, `-R${N}0,01`],
    [Number.MAX_SAFE_INTEGER, `R${N}90${N}071${N}992${N}547${N}409,91`],
    [1e17, `R${N}1${N}000${N}000${N}000${N}000${N}000,00`],
  ])("%d cents -> %s", (c, out) => expect(formatZarCents(c)).toBe(out));
  it("negative zero and sub-cent negatives never print '-R 0,00'", () => {
    expect(formatZarCents(-0)).toBe(`R${N}0,00`);
    expect(formatZarCents(-0.4)).toBe(`R${N}0,00`);
  });
  it("null / undefined / NaN / Infinity -> placeholder (default em dash; overridable)", () => {
    for (const v of [null, undefined, NaN, Infinity, -Infinity]) { expect(formatZarCents(v)).toBe("—"); expect(formatZarCents(v, "?")).toBe("?"); }
  });
});

describe("formatZar (rands)", () => {
  it.each([
    [0, `R${N}0,00`],
    [12345678.9, `R${N}12${N}345${N}678,90`],
    [1234.5, `R${N}1${N}234,50`],
    [-1234.5, `-R${N}1${N}234,50`],
    [0.1 + 0.2, `R${N}0,30`],
    [1.005, `R${N}1,01`], // half-up on the written decimal, not the binary 1.00499999...
    [2.675, `R${N}2,68`],
    [0.005, `R${N}0,01`],
    [0.004, `R${N}0,00`],
    [-0.005, `-R${N}0,01`], // half away from zero
    [0.995, `R${N}1,00`],
    [999999.995, `R${N}1${N}000${N}000,00`],
    [1e15, `R${N}1${N}000${N}000${N}000${N}000${N}000,00`],
    [1e21, `R${N}1${N}000${N}000${N}000${N}000${N}000${N}000${N}000,00`],
  ])("%s -> %s", (r, out) => expect(formatZar(r)).toBe(out));
  it("summing floats does not drift", () => {
    let t = 0; for (let i = 0; i < 10; i++) t += 0.1;
    expect(formatZar(t)).toBe(`R${N}1,00`);
  });
  it("null / undefined / NaN -> em dash", () => { for (const v of [null, undefined, NaN, Infinity]) expect(formatZar(v)).toBe("—"); });
  it("agrees with the cents formatter", () => { for (const c of [0, 7, 100, 12345, 99999999, -4250]) expect(formatZar(c / 100)).toBe(formatZarCents(c)); });
});

describe("shape and locale independence", () => {
  const original = process.env.LANG; const origLc = process.env.LC_ALL;
  afterEach(() => { process.env.LANG = original; process.env.LC_ALL = origLc; });
  it("uses NBSP only: no ASCII space, no comma thousands, no dot decimal, exactly one comma", () => {
    for (const c of [0, 12345678901, -987654321]) {
      const s = formatZarCents(c);
      expect(s).not.toContain(" "); expect(s).not.toContain("."); expect(s.match(/,/g)).toHaveLength(1);
      expect(s.charCodeAt(s.indexOf("R") + 1)).toBe(0xa0);
      expect(s).toMatch(/^-?R\u00A0\d{1,3}(\u00A0\d{3})*,\d{2}$/);
    }
  });
  it("does not change with the process locale environment or the Intl/Number locale methods", () => {
    const base = formatZarCents(1234567890);
    process.env.LANG = "de_DE.UTF-8"; process.env.LC_ALL = "fr_FR.UTF-8";
    const toLoc = Number.prototype.toLocaleString;
    Number.prototype.toLocaleString = function () { return "LOCALE-LEAK"; };
    const NF = Intl.NumberFormat;
    (Intl as { NumberFormat: unknown }).NumberFormat = function () { throw new Error("Intl used"); };
    try { expect(formatZarCents(1234567890)).toBe(base); expect(formatZar(12345678.9)).toBe(base); }
    finally { Number.prototype.toLocaleString = toLoc; (Intl as { NumberFormat: unknown }).NumberFormat = NF; }
    expect(base).toBe(`R${N}12${N}345${N}678,90`);
  });
});
