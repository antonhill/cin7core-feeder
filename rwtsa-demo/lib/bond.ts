import { loadBondReport, type BondConfig, type BondLoad } from "@/rwtsa-demo/bond/load";

/** Reads the two RWTSA_BOND_* variables (the only configuration the Bond page uses). Loaded per request; nothing is cached or written. */
export function bondConfigFromEnv(): BondConfig {
  return { source: process.env.RWTSA_BOND_SOURCE, path: process.env.RWTSA_BOND_REPORT_PATH };
}
export function getBondReport(config: BondConfig = bondConfigFromEnv()): Promise<BondLoad> {
  return loadBondReport(config);
}
