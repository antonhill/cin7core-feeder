// OWNER-TRIGGERED, READ-ONLY Cin7 snapshot of the dedicated RWTSA instance.
//
//   npx tsx scripts/rwtsa-live/snapshot.ts --i-confirm-read-only-snapshot
//
// - Does nothing (and makes no network call) without the explicit confirmation flag.
// - Credentials: ~/rwtsa-local/credentials/cin7.env only (owner-only permissions; see src/rwtsa-live/README.md).
// - GET only, three allowlisted resources, the fixed Cin7 origin. No polling, no background work, no write of any kind.
// - Output: ~/rwtsa-local/cin7-snapshots/snapshot-<time>.json (atomic, 0600, never overwritten, no credentials inside).
// - Terminal output is counts and codes only: no SKU, location name, quantity, credential or response body.
import { homedir } from "node:os";
import path from "node:path";
import { createReadOnlyClient } from "../../src/rwtsa-live/client";
import { loadLocationMap, loadRwtsaCredentials } from "../../src/rwtsa-live/credentials";
import { loadIdentityApproval } from "../../src/rwtsa-live/identity";
import { runSnapshot } from "../../src/rwtsa-live/run";
import { writeSnapshotAtomic, writeTextAtomic } from "../../src/rwtsa-live/store";
import { RwtsaLiveError } from "../../src/rwtsa-live/types";

async function main(): Promise<number> {
  if (!process.argv.includes("--i-confirm-read-only-snapshot")) {
    console.error("Refusing to run: pass --i-confirm-read-only-snapshot to confirm this read-only snapshot of the RWTSA Cin7 instance.");
    return 2;
  }
  const home = homedir();
  const creds = loadRwtsaCredentials({ home });
  const credDir = path.join(home, "rwtsa-local", "credentials");
  const locationMap = loadLocationMap(credDir);
  const approval = loadIdentityApproval(credDir);
  const client = createReadOnlyClient({ creds });
  const takenAt = new Date().toISOString();

  let result;
  try {
    result = await runSnapshot({ client, creds, locationMap, approval, takenAt });
  } catch (e) {
    if (e instanceof RwtsaLiveError) {
      const ev = { takenAt, code: e.code, status: e.status ?? null, requests: client.requests(), methodsUsed: client.methodsUsed(), stockRead: false };
      const { file: f } = writeTextAtomic({ name: `run-failure-${takenAt.replace(/[:.]/g, "-")}.json`, text: JSON.stringify(ev, null, 2) });
      console.log(`  evidence preserved: ${path.basename(f)} (in ~/rwtsa-local/cin7-snapshots)`);
    }
    throw e;
  }
  if (result.kind === "IDENTITY_FAILED") {
    const evidence = result.evidence, identity = evidence.identity;
    const { file: ev } = writeTextAtomic({ name: `identity-check-${takenAt.replace(/[:.]/g, "-")}.json`, text: JSON.stringify(evidence, null, 2) });
    console.log(`IDENTITY NOT VERIFIED (${identity.status}${evidence.locationsComplete ? "" : ", location list incomplete"}) · ${identity.locationCount} locations · no stock was read · ${client.requests()} GET request(s)`);
    if (identity.status === "NOT_APPROVED") console.log(`  OWNER CONFIRMATION NEEDED: if this is the intended RWTSA instance, add "approvedFingerprint": "${identity.fingerprint}" to ~/rwtsa-local/credentials/identity.json and re-run.`);
    if (identity.status === "ACCOUNT_MISMATCH") console.log("  The configured account ID does not match the owner-approved hash in identity.json. Check you are using the RWTSA credentials.");
    if (identity.status === "FINGERPRINT_MISMATCH") console.log("  This account's locations differ from the owner-approved fingerprint: this may not be the RWTSA instance. Nothing was read beyond the location list.");
    console.log(`  evidence preserved: ${path.basename(ev)} (in ~/rwtsa-local/cin7-snapshots)`);
    return 1;
  }
  const snapshot = result.snapshot;
  const identity = snapshot.source.identity;
  const { file } = writeSnapshotAtomic({ home, snapshot, creds });
  console.log(`SNAPSHOT ${snapshot.completeness.status} · identity ${identity.status} · methods ${client.methodsUsed().join(",")} · ${snapshot.counts.skus} SKUs · ${snapshot.counts.availabilityRows} stock rows · ${snapshot.counts.locations} locations · ${snapshot.counts.products} products · ${client.requests()} GET requests`);
  console.log(`  Bond location ID verified in the account's location list: ${snapshot.locationMapping.bond.verifiedInLocationList ? "yes" : "NO"} · locations outside the five roles: ${snapshot.locationMapping.unmappedLocationCount}`);
  for (const p of snapshot.completeness.problems) console.log(`  problem: ${p}`);
  console.log(`  written: ${path.basename(file)} (in ~/rwtsa-local/cin7-snapshots)`);
  return snapshot.completeness.status === "COMPLETE" ? 0 : 1;
}

main().then((c) => process.exit(c), (e) => {
  console.error(e instanceof RwtsaLiveError ? `FAILED [${e.code}] ${e.message}` : "FAILED: unexpected error (details withheld).");
  process.exit(1);
});
