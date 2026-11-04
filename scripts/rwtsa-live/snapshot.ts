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
import { collectAvailability, collectLocations, collectProducts } from "../../src/rwtsa-live/collect";
import { loadLocationMap, loadRwtsaCredentials } from "../../src/rwtsa-live/credentials";
import { buildSnapshot } from "../../src/rwtsa-live/snapshot";
import { writeSnapshotAtomic } from "../../src/rwtsa-live/store";
import { RwtsaLiveError } from "../../src/rwtsa-live/types";

async function main(): Promise<number> {
  if (!process.argv.includes("--i-confirm-read-only-snapshot")) {
    console.error("Refusing to run: pass --i-confirm-read-only-snapshot to confirm this read-only snapshot of the RWTSA Cin7 instance.");
    return 2;
  }
  const home = homedir();
  const creds = loadRwtsaCredentials({ home });
  const locationMap = loadLocationMap(path.join(home, "rwtsa-local", "credentials"));
  const client = createReadOnlyClient({ creds });
  const locations = await collectLocations(client);
  const availability = await collectAvailability(client);
  const products = await collectProducts(client);
  const snapshot = buildSnapshot({ creds, locationMap, locations, availability, products, takenAt: new Date().toISOString() });
  const { file } = writeSnapshotAtomic({ home, snapshot, creds });
  console.log(`SNAPSHOT ${snapshot.completeness.status} · ${snapshot.counts.skus} SKUs · ${snapshot.counts.availabilityRows} stock rows · ${snapshot.counts.locations} locations · ${snapshot.counts.products} products · ${client.requests()} GET requests`);
  console.log(`  Bond location ID verified in the account's location list: ${snapshot.locationMapping.bond.verifiedInLocationList ? "yes" : "NO"} · locations outside the five roles: ${snapshot.locationMapping.unmappedLocationCount}`);
  for (const p of snapshot.completeness.problems) console.log(`  problem: ${p}`);
  console.log(`  written: ${path.basename(file)} (in ~/rwtsa-local/cin7-snapshots)`);
  return snapshot.completeness.status === "COMPLETE" ? 0 : 1;
}

main().then((c) => process.exit(c), (e) => {
  console.error(e instanceof RwtsaLiveError ? `FAILED [${e.code}] ${e.message}` : "FAILED: unexpected error (details withheld).");
  process.exit(1);
});
