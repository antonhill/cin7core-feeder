import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPrompter } from "@/rwtsa-live/prompt";
import { proposeLocationMap, writeInitialCredentials, recordApprovedFingerprint, writeLocationMap } from "@/rwtsa-live/setup-logic";
import { loadIdentityApproval } from "@/rwtsa-live/identity";
import { loadLocationMap, loadRwtsaCredentials } from "@/rwtsa-live/credentials";
import { ACCOUNT, APPKEY, G, LOC } from "./helpers";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const tmpHome = () => mkdtempSync(path.join(tmpdir(), "rwtsa-setup-"));
const mode = (f: string) => statSync(f).mode & 0o777;

describe("secure prompting", () => {
  const mk = () => { const input = new PassThrough(); const output = new PassThrough(); const chunks: string[] = []; output.on("data", (d) => chunks.push(String(d))); return { input, output, out: () => chunks.join(""), p: createPrompter({ input: input as never, output: output as never, allowNonTty: true }) }; };
  it("a hidden answer is read without being echoed to the output", async () => {
    const { input, out, p } = mk();
    const answer = p.askHidden("Application Key: "); input.write("sup3r-SECRET-key\n");
    expect(await answer).toBe("sup3r-SECRET-key");
    expect(out()).toContain("Application Key: "); expect(out()).not.toContain("sup3r"); expect(out()).not.toContain("SECRET");
  });
  it("hidden input honours backspace and rejects on Ctrl-C", async () => {
    const { input, p } = mk(); const a = p.askHidden("k: "); input.write("abcX\u007f\n"); expect(await a).toBe("abc");
    const { input: i2, p: p2 } = mk(); const b = p2.askHidden("k: "); i2.write("ab\u0003"); await expect(b).rejects.toThrow(/cancel/i);
  });
  it("a visible answer and yes/no confirmations work; anything but an explicit yes is no", async () => {
    const { input, p } = mk();
    const a = p.ask("label: "); input.write("rwtsa-demo\n"); expect(await a).toBe("rwtsa-demo");
    for (const [typed, want] of [["y\n", true], ["yes\n", true], ["Y\n", true], ["\n", false], ["no\n", false], ["maybe\n", false]] as const) { const c = p.confirm("ok? "); input.write(typed); expect(await c, typed).toBe(want); }
  });
  it("refuses to prompt for secrets on a non-interactive input (no piped secrets)", async () => {
    const input = new PassThrough(); const output = new PassThrough();
    const p = createPrompter({ input: input as never, output: output as never });
    await expect(p.askHidden("k: ")).rejects.toThrow(/interactive terminal/i);
  });
});

