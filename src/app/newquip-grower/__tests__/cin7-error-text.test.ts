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
