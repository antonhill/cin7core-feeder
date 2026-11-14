// OWNER-TRIGGERED, READ-ONLY evidence for ONE manufacture order on the DEDICATED RWTSA POC instance: three GETs (order list, order, run). No write, no fourth request.
//
//   npx tsx scripts/rwtsa-live/production-inspect.ts --order MO-00001 --i-confirm-read-only-inspection
//
// Writes a protected (0600, never overwritten, outside git) evidence file under ~/rwtsa-local/cin7-snapshots/ and prints verdict labels and counts only (no SKU, quantity or cost).
// Planned or plan-equal actual quantities are NEVER reported as proof of consumption: the Inventory Movement Details export stays required unless the run view proves otherwise.
import { homedir } from "node:os";
import path from "node:path";
import { createReadOnlyClient } from "../../src/rwtsa-live/client";
import { loadRwtsaCredentials } from "../../src/rwtsa-live/credentials";
import { accountMatches, loadIdentityApproval } from "../../src/rwtsa-live/identity";
import { inspectProductionOrder } from "../../src/rwtsa-live/production";
import { credentialsDir } from "../../src/rwtsa-live/setup-logic";
import { writeTextAtomic } from "../../src/rwtsa-live/store";
import { RwtsaLiveError } from "../../src/rwtsa-live/types";

const arg = (n: string): string | undefined => { const i = process.argv.indexOf(`--${n}`); const v = i >= 0 ? process.argv[i + 1] : undefined; if (i >= 0 && (!v || v.startsWith("--"))) throw new Error(`--${n} requires a value`); return v; };

async function main(): Promise<number> {
  const order = arg("order");
  if (!order || !/^[A-Za-z0-9-]{1,40}$/.test(order) || !process.argv.includes("--i-confirm-read-only-inspection")) {
    console.error("Usage: --order <order number> --i-confirm-read-only-inspection   (up to three GET requests, read-only, dedicated RWTSA instance)");
    return 2;
  }
  const home = homedir();
  const creds = loadRwtsaCredentials({ home });
  const approval = loadIdentityApproval(credentialsDir(home));
  if (!accountMatches(creds.accountId, approval)) { console.error("STOP: the configured account does not match the owner-approved RWTSA identity. No request was made."); return 1; }
  const client = createReadOnlyClient({ creds });
  const e = await inspectProductionOrder(client, order);
  const text = JSON.stringify(e, null, 2);
  const esc = (v: string) => JSON.stringify(v).slice(1, -1);
  if ([creds.accountId, creds.applicationKey].some((v) => text.includes(v) || text.includes(esc(v)))) throw new RwtsaLiveError("STORE", "Refusing to write: the evidence contains credential material.");
  const { file } = writeTextAtomic({ home, name: `production-evidence-${order}-${e.takenAt.replace(/[:.]/g, "-")}.json`, text });
  const v = e.verdicts;
  console.log(`PRODUCTION EVIDENCE · ${e.requests} GET request(s) (${e.methodsUsed.join(",")}) · order status ${v.orderStatus.status}`);
  console.log(`  consumption : ${v.consumption.status} (movement export still required: ${v.consumption.movementExportStillRequired}) · planned components missing from run: ${v.consumption.plannedComponentsMissingFromRun.length}`);
  console.log(`  receipt     : ${v.receipt.status} · ${v.receipt.receivedLines} of ${v.receipt.outputLines} output line(s) received`);
  console.log(`  times       : ${v.operationTimes.status} · labour cost: ${v.labourCost.status}`);
  e.findings.forEach((f) => console.log(`  finding     : ${f}`));
  console.log(`  written: ${path.basename(file)} (in ~/rwtsa-local/cin7-snapshots)`);
  return 0;
}
main().then((c) => process.exit(c), (err) => { console.error(err instanceof RwtsaLiveError ? `FAILED [${err.code}] ${err.message}` : "FAILED (details withheld)."); process.exit(1); });
