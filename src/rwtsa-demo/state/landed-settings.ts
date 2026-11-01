import { DEFAULT_AS_AT, type ExposureBucket } from "@/rwtsa-demo/engine/fx-exposure";
import { parseIsoDate } from "@/rwtsa-demo/engine/calendar";
import type { RawQuery } from "@/rwtsa-demo/state/red-flag-settings";

/** Scenario C controls, carried in the URL (plain GET form). Invalid values are reported and replaced by the default; never echoed. */
export interface LandedSettings {
  /** Duty as % of customs value, or null to use the workbook's ZAR duty amounts. */
  readonly dutyRatePct: number | null;
  readonly shipment: string | null;
  readonly issuesOnly: boolean;
  readonly asOf: string;
  readonly bucket: ExposureBucket;
  readonly values: Readonly<Record<"duty" | "asof" | "bucket", string>>;
  readonly errors: readonly string[];
}

const one = (q: RawQuery, k: string): string | undefined => {
  const v = q[k];
  return Array.isArray(v) ? (v as readonly string[])[0] : (v as string | undefined);
};

export function parseLandedSettings(q: RawQuery): LandedSettings {
  const errors: string[] = [];
  let duty: number | null = null;
  const d = one(q, "duty");
  if (d !== undefined && d !== "") {
    const n = Number(d);
    if (/^\d+(\.\d+)?$/.test(d) && Number.isFinite(n) && n <= 100) duty = n;
    else errors.push("Duty rate: must be a percentage from 0 to 100; the workbook duty amounts are used instead.");
  }
  let asOf = DEFAULT_AS_AT;
  const a = one(q, "asof");
  if (a !== undefined && a !== "") {
    if (parseIsoDate(a) !== null) asOf = a;
    else errors.push("As-at date: must be a real date as YYYY-MM-DD; the default was used.");
  }
  let bucket: ExposureBucket = "month";
  const b = one(q, "bucket");
  if (b !== undefined && b !== "") {
    if (b === "month" || b === "week") bucket = b;
    else errors.push("Bucket: month or week; the default was used.");
  }
  const ship = one(q, "ship");
  return {
    dutyRatePct: duty,
    shipment: ship && ship !== "" ? ship : null,
    issuesOnly: one(q, "issues") === "1",
    asOf,
    bucket,
    values: { duty: duty === null ? "" : String(duty), asof: asOf, bucket },
    errors,
  };
}
