import { describe, expect, it } from "vitest";
import { friendlyCin7Error } from "../cin7-error-text";

describe("friendlyCin7Error (UX-006i2): a Cin7 failure is shown as a plain sentence", () => {
  it("raw JSON bodies become the message, never JSON", () => {
    const t = friendlyCin7Error('{"Exception":"The remote server returned an error: (503) Server Unavailable."}');
    expect(t).toBe("Could not read costs from Cin7: The remote server returned an error: (503) Server Unavailable. Try again; nothing was changed.");
    expect(t).not.toMatch(/[{}"]/);
  });
  it("a prefix before the JSON and an unknown shape are handled", () => {
    expect(friendlyCin7Error('Cin7 request failed: {"error":"Rate limit exceeded"}')).toBe("Could not read costs from Cin7: Rate limit exceeded. Try again; nothing was changed.");
    expect(friendlyCin7Error('{"foo":1}')).toBe("Could not read costs from Cin7: Cin7 did not accept the request. Try again; nothing was changed.");
  });
  it("stack traces never appear", () => {
    const t = friendlyCin7Error("TypeError: fetch failed\n    at fetchCin7 (/app/src/cin7/http.ts:12:3)\n    at async run (/app/x.ts:4:1)");
    expect(t).toBe("Could not read costs from Cin7: TypeError: fetch failed. Try again; nothing was changed.");
    expect(t).not.toMatch(/\bat\b.*\(/);
  });
  it("an ordinary sentence is left exactly as it is", () => {
    expect(friendlyCin7Error("The cost estimate could not be read.")).toBe("The cost estimate could not be read.");
  });
});

import { readFileSync } from "node:fs";
describe("UX-006i2: the Effective (date and time) input shows a focus ring (class contract)", () => {
  it("the datetime-local input carries the :focus-within ring that uses the app's focus colour, and only that input changed", async () => {
    const { DATETIME_FOCUS } = await import("../[id]/CostPanel");
    expect(DATETIME_FOCUS).toContain("focus-within:[outline:2px_solid_var(--focus-ring)]");
    expect(DATETIME_FOCUS).toContain("focus-within:[outline-offset:2px]");
    const src = readFileSync(`${__dirname}/../[id]/CostPanel.tsx`, "utf8");
    const line = src.split("\n").find((l) => l.includes('type="datetime-local"'))!;
    expect(line).toContain("className={DATETIME_FOCUS}");
    expect(src.split("\n").filter((l) => l.includes("DATETIME_FOCUS")).length).toBe(2); // the definition and the one input
  });
});
