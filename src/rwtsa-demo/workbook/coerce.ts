import { z } from "zod";
import type { FieldSpec } from "@/rwtsa-demo/contracts/fields";

/**
 * Cell coercion. Every function is pure and VALUE-BLIND on failure: it returns a reason CLASS, never the
 * offending value, so nothing downstream can echo workbook content (see findings.ts).
 *
 * Deliberately strict: it does not guess locale. "1,5" or "15%" is a `number_format` failure, an unrecognised
 * date text is `date_format`, and a bare number in a date column is rejected rather than interpreted as an
 * Excel serial. The real workbook's formats are unknown ([Open] in the brief) and must be decided from local
 * inspection, not assumed here.
 */

export type CellResult = { ok: true; value: string | number | boolean | null } | { ok: false; reason: string };

const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const ISO_DATE_RE = /^(\d{4})[-/](\d{2})[-/](\d{2})(?:[T ].*)?$/;

const numberSchema = z.number().finite();

function isBlank(raw: unknown): boolean {
  return raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
}

function toIsoDate(d: Date): string | null {
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Coerces one raw cell to the field's kind. A blank cell is `null` for any kind (required-ness is checked by the caller). */
export function coerceCell(spec: FieldSpec, raw: unknown): CellResult {
  if (isBlank(raw)) return { ok: true, value: null };

  switch (spec.kind) {
    case "str": {
      if (typeof raw === "string") return { ok: true, value: raw.trim() };
      if (typeof raw === "number" && Number.isFinite(raw)) return { ok: true, value: String(raw) };
      return { ok: false, reason: "type" };
    }
    case "num": {
      if (typeof raw === "number") {
        const parsed = numberSchema.safeParse(raw);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false, reason: "number_format" };
      }
      if (typeof raw === "string") {
        const compact = raw.replace(/[\s ]/g, "");
        return NUMBER_RE.test(compact) ? { ok: true, value: Number(compact) } : { ok: false, reason: "number_format" };
      }
      return { ok: false, reason: "type" };
    }
    case "date": {
      if (raw instanceof Date) {
        const iso = toIsoDate(raw);
        return iso ? { ok: true, value: iso } : { ok: false, reason: "date_format" };
      }
      if (typeof raw === "string") {
        const m = ISO_DATE_RE.exec(raw.trim());
        if (!m) return { ok: false, reason: "date_format" };
        const iso = `${m[1]}-${m[2]}-${m[3]}`;
        const roundTrip = toIsoDate(new Date(`${iso}T00:00:00Z`));
        return roundTrip === iso ? { ok: true, value: iso } : { ok: false, reason: "date_format" };
      }
      return { ok: false, reason: "date_format" };
    }
    case "bool": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (typeof raw === "number") return raw === 1 ? { ok: true, value: true } : raw === 0 ? { ok: true, value: false } : { ok: false, reason: "boolean_format" };
      if (typeof raw === "string") {
        const s = raw.trim().toLowerCase();
        if (["yes", "y", "true", "1"].includes(s)) return { ok: true, value: true };
        if (["no", "n", "false", "0"].includes(s)) return { ok: true, value: false };
      }
      return { ok: false, reason: "boolean_format" };
    }
    case "enum": {
      if (typeof raw !== "string") return { ok: false, reason: "enum_value" };
      const s = raw.trim().toLowerCase();
      const hit = (spec.values ?? []).find((v) => v.toLowerCase() === s);
      return hit ? { ok: true, value: hit } : { ok: false, reason: "enum_value" };
    }
  }
}
