// OWNER-TRIGGERED, READ-ONLY: verify ONE sales order on the DEDICATED RWTSA POC instance. Two GETs (sale list lookup, sale detail). No write, no third request.
//   npx tsx scripts/rwtsa-live/sale-inspect.ts --order SO-00001 --customer "<name>" --source-ref Q-3004 --lines 8 --total-ex-tax 58800 --i-confirm-read-only-inspection
import { homedir } from "node:os";
import { createReadOnlyClient } from "../../src/rwtsa-live/client";
import { inspectSale } from "../../src/rwtsa-live/sale";
import { loadRwtsaCredentials } from "../../src/rwtsa-live/credentials";
import { accountMatches, loadIdentityApproval } from "../../src/rwtsa-live/identity";
import { credentialsDir } from "../../src/rwtsa-live/setup-logic";
import { writeTextAtomic } from "../../src/rwtsa-live/store";
import { RwtsaLiveError } from "../../src/rwtsa-live/types";

const arg = (n: string): string | undefined => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };

async function main(): Promise<number> {
  const order = arg("--order"), customer = arg("--customer"), ref = arg("--source-ref"), lines = Number(arg("--lines")), total = Number(arg("--total-ex-tax"));
  const ok = order && /^[A-Za-z0-9-]{1,40}$/.test(order) && customer && customer.length <= 120 && ref && /^[A-Za-z0-9-]{1,40}$/.test(ref) && Number.isInteger(lines) && lines > 0 && Number.isFinite(total) && total > 0;
  if (!ok || !process.argv.includes("--i-confirm-read-only-inspection")) { console.error('Usage: --order <SO> --customer "<name>" --source-ref <Q> --lines <n> --total-ex-tax <amount> --i-confirm-read-only-inspection   (two GET requests, read-only, dedicated RWTSA instance)'); return 2; }
  const home = homedir();
  const creds = loadRwtsaCredentials({ home });
  const approval = loadIdentityApproval(credentialsDir(home));
  if (!accountMatches(creds.accountId, approval)) { console.error("STOP: the configured account does not match the owner-approved RWTSA identity. No request was made."); return 1; }
  const e = await inspectSale(createReadOnlyClient({ creds }), { orderNumber: order!, customer: customer!, sourceReference: ref!, lineCount: lines, totalExTax: total });
  const text = JSON.stringify(e, null, 2);
  const esc = (v: string) => JSON.stringify(v).slice(1, -1);
  if ([creds.accountId, creds.applicationKey].some((v) => text.includes(v) || text.includes(esc(v)))) throw new RwtsaLiveError("STORE", "Refusing to write: the evidence contains credential material.");
  const { file } = writeTextAtomic({ home, name: `sale-evidence-${order}-${e.takenAt.replace(/[:.]/g, "-")}.json`, text });
  console.log(`SALE EVIDENCE · ${e.requests} GET request(s) (${e.methodsUsed.join(",")}) · ${order} · ${e.verdict}`);
  e.checks.forEach((c) => console.log(`  ${c.id}: ${c.status} · ${c.detail}`));
  if (e.allocation) console.log(`  allocation: ${e.allocation.status} · backorder units ${e.allocation.backorderUnits ?? "unknown"}`);
  if (e.unverifiedReason) console.log(`  UNVERIFIED: ${e.unverifiedReason}`);
  console.log(`  written: ${file.split("/").pop()} (in ~/rwtsa-local/cin7-snapshots)`);
  return 0;
}
main().then((c) => process.exit(c), (e) => { console.error(e instanceof RwtsaLiveError ? `STOP: ${e.message}` : "STOP: the sale inspection failed (no detail printed)."); process.exit(1); });
