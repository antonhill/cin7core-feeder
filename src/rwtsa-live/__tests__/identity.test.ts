import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { computeFingerprint, loadIdentityApproval, verifyIdentity } from "@/rwtsa-live/identity";
import { ACCOUNT, FP_LOCS, G, LOC, makeHome } from "./helpers";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ids = FP_LOCS.map((l) => l.ID);
const writeIdentity = (dir: string, body: unknown, mode = 0o600) => { const f = path.join(dir, "identity.json"); writeFileSync(f, JSON.stringify(body), { mode }); chmodSync(f, mode); };

describe("RWTSA account identity (fails closed; not a label)", () => {
  it("fingerprints the SET of location IDs: order- and case-independent, sensitive to any added or removed location", () => {
    const f = computeFingerprint(ids);
    expect(computeFingerprint([...ids].reverse().map((i) => i.toUpperCase()))).toBe(f);
    expect(computeFingerprint([...ids, G(99)])).not.toBe(f);
    expect(computeFingerprint(ids.slice(1))).not.toBe(f);
  });
  it("the fingerprint encoding is unambiguous: IDs containing the separator cannot collide", () => {
    expect(computeFingerprint(["a,b", "c"])).not.toBe(computeFingerprint(["a", "b,c"]));
    expect(computeFingerprint(["ab", "c"])).not.toBe(computeFingerprint(["a", "bc"]));
  });
  it("VERIFIED only when the account ID hash AND the approved fingerprint both match", () => {
    const a = { accountIdSha256: sha(ACCOUNT), approvedFingerprint: computeFingerprint(ids) };
    expect(verifyIdentity({ accountId: ACCOUNT, approval: a, locationIds: ids }).status).toBe("VERIFIED");
  });
  it("a different account ID is ACCOUNT_MISMATCH even if the fingerprint matches", () => {
    const a = { accountIdSha256: sha(ACCOUNT), approvedFingerprint: computeFingerprint(ids) };
    expect(verifyIdentity({ accountId: "someone-else", approval: a, locationIds: ids }).status).toBe("ACCOUNT_MISMATCH");
  });
  it("a different instance (other location IDs) is FINGERPRINT_MISMATCH even with the right account ID", () => {
    const a = { accountIdSha256: sha(ACCOUNT), approvedFingerprint: computeFingerprint(ids) };
    expect(verifyIdentity({ accountId: ACCOUNT, approval: a, locationIds: [G(70), G(71)] }).status).toBe("FINGERPRINT_MISMATCH");
  });
  it("no owner-approved fingerprint yet is NOT_APPROVED (never trust-on-first-use), and reports the fingerprint to approve", () => {
    const r = verifyIdentity({ accountId: ACCOUNT, approval: { accountIdSha256: sha(ACCOUNT) }, locationIds: ids });
    expect(r.status).toBe("NOT_APPROVED"); expect(r.fingerprint).toBe(computeFingerprint(ids));
  });
  it("an empty location list can never verify", () => {
    expect(verifyIdentity({ accountId: ACCOUNT, approval: { accountIdSha256: sha(ACCOUNT), approvedFingerprint: computeFingerprint([]) }, locationIds: [] }).status).not.toBe("VERIFIED");
  });
  it("the approval file follows the private-file rules and allows only its two keys", () => {
    const { dir } = makeHome();
    writeIdentity(dir, { accountIdSha256: sha(ACCOUNT), approvedFingerprint: "a".repeat(64) });
    expect(loadIdentityApproval(dir).approvedFingerprint).toBe("a".repeat(64));
    writeIdentity(dir, { accountIdSha256: sha(ACCOUNT), instanceLabel: "x" }); expect(() => loadIdentityApproval(dir)).toThrow(/not allowed/i);
    writeIdentity(dir, { accountIdSha256: "short" }); expect(() => loadIdentityApproval(dir)).toThrow();
    writeIdentity(dir, { accountIdSha256: sha(ACCOUNT) }, 0o644); expect(() => loadIdentityApproval(dir)).toThrow(/permission/i);
  });
  it("a missing identity file is an error that tells the owner what to create (fail closed)", () => {
    const other = mkdtempSync(path.join(tmpdir(), "x-")); void other;
    const { dir } = makeHome(); expect(() => loadIdentityApproval(dir)).toThrow(/identity\.json/);
  });
  it("the location map's Bond ID must be one of the fingerprinted locations", () => {
    expect(ids).toContain(LOC.BOND);
  });
});
