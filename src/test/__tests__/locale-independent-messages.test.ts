import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Regression guard, same shape as the Cin7 gateway-boundary scan: these three
 * modules build user-facing limit/error messages ON THE SERVER, where the
 * default locale is a property of whichever machine served the request rather
 * than of the reader. A locale-ambient formatter here makes the message text
 * machine-dependent — which is exactly how this was found (seven tests green
 * in CI, failing on an en-ZA laptop, with the assertions correct and the
 * source ambient).
 *
 * Deliberately scoped to these three files rather than repo-wide: every
 * page.tsx formatting a number for DISPLAY should keep using a bare
 * toLocaleString(), because there the ambient locale is the viewer's own and
 * honouring it is correct. The distinction is server-built message text vs.
 * client-rendered display, not "locale bad".
 *
 * WHAT COUNTS AS AMBIENT. The first version of this guard matched only the
 * empty-parens form and was found, on review, to pass on
 * `toLocaleString(undefined)` — which resolves the locale identically and is
 * therefore the same defect wearing different syntax. Both forms are rejected
 * now. An EXPLICIT locale (`toLocaleString("en-US")`, or a variable the caller
 * resolved deliberately) is not ambient and stays allowed, so the rule remains
 * "the locale must be a decision", not "this API is forbidden".
 *
 * RESIDUAL LIMIT, stated rather than implied: this is a text-level scan of
 * three named files. It cannot see a formatter reached through an alias, a
 * helper defined elsewhere, or `Intl.NumberFormat()` constructed with no
 * locale. Treat a pass as a floor, not a proof.
 */
const SERVER_MESSAGE_MODULES = ["lib/csv-upload-limits.ts", "reports/query.ts", "reports/xlsx-writer.ts"];

/**
 * Ambient = the call decides nothing about the locale, so the host does:
 * `.toLocaleString()` and `.toLocaleString(undefined, ...)` both fall back to
 * the runtime default. An explicit first argument — a string literal or a
 * resolved variable — is a deliberate choice and is left alone.
 */
const AMBIENT_LOCALE_FORMATTER = /\.toLocaleString\s*\(\s*(\)|undefined\b)/;

describe("server-built limit messages are locale-independent", () => {
  it.each(SERVER_MESSAGE_MODULES)("%s formats through formatCount, never an ambient locale", (rel) => {
    const src = readFileSync(join(__dirname, "..", "..", rel), "utf8");
    const offenders = src
      .split("\n")
      .map((line, i) => ({ line: i + 1, text: line.trim() }))
      .filter(({ text }) => AMBIENT_LOCALE_FORMATTER.test(text));
    expect(offenders).toEqual([]);
  });

  it("rejects both ambient forms and allows an explicit locale", () => {
    // Pins the regex's own semantics, so a future edit that narrows it back
    // fails here rather than silently reopening the gap this guard was
    // widened to close.
    expect(AMBIENT_LOCALE_FORMATTER.test('n.toLocaleString()')).toBe(true);
    expect(AMBIENT_LOCALE_FORMATTER.test('n.toLocaleString( )')).toBe(true);
    expect(AMBIENT_LOCALE_FORMATTER.test('n.toLocaleString(undefined)')).toBe(true);
    expect(AMBIENT_LOCALE_FORMATTER.test('n.toLocaleString(undefined, { maximumFractionDigits: 2 })')).toBe(true);

    expect(AMBIENT_LOCALE_FORMATTER.test('n.toLocaleString("en-US")')).toBe(false);
    expect(AMBIENT_LOCALE_FORMATTER.test("n.toLocaleString('en-ZA')")).toBe(false);
    expect(AMBIENT_LOCALE_FORMATTER.test('n.toLocaleString(locale)')).toBe(false);
    expect(AMBIENT_LOCALE_FORMATTER.test('n.toLocaleString(undefinedLocale)')).toBe(false);
  });
});
