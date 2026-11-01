/**
 * Field-spec DSL for the RWTSA demonstration workbook contracts.
 *
 * Pure types and helpers only: no I/O, no workbook, no network. A contract describes the STRUCTURE the
 * (locally held, protected) workbook is expected to have, taken from the NDA-safe requirements brief §4.
 * It never contains a value from any real workbook.
 *
 * Header matching is by normalised NAME, never by column position: lower-case, every non-alphanumeric
 * character removed, so "Style code", "STYLE_CODE" and "style-code" are the same header. The first entry in
 * a field's `headers` is the canonical display name; the rest are accepted aliases. Real headers that differ
 * from these can be mapped without a code change via a local header-map file (see workbook/read.ts).
 */

export type FieldKind = "str" | "num" | "date" | "bool" | "enum";

/** The four RWTSA demonstration scenarios (brief §3): A Red Flag, B production/BOM/variance, C imports/FX, D CRM. */
export type ScenarioId = "A" | "B" | "C" | "D";

export interface FieldSpec {
  /** camelCase key on the parsed row. */
  readonly key: string;
  /** headers[0] is canonical; the rest are aliases. */
  readonly headers: readonly string[];
  readonly kind: FieldKind;
  readonly required: boolean;
  /** enum only: the allowed canonical values (matched case-insensitively). */
  readonly values?: readonly string[];
  /**
   * num only. A negative value is normally reported (warning `negative_value`, or error when `negativeIsError`).
   * `allowNegative: true` is the ONLY way a contract may declare negative values legitimate: a field that is signed
   * by nature (a variance column, or a derived balance that is negative when over-committed). Never for costs,
   * quantities, prices, minutes or rates.
   */
  readonly allowNegative?: boolean;
  /** num only: a negative value is an ERROR, not a warning (stock quantities cannot be negative). */
  readonly negativeIsError?: boolean;
  /**
   * Optional in the file format but needed by this scenario's calculations: its ABSENCE is a warning and makes the
   * scenario "not ready" (the workbook can still be valid overall). Optional fields without this are only noted (info).
   */
  readonly critical?: ScenarioId;
  /**
   * bool only. Accept "Yes" / "No" followed by a description ("No (duty-free, direct to stores)"). Declared per field, never
   * global: every other boolean column keeps the strict yes/no/true/false/1/0 vocabulary.
   */
  readonly boolPrefix?: boolean;
}

type KindToTs = { str: string; num: number; date: string; bool: boolean; enum: string };

/** Derives the parsed-row type from a `defineFields(...)` result. Optional fields are `T | null`. */
export type RowOf<F extends readonly FieldSpec[]> = {
  [K in F[number] as K["key"]]: K["required"] extends true ? KindToTs[K["kind"]] : KindToTs[K["kind"]] | null;
};

/** Identity helper that preserves literal types so `RowOf` can derive exact row types. */
export function defineFields<const F extends readonly FieldSpec[]>(fields: F): F {
  return fields;
}

/** Normalises a header (or alias) for comparison. Never used on cell values. */
export function normaliseHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** `YYYY-MM` month header, e.g. "2026-08". */
export const MONTH_HEADER_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
