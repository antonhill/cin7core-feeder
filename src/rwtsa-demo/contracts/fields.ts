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

export interface FieldSpec {
  /** camelCase key on the parsed row. */
  readonly key: string;
  /** headers[0] is canonical; the rest are aliases. */
  readonly headers: readonly string[];
  readonly kind: FieldKind;
  readonly required: boolean;
  /** enum only: the allowed canonical values (matched case-insensitively). */
  readonly values?: readonly string[];
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
