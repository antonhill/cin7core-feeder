// OWNER-TRIGGERED, READ-ONLY: is there a production BOM for ONE finished-good SKU on the DEDICATED RWTSA POC instance? Two GETs (product lookup, production BOM). No write, no third request.
//   npx tsx scripts/rwtsa-live/bom-inspect.ts --sku RVEST-2T-NVL-XL --i-confirm-read-only-inspection
import { homedir } from "node:os";
import { createReadOnlyClient } from "../../src/rwtsa-live/client";
import { inspectProductionBom } from "../../src/rwtsa-live/bom";
import { loadRwtsaCredentials } from "../../src/rwtsa-live/credentials";
import { accountMatches, loadIdentityApproval } from "../../src/rwtsa-live/identity";
import { credentialsDir } from "../../src/rwtsa-live/setup-logic";
import { writeTextAtomic } from "../../src/rwtsa-live/store";
import { RwtsaLiveError } from "../../src/rwtsa-live/types";

async function main(): Promise<number> {
  const i = process.argv.indexOf("--sku");
  const sku = i >= 0 ? process.argv[i + 1] : undefined;
  if (!sku || !/^[A-Za-z0-9-]{1,60}$/.test(sku) || !process.argv.includes("--i-confirm-read-only-inspection")) { console.error("Usage: --sku <SKU> --i-confirm-read-only-inspection   (two GET requests, read-only, dedicated RWTSA instance)"); return 2; }
  const home = homedir();
  const creds = loadRwtsaCredentials({ home });
  const approval = loadIdentityApproval(credentialsDir(home));
  if (!accountMatches(creds.accountId, approval)) { console.error("STOP: the configured account does not match the owner-approved RWTSA identity. No request was made."); return 1; }
  const e = await inspectProductionBom(createReadOnlyClient({ creds }), sku);
  const text = JSON.stringify(e, null, 2);
  const esc = (v: string) => JSON.stringify(v).slice(1, -1);
  if ([creds.accountId, creds.applicationKey].some((v) => text.includes(v) || text.includes(esc(v)))) throw new RwtsaLiveError("STORE", "Refusing to write: the evidence contains credential material.");
  const { file } = writeTextAtomic({ home, name: `bom-evidence-${sku}-${e.takenAt.replace(/[:.]/g, "-")}.json`, text });
  console.log(`BOM EVIDENCE · ${e.requests} GET request(s) (${e.methodsUsed.join(",")}) · ${sku} · ${e.status}`);
  e.versions.forEach((v, n) => console.log(`  version ${n + 1}: ${v.version ?? "(unnamed)"} · default ${v.isDefault ?? "unknown"} · operations ${v.operations ?? "not in response"} · components ${v.components ?? "not in response"}`));
  if (e.status === "UNVERIFIED") console.log(`  UNVERIFIED: ${e.unverifiedReason} · response top-level fields: ${e.responseTopLevelFields.join(", ") || "(none)"}`);
  console.log(`  written: ${file.split("/").pop()} (in ~/rwtsa-local/cin7-snapshots)`);
  return 0;
}
main().then((c) => process.exit(c), (e) => { console.error(e instanceof RwtsaLiveError ? `STOP: ${e.message}` : "STOP: the BOM inspection failed (no detail printed)."); process.exit(1); });
