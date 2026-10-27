import type { PriceSnapshot } from "../workbook-price-source";
import raw from "./newquip-master-poc.snapshot.json";

/** The committed POC price snapshot (generated from the Master workbook by scripts/newquip-build-price-snapshot.ts). */
export const NEWQUIP_MASTER_POC_SNAPSHOT: PriceSnapshot = raw as PriceSnapshot;
