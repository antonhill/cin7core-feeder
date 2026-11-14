// Phase 2 S2 owner CLI: the clearance register and Bond report. OFFLINE: reads local files only, never calls Cin7, Xero or Supabase, and never writes
// a Cin7 transaction. Run `npx tsx scripts/rwtsa-live/bond.ts` with no arguments for usage. See src/rwtsa-live/README.md.
import { homedir } from "node:os";
import { runBondCli } from "../../src/rwtsa-live/bond/cli";

const now = new Date().toISOString();
const r = runBondCli(process.argv.slice(2), { home: homedir(), today: now.slice(0, 10), now });
r.lines.forEach((l) => console.log(l));
process.exit(r.code);
