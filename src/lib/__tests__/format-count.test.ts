import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatCount } from "@/lib/format-count";

describe("formatCount", () => {
  it("formats with a comma separator regardless of the host's default locale", () => {
    // The whole point: this assertion must hold on a CI runner (typically
    // en-US or the C locale) AND on a machine whose default is en-ZA, de-DE,
    // fr-FR — all of which render 10000 differently under a bare
    // toLocaleString(). Asserting the literal string is what makes the
    // guarantee real; a locale-derived expectation would assert nothing.
    expect(formatCount(10_000)).toBe("10,000");
    expect(formatCount(75_000)).toBe("75,000");
    expect(formatCount(1_234_567)).toBe("1,234,567");
  });

  it("does not disagree with the host locale by accident — it genuinely ignores it", () => {
    // If this ever fails while the test above passes, the helper has started
    // deferring to the ambient locale again.
    const ambient = (10_000).toLocaleString();
    expect(formatCount(10_000)).toBe("10,000");
    if (ambient !== "10,000") expect(formatCount(10_000)).not.toBe(ambient);
  });

  it("leaves small numbers and zero unseparated", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
  });
});

/**
 * Regression guard, same shape as the Cin7 gateway-boundary scan: these three
 * modules build user-facing limit/error messages ON THE SERVER, where the
 * default locale is a property of whichever machine served the request rather
 * than of the reader. A bare toLocaleString() here makes the message text
 * machine-dependent — which is exactly how this was found (seven tests green
 * in CI, failing on an en-ZA laptop, with the assertions correct and the
 * source ambient).
 *
 * Deliberately scoped to these three files rather than repo-wide: every
 * page.tsx formatting a number for DISPLAY should keep using a bare
 * toLocaleString(), because there the ambient locale is the viewer's own and
 * honouring it is correct. The distinction is server-built message text vs.
 * client-rendered display, not "locale bad".
 */
const SERVER_MESSAGE_MODULES = ["lib/csv-upload-limits.ts", "reports/query.ts", "reports/xlsx-writer.ts"];

describe("server-built limit messages are locale-independent", () => {
  it.each(SERVER_MESSAGE_MODULES)("%s calls formatCount, never a bare toLocaleString()", (rel) => {
    const src = readFileSync(join(__dirname, "..", "..", rel), "utf8");
    const offenders = src
      .split("\n")
      .map((line, i) => ({ line: i + 1, text: line }))
      .filter(({ text }) => /\.toLocaleString\s*\(\s*\)/.test(text));
    expect(offenders).toEqual([]);
  });
});
