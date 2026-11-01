import { normaliseHeader } from "@/rwtsa-demo/contracts/fields";
import { TAB_CONTRACTS, type TabName } from "@/rwtsa-demo/contracts/tabs";
import { finding, type Finding } from "@/rwtsa-demo/findings";
import type { RawTable } from "@/rwtsa-demo/workbook/read";

/**
 * Composite product references. The advisor's workbook sometimes holds a product as free text that CONTAINS a code
 * ("<style> - all sizes", "<sku> (single size)"). Resolution is explicit and conservative:
 *   1. the whole text equals an Items SKU or style code (case-insensitive), or
 *   2. exactly ONE distinct Items SKU appears in the text as a whole token, or else exactly ONE distinct Items style code.
 * Two different codes, or none, is UNRESOLVED: the original text is kept (so the contract's orphan check reports it) and
 * nothing is guessed.
 */

export type ProductRef = { kind: "sku"; value: string } | { kind: "style"; value: string } | { kind: "unresolved" };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function containsToken(text: string, code: string): boolean {
  // Codes contain - . and _, so those characters continue a code: "ABC" is not found inside "ABC-10" or "X-ABC" or "ABC.9".
  return new RegExp(`(?<![A-Za-z0-9._-])${escape(code)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, "i").test(text);
}

export function resolveProductRef(text: string, skus: readonly string[], styles: readonly string[]): ProductRef {
  const t = text.trim();
  if (t === "") return { kind: "unresolved" };
  const lower = t.toLowerCase();
  const exactSku = skus.find((s) => s.toLowerCase() === lower);
  if (exactSku !== undefined) return { kind: "sku", value: exactSku };
  const exactStyle = styles.find((s) => s.toLowerCase() === lower);
  if (exactStyle !== undefined) return { kind: "style", value: exactStyle };
  const skuHits = skus.filter((s) => containsToken(t, s));
  if (skuHits.length === 1) return { kind: "sku", value: skuHits[0] };
  if (skuHits.length > 1) return { kind: "unresolved" };
  const styleHits = styles.filter((s) => containsToken(t, s));
  if (styleHits.length === 1) return { kind: "style", value: styleHits[0] };
  return { kind: "unresolved" };
}

/** Header (normalised) of the composite ImportPOs column: "SKU / style". */
const IMPORT_PO_COMPOSITE = normaliseHeader("SKU / style");

function indexOfField(tab: TabName, headers: readonly string[], field: string): number {
  const aliases = new Set(TAB_CONTRACTS[tab].fields.find((f) => f.key === field)!.headers.map(normaliseHeader));
  return headers.findIndex((h) => aliases.has(normaliseHeader(h)));
}

export function applyComposite(tab: "ImportPOs" | "ProductionOrders", raw: RawTable, skus: readonly string[], styles: readonly string[]): { table: RawTable; findings: Finding[] } {
  const findings: Finding[] = [];
  const canonical = (f: string) => TAB_CONTRACTS[tab].fields.find((x) => x.key === f)!.headers[0];

  if (tab === "ImportPOs") {
    const comp = raw.headers.findIndex((h) => normaliseHeader(h) === IMPORT_PO_COMPOSITE);
    if (comp < 0) return { table: raw, findings };
    const headers = [...raw.headers];
    let skuCol = indexOfField(tab, headers, "sku");
    let styleCol = indexOfField(tab, headers, "styleCode");
    const rows = raw.rows.map((r) => [...r]);
    if (skuCol < 0) {
      headers.push(canonical("sku"));
      skuCol = headers.length - 1;
      rows.forEach((r) => r.push(null));
    }
    if (styleCol < 0) {
      headers.push(canonical("styleCode"));
      styleCol = headers.length - 1;
      rows.forEach((r) => r.push(null));
    }
    const unresolved: number[] = [];
    let viaText = 0;
    rows.forEach((r, i) => {
      const text = typeof r[comp] === "string" ? (r[comp] as string) : "";
      if (text.trim() === "") return;
      const ref = resolveProductRef(text, skus, styles);
      if (ref.kind === "sku") r[skuCol] = ref.value;
      else if (ref.kind === "style") r[styleCol] = ref.value;
      else {
        r[styleCol] = text.trim();
        unresolved.push(raw.rowNumbers[i]);
      }
      if (ref.kind !== "unresolved" && ref.value.toLowerCase() !== text.trim().toLowerCase()) viaText++;
    });
    if (viaText > 0) findings.push(finding({ severity: "info", code: "composite_resolved", tab, field: "sku", count: viaText }));
    if (unresolved.length > 0) findings.push(finding({ severity: "warning", code: "composite_unresolved", tab, field: "sku", count: unresolved.length, rows: unresolved }));
    return { table: { ...raw, headers, rows }, findings };
  }

  // ProductionOrders: the Style column may carry "<style> (long run)". Only Items STYLE codes are considered.
  const col = indexOfField(tab, raw.headers, "styleCode");
  if (col < 0) return { table: raw, findings };
  const rows = raw.rows.map((r) => [...r]);
  const unresolved: number[] = [];
  let viaText = 0;
  rows.forEach((r, i) => {
    const text = typeof r[col] === "string" ? (r[col] as string) : "";
    if (text.trim() === "") return;
    const ref = resolveProductRef(text, [], styles);
    if (ref.kind === "style") {
      if (ref.value.toLowerCase() !== text.trim().toLowerCase()) viaText++;
      r[col] = ref.value;
    } else unresolved.push(raw.rowNumbers[i]);
  });
  if (viaText > 0) findings.push(finding({ severity: "info", code: "composite_resolved", tab, field: "styleCode", count: viaText }));
  if (unresolved.length > 0) findings.push(finding({ severity: "warning", code: "composite_unresolved", tab, field: "styleCode", count: unresolved.length, rows: unresolved }));
  return { table: { ...raw, rows }, findings };
}
