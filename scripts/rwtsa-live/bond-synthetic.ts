// Writes the invented Bond demonstration report to ~/rwtsa-local/bond-synthetic/ (separate from the real register and reports). OFFLINE: no network, no Cin7, no real data.
//   npx tsx scripts/rwtsa-live/bond-synthetic.ts
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { buildSyntheticBondReport, SYNTHETIC_REPORT_FILE_NAME } from "../../src/rwtsa-live/bond/synthetic-demo";

const dir = path.join(homedir(), "rwtsa-local", "bond-synthetic");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = path.join(dir, SYNTHETIC_REPORT_FILE_NAME);
writeFileSync(file, JSON.stringify(buildSyntheticBondReport(), null, 2) + "\n", { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`Wrote the SYNTHETIC Bond demonstration report: ${SYNTHETIC_REPORT_FILE_NAME} (in ~/rwtsa-local/bond-synthetic). Invented data; not a real customs event.`);
