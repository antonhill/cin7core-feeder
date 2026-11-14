/* eslint-disable @typescript-eslint/no-explicit-any -- test fixtures mutate loosely-typed JSON on purpose */import synthetic from "@/rwtsa-demo/fixtures/bond-report.synthetic.json";

/** The synthetic report relabelled the way a REAL one would look: real-style identifiers, real data class. Used to exercise the real path without real data. */
export function realStyleReport(): Record<string, any> {
  const text = JSON.stringify(synthetic).replace(/SYN-/g, "").replace(/SYNTHETIC-SNAPSHOT-/g, "snap-").replace(/synthetic-owner/g, "owner").replace(/synthetic: /g, "");
  const r = JSON.parse(text);
  r.dataClass = "REAL_CIN7_SNAPSHOT"; r.snapshotHash = "9f".repeat(32); r.previousSnapshotHash = "8e".repeat(32); r.registerTipHash = "7d".repeat(32);
  r.statements = r.statements.filter((s: string) => !/synthetic/i.test(s));
  return r;
}
