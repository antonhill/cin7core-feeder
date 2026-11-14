import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendRegisterEvent, readRegister, registerFile } from "@/rwtsa-live/bond/register-store";
import type { ClearanceEntry, RegisterEvent } from "@/rwtsa-live/bond/engine";

const home = () => mkdtempSync(path.join(tmpdir(), "bond-home-"));
const entry = (o: Partial<ClearanceEntry> = {}): ClearanceEntry => ({ id: "CL-1", shipmentRef: "SHIP-A", clearanceRef: "BOE-1", clearanceDate: "2026-11-10", lines: [{ sku: "A", quantity: 100 }], attributedTo: "owner", provenance: "CUSTOMS_DOCUMENT", documentRef: "d", recordedOn: "2026-11-11", ...o });
const add = (o: Partial<ClearanceEntry> = {}): RegisterEvent => ({ type: "CLEARANCE_ADDED", entry: entry(o) });
const ver: RegisterEvent = { type: "CLEARANCE_VERIFIED", entryId: "CL-1", verifiedBy: "owner", verifiedOn: "2026-11-12", documentRef: "d" };
const T = { today: "2026-11-14", at: "2026-11-14T08:00:00.000Z" };

describe("clearance register store (append-only, hash-chained, owner-only)", () => {
  it("creates the directory 0700 and file 0600, and reads the events back in order", () => {
    const h = home();
    appendRegisterEvent({ home: h, event: add(), ...T });
    appendRegisterEvent({ home: h, event: ver, ...T });
    const f = registerFile(h);
    expect(statSync(path.dirname(f)).mode & 0o777).toBe(0o700);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    const r = readRegister({ home: h });
    expect(r.events.map((e) => e.type)).toEqual(["CLEARANCE_ADDED", "CLEARANCE_VERIFIED"]);
    expect(r.count).toBe(2);
    expect(r.tipHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("an empty or absent register reads as zero events", () => {
    expect(readRegister({ home: home() })).toMatchObject({ events: [], count: 0 });
  });
  it("validates each new event against the whole history and leaves the file untouched when it is invalid", () => {
    const h = home();
    appendRegisterEvent({ home: h, event: add({ provenance: "OWNER_STATEMENT" }), ...T });
    const before = readFileSync(registerFile(h), "utf8");
    expect(() => appendRegisterEvent({ home: h, event: ver, ...T })).toThrow(/owner statement/i);
    expect(() => appendRegisterEvent({ home: h, event: add({ provenance: "STOCK_TRANSFER" as never, id: "CL-2", clearanceRef: "BOE-2" }), ...T })).toThrow(/provenance/i);
    expect(readFileSync(registerFile(h), "utf8")).toBe(before);
  });
  it("detects an edited line, a deleted line and reordered lines (fail closed)", () => {
    const h = home();
    appendRegisterEvent({ home: h, event: add(), ...T });
    appendRegisterEvent({ home: h, event: ver, ...T });
    const f = registerFile(h), lines = readFileSync(f, "utf8").trimEnd().split("\n");
    writeFileSync(f, [lines[0].replace("100", "999"), lines[1]].join("\n") + "\n"); chmodSync(f, 0o600);
    expect(() => readRegister({ home: h })).toThrow(/integrity/i);
    writeFileSync(f, lines[1] + "\n"); chmodSync(f, 0o600);
    expect(() => readRegister({ home: h })).toThrow(/integrity/i);
    writeFileSync(f, [lines[1], lines[0]].join("\n") + "\n"); chmodSync(f, 0o600);
    expect(() => readRegister({ home: h })).toThrow(/integrity/i);
    expect(() => appendRegisterEvent({ home: h, event: add({ id: "CL-9", clearanceRef: "X" }), ...T })).toThrow(/integrity/i);
  });
  it("refuses a register directory inside a git working tree, a too-open file, and a symlinked file", () => {
    const g = home(); mkdirSync(path.join(g, ".git"));
    expect(() => appendRegisterEvent({ home: g, event: add(), ...T })).toThrow(/git/i);
    const h = home(); appendRegisterEvent({ home: h, event: add(), ...T });
    chmodSync(registerFile(h), 0o644);
    expect(() => readRegister({ home: h })).toThrow(/permission/i);
    const s = home(); mkdirSync(path.join(s, "rwtsa-local", "bond"), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(s, "real.jsonl"), ""); symlinkSync(path.join(s, "real.jsonl"), registerFile(s));
    expect(() => readRegister({ home: s })).toThrow(/symlink|regular/i);
  });
  it("a line that is not valid JSON or has an unknown shape is an integrity failure, not a skipped line", () => {
    const h = home(); appendRegisterEvent({ home: h, event: add(), ...T });
    const f = registerFile(h); writeFileSync(f, readFileSync(f, "utf8") + "not json\n"); chmodSync(f, 0o600);
    expect(() => readRegister({ home: h })).toThrow(/integrity/i);
    expect(existsSync(f)).toBe(true);
  });
  it("detects a forged line whose own hash was recomputed (the chain link to the next line breaks)", () => {
    const h = home();
    appendRegisterEvent({ home: h, event: add(), ...T });
    appendRegisterEvent({ home: h, event: ver, ...T });
    const f = registerFile(h), lines = readFileSync(f, "utf8").trimEnd().split("\n");
    const l0 = JSON.parse(lines[0]); l0.event.entry.lines[0].quantity = 999;
    l0.hash = createHash("sha256").update(JSON.stringify({ seq: l0.seq, at: l0.at, prevHash: l0.prevHash, event: l0.event })).digest("hex");
    writeFileSync(f, [JSON.stringify(l0), lines[1]].join("\n") + "\n"); chmodSync(f, 0o600);
    expect(() => readRegister({ home: h })).toThrow(/integrity/i);
  });
});
