// OFFLINE, READ-ONLY: reconcile ONE native Cin7 CRM Opportunity from a LOCAL CSV export. No network call, no credentials, no Cin7 access.
//   npx tsx scripts/rwtsa-live/opportunity-reconcile.ts --file <export.csv> --number OP-00001 --source-ref Q-3007 --status LOST --customer "<name>" --rep "<rep>" --value-ex-tax 150000 --value-incl-tax 172500 --reason "<reason>" [--map field=Header ...]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { reconcileOpportunity, type OppField } from "../../src/rwtsa-live/opportunities";
import { writeTextAtomic } from "../../src/rwtsa-live/store";

const arg = (n: string): string | undefined => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const FIELDS: OppField[] = ["number", "status", "reference", "customer", "rep", "valueExTax", "valueInclTax"];

function main(): number {
  const file = arg("--file"), number = arg("--number"), ref = arg("--source-ref"), status = arg("--status"), customer = arg("--customer"), rep = arg("--rep"), reason = arg("--reason");
  const ex = Number(arg("--value-ex-tax")), inc = Number(arg("--value-incl-tax"));
  if (!file || !number || !ref || !status || !customer || !rep || !reason || !Number.isFinite(ex) || !Number.isFinite(inc)) { console.error("Usage: --file <csv> --number <OP> --source-ref <Q> --status <LOST> --customer <name> --rep <rep> --value-ex-tax <n> --value-incl-tax <n> --reason <text> [--map field=Header]"); return 2; }
  const mapping: Partial<Record<OppField, string>> = {};
  process.argv.forEach((a, i) => { if (a === "--map") { const m = /^(\w+)=(.+)$/.exec(process.argv[i + 1] ?? ""); if (m && (FIELDS as string[]).includes(m[1])) mapping[m[1] as OppField] = m[2]; } });
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { console.error("STOP: the export file could not be read."); return 1; }
  const e = reconcileOpportunity(text, { number, sourceReference: ref, status, customer, rep, valueExTax: ex, valueInclTax: inc, reason }, { mapping });
  const { file: out } = writeTextAtomic({ home: homedir(), name: `opportunity-evidence-${number}-${e.takenAt.replace(/[:.]/g, "-")}.json`, text: JSON.stringify(e, null, 2) });
  console.log(`OPPORTUNITY EXPORT RECONCILIATION (offline, no Cin7 call) · ${number} · ${e.verdict} · ${e.rowCount} row(s)`);
  e.columnIssues.forEach((c) => console.log(`  column issue: ${c}`));
  e.checks.forEach((c) => console.log(`  ${c.id}: ${c.status} · ${c.detail}`));
  console.log(`  written: ${out.split("/").pop()} (in ~/rwtsa-local/cin7-snapshots)`);
  return 0;
}
process.exit(main());
