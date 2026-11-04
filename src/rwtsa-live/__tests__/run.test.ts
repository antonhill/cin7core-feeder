import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createReadOnlyClient } from "@/rwtsa-live/client";
import { computeFingerprint } from "@/rwtsa-live/identity";
import { runSnapshot } from "@/rwtsa-live/run";
import { ACCOUNT, APPKEY, FP_LOCS, LOC, fakeFetch, noSleep } from "./helpers";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const creds = { accountId: ACCOUNT, applicationKey: APPKEY, instanceLabel: "i" };
const good = { accountIdSha256: sha(ACCOUNT), approvedFingerprint: computeFingerprint(FP_LOCS.map((l) => l.ID)) };
const av = (sku: string, Location: string, OnHand: number) => ({ SKU: sku, Location, OnHand, Allocated: 0, Available: OnHand, OnOrder: 0, InTransit: 0 });
const setup = () => {
  const f = fakeFetch({
    "/ref/location": () => ({ body: { Total: 5, LocationList: FP_LOCS } }),
    "/ref/productavailability": () => ({ body: { Total: 2, ProductAvailabilityList: [av("A", "JHB", 3), av("A", "Bond", 4)] } }),
    "/product": () => ({ body: { Total: 1, Products: [{ ID: "1", SKU: "A" }] } }),
  });
  const client = createReadOnlyClient({ creds, fetchImpl: f.impl, sleep: noSleep, now: () => 0, minIntervalMs: 0 });
  return { f, client };
};
const paths = (calls: { url: string }[]) => calls.map((c) => new URL(c.url).pathname.replace("/ExternalApi/v2", ""));

describe("owner-triggered snapshot run: identity before stock", () => {
  it("reads locations first and, when the identity is verified, builds a COMPLETE snapshot using GET only", async () => {
    const { f, client } = setup();
    const r = await runSnapshot({ client, creds, locationMap: LOC, approval: good, takenAt: "2026-11-04T10:00:00.000Z" });
    expect(r.kind).toBe("SNAPSHOT"); if (r.kind !== "SNAPSHOT") return;
    expect(paths(f.calls)[0]).toBe("/ref/location"); expect(r.snapshot.completeness.status).toBe("COMPLETE");
    expect(r.snapshot.verification.methodsUsed).toEqual(["GET"]); expect(new Set(f.calls.map((c) => c.method))).toEqual(new Set(["GET"]));
  });
  it.each([
    ["no approved fingerprint (NOT_APPROVED)", { accountIdSha256: sha(ACCOUNT) }],
    ["wrong approved fingerprint (FINGERPRINT_MISMATCH)", { accountIdSha256: sha(ACCOUNT), approvedFingerprint: "0".repeat(64) }],
    ["wrong account hash (ACCOUNT_MISMATCH)", { accountIdSha256: sha("other"), approvedFingerprint: good.approvedFingerprint }],
  ])("%s: stops after the location list; stock and product endpoints are never called", async (_n, approval) => {
    const { f, client } = setup();
    const r = await runSnapshot({ client, creds, locationMap: LOC, approval, takenAt: "2026-11-04T10:00:00.000Z" });
    expect(r.kind).toBe("IDENTITY_FAILED");
    expect(paths(f.calls)).toEqual(["/ref/location"]);
    if (r.kind === "IDENTITY_FAILED") { expect(r.evidence.stockRead).toBe(false); expect(JSON.stringify(r.evidence)).not.toContain(ACCOUNT); expect(JSON.stringify(r.evidence)).not.toContain("JHB"); }
  });
  it("an incomplete location list never verifies identity, even with a matching fingerprint", async () => {
    const f = fakeFetch({ "/ref/location": () => ({ body: { LocationList: FP_LOCS } }) }); // no Total
    const client = createReadOnlyClient({ creds, fetchImpl: f.impl, sleep: noSleep, now: () => 0, minIntervalMs: 0 });
    const r = await runSnapshot({ client, creds, locationMap: LOC, approval: good, takenAt: "2026-11-04T10:00:00.000Z" });
    expect(r.kind).toBe("IDENTITY_FAILED"); expect(paths(f.calls)).toEqual(["/ref/location"]);
  });
});
