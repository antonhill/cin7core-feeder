import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import synthetic from "@/rwtsa-demo/fixtures/bond-report.synthetic.json";
import { validateBondReport, type BondReportData } from "./report-schema";

/** Largest report the dashboard will open (a resource guard; real reports are tens of KB). */
export const MAX_BOND_REPORT_BYTES = 5 * 1024 * 1024;

export interface BondConfig { /** "synthetic" selects the built-in invented example. Anything else non-empty is refused. */ source?: string; /** An owner-selected local report file. Wins over `source`; never falls back to the example. */ path?: string }
export type BondLoad = { kind: "NO_DATA" } | { kind: "INVALID"; problems: string[] } | { kind: "OK"; report: BondReportData };
const invalid = (...problems: string[]): BondLoad => ({ kind: "INVALID", problems });

/** The report must be a real file outside EVERY git working tree (same rule as the protected workbook). Messages never contain the path. */
function readReportFile(file: string): { ok: true; text: string } | { ok: false; problem: string } {
  let real: string;
  try { real = realpathSync(path.resolve(file)); } catch { return { ok: false, problem: "The report file does not exist or cannot be read." }; }
  let stat;
  try { stat = statSync(real); } catch { return { ok: false, problem: "The report file cannot be read." }; }
  if (!stat.isFile()) return { ok: false, problem: "The report path is not a regular file." };
  if (stat.size > MAX_BOND_REPORT_BYTES) return { ok: false, problem: "The report file is larger than the dashboard's size limit." };
  for (let dir = path.dirname(real); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ".git"))) return { ok: false, problem: "Refusing to read a report inside a git working tree. Keep reports outside every repository." };
    if (path.dirname(dir) === dir) break;
  }
  try { return { ok: true, text: readFileSync(real, "utf8") }; } catch { return { ok: false, problem: "The report file cannot be read." }; }
}

export async function loadBondReport(cfg: BondConfig): Promise<BondLoad> {
  const file = cfg.path?.trim();
  if (file) {
    const read = readReportFile(file);
    if (!read.ok) return invalid(read.problem);
    let json: unknown;
    try { json = JSON.parse(read.text); } catch { return invalid("The report file is not valid JSON."); }
    const v = validateBondReport(json);
    return v.ok ? { kind: "OK", report: v.report } : invalid(...v.problems);
  }
  const source = cfg.source?.trim();
  if (!source) return { kind: "NO_DATA" };
  if (source !== "synthetic") return invalid('RWTSA_BOND_SOURCE must be "synthetic" or unset.');
  const v = validateBondReport(synthetic);
  return v.ok ? { kind: "OK", report: v.report } : invalid(...v.problems);
}