describe("credential files are created private and the identity hash is derived", () => {
  it("creates dir 700 and cin7.env + identity.json 600; identity holds only the account hash; the files load back through the real loaders", () => {
    const home = tmpHome();
    writeInitialCredentials({ home, accountId: ACCOUNT, applicationKey: APPKEY, instanceLabel: "rwtsa-demo-instance", replace: false });
    const dir = path.join(home, "rwtsa-local", "credentials");
    expect(mode(dir)).toBe(0o700); expect(mode(path.join(dir, "cin7.env"))).toBe(0o600); expect(mode(path.join(dir, "identity.json"))).toBe(0o600);
    expect(loadRwtsaCredentials({ home })).toEqual({ accountId: ACCOUNT, applicationKey: APPKEY, instanceLabel: "rwtsa-demo-instance" });
    const id = loadIdentityApproval(dir); expect(id).toEqual({ accountIdSha256: sha(ACCOUNT) });
    expect(readFileSync(path.join(dir, "identity.json"), "utf8")).not.toContain(ACCOUNT);
  });
  it("refuses to overwrite existing credentials unless replace is explicit, and never leaves a temp file", () => {
    const home = tmpHome(); writeInitialCredentials({ home, accountId: ACCOUNT, applicationKey: APPKEY, instanceLabel: "x", replace: false });
    expect(() => writeInitialCredentials({ home, accountId: "other", applicationKey: APPKEY, instanceLabel: "x", replace: false })).toThrow(/already exist/i);
    writeInitialCredentials({ home, accountId: "other", applicationKey: APPKEY, instanceLabel: "x", replace: true });
    expect(loadRwtsaCredentials({ home }).accountId).toBe("other");
    expect(readdirSync(path.join(home, "rwtsa-local", "credentials")).filter((n: string) => n.includes(".tmp"))).toEqual([]);
  });
  it("rejects an empty or whitespace-only account ID or key, and values containing a newline", () => {
    const home = tmpHome();
    for (const [a, k] of [["", APPKEY], [ACCOUNT, "  "], ["a\nb", APPKEY], [ACCOUNT, "k\r\nx"]]) expect(() => writeInitialCredentials({ home, accountId: a, applicationKey: k, instanceLabel: "x", replace: false })).toThrow();
  });
  it("refuses a home inside a git working tree", () => {
    const home = tmpHome(); mkdirSync(path.join(home, ".git"));
    expect(() => writeInitialCredentials({ home, accountId: ACCOUNT, applicationKey: APPKEY, instanceLabel: "x", replace: false })).toThrow(/git/i);
  });
  it("records the owner-approved fingerprint only after the file exists, keeping the account hash and 0600", () => {
    const home = tmpHome(); writeInitialCredentials({ home, accountId: ACCOUNT, applicationKey: APPKEY, instanceLabel: "x", replace: false });
    const dir = path.join(home, "rwtsa-local", "credentials");
    recordApprovedFingerprint({ home, fingerprint: "a".repeat(64) });
    expect(loadIdentityApproval(dir)).toEqual({ accountIdSha256: sha(ACCOUNT), approvedFingerprint: "a".repeat(64) }); expect(mode(path.join(dir, "identity.json"))).toBe(0o600);
    expect(() => recordApprovedFingerprint({ home, fingerprint: "nothex" })).toThrow();
  });
  it("writes locations.json 0600 that the real loader accepts, and rejects incomplete or duplicate maps", () => {
    const home = tmpHome(); writeInitialCredentials({ home, accountId: ACCOUNT, applicationKey: APPKEY, instanceLabel: "x", replace: false });
    writeLocationMap({ home, map: LOC });
    const dir = path.join(home, "rwtsa-local", "credentials"); expect(loadLocationMap(dir)).toEqual(LOC); expect(mode(path.join(dir, "locations.json"))).toBe(0o600);
    expect(() => writeLocationMap({ home, map: { ...LOC, DURBAN: LOC.JHB } })).toThrow();
    expect(() => writeLocationMap({ home, map: { JHB: LOC.JHB } as never })).toThrow();
  });
  it("never writes a credential into locations.json or identity.json", () => {
    const home = tmpHome(); writeInitialCredentials({ home, accountId: ACCOUNT, applicationKey: APPKEY, instanceLabel: "x", replace: false }); writeLocationMap({ home, map: LOC });
    const dir = path.join(home, "rwtsa-local", "credentials");
    for (const f of ["identity.json", "locations.json"]) { const t = readFileSync(path.join(dir, f), "utf8"); expect(t).not.toContain(ACCOUNT); expect(t).not.toContain(APPKEY); }
    void existsSync; void writeFileSync;
  });
});

describe("location mapping is proposed from the real API results and never silently guessed", () => {
  const L = (id: number, name: string) => ({ id: G(id), name });
  it("proposes each role only on an exact (case/space-insensitive) name match with exactly one location", () => {
    const r = proposeLocationMap([L(1, "JHB"), L(2, " durban "), L(3, "Cape Town"), L(4, "FACTORY STORE"), L(5, "Bond")]);
    expect(r.ambiguous).toEqual([]); expect(r.unmatched).toEqual([]);
    expect(Object.fromEntries(Object.entries(r.proposed).map(([k, v]) => [k, v!.id]))).toEqual({ JHB: G(1), DURBAN: G(2), CAPE_TOWN: G(3), FACTORY_STORE: G(4), BOND: G(5) });
  });
  it("flags a role as AMBIGUOUS when two locations match it, and does not pick one", () => {
    const r = proposeLocationMap([L(1, "JHB"), L(2, "Durban"), L(3, "Cape Town"), L(4, "Factory Store"), L(5, "Bond"), L(6, "bond")]);
    expect(r.ambiguous).toEqual(["BOND"]); expect(r.proposed.BOND).toBeUndefined(); expect(r.candidates.BOND.map((c) => c.id).sort()).toEqual([G(5), G(6)].sort());
  });
  it("flags a role as UNMATCHED when nothing matches, and one location can never serve two roles", () => {
    const r = proposeLocationMap([L(1, "JHB"), L(2, "Durban")]);
    expect(r.unmatched.sort()).toEqual(["BOND", "CAPE_TOWN", "FACTORY_STORE"]);
    const dup = proposeLocationMap([L(1, "Bond"), L(1, "Bond")]); expect(dup.proposed.BOND).toBeUndefined(); expect(dup.ambiguous).toContain("BOND");
  });
  it("does not treat a near-miss such as 'Bonded Stock - Old' as Bond", () => {
    const r = proposeLocationMap([L(1, "Bonded Stock - Old")]); expect(r.proposed.BOND).toBeUndefined(); expect(r.unmatched).toContain("BOND");
  });
});
