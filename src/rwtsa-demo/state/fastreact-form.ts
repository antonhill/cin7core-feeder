import { DATE_FORMATS, ORDER_STATUSES, LIMITS, type DateFormat } from "@/rwtsa-demo/fastreact/contract";
import type { ExchangeSource } from "@/rwtsa-demo/fastreact/export";
import { checkTextValue, parseIsoDate } from "@/rwtsa-demo/fastreact/format";
import { buildSampleReturn, parseReturnFile, sha256Text, type ReturnOrderRef } from "@/rwtsa-demo/fastreact/return-format";
import { applyPlan, planReturn, type SourceKind } from "@/rwtsa-demo/fastreact/return-reconcile";
import { updateExchange, type ExchangeState } from "@/rwtsa-demo/state/fastreact-store";

/**
 * The only way the Fast React exchange page changes local state. Everything is validated before anything is written: if any value
 * is invalid nothing is saved. Requests carry only plain values; nothing here reads a file path, a workbook, or the network.
 */

export type FormOutcome =
  | "supplement-saved"
  | "invalid-supplement"
  | "options-saved"
  | "invalid-options"
  | "return-previewed"
  | "return-rejected"
  | "return-applied"
  | "return-nothing-to-apply"
  | "return-discarded"
  | "returns-cleared"
  | "no-pending"
  | "invalid";

export const FORM_MESSAGES: Readonly<Record<FormOutcome, string>> = {
  "supplement-saved": "Planner inputs saved locally.",
  "invalid-supplement": "Nothing was saved: one or more values are not valid.",
  "options-saved": "Export options saved locally.",
  "invalid-options": "Nothing was saved: an export option or selected order is not valid.",
  "return-previewed": "The return file was validated. Review the preview; nothing has been applied yet.",
  "return-rejected": "The return file was refused and nothing was stored. Check the exact SPK.* header, UTC timestamps (YYYY-MM-DDTHH:MM:SSZ), and the 256 KB / 2000 row limits.",
  "return-applied": "Applied to local demonstration state only. Nothing was sent to Cin7, Fast React or Xero.",
  "return-nothing-to-apply": "Nothing to apply: every row was a duplicate, stale, conflicting or rejected. Local state is unchanged.",
  "return-discarded": "The pending return file was discarded.",
  "returns-cleared": "Applied return data cleared from local demonstration state (planner inputs kept).",
  "no-pending": "There is no matching pending return file to apply.",
  invalid: "That request was not understood.",
};

export interface FormContext {
  readonly dir: string;
  readonly label: string;
  readonly source: ExchangeSource;
  readonly now: Date;
}

export interface FormInput {
  readonly action: string | null;
  readonly fields?: Readonly<Record<string, string>>;
  readonly selected?: readonly string[];
  readonly text?: string;
}

const STATUS = new Set(ORDER_STATUSES.map((s) => s.code));

function orderRefs(source: ExchangeSource): ReturnOrderRef[] {
  return source.orders.map((o) => ({ orderNo: o.orderNo, qty: o.qty }));
}

function saveSupplement(ctx: FormContext, fields: Readonly<Record<string, string>>): FormOutcome {
  const orderNos = new Set(ctx.source.orders.map((o) => o.orderNo));
  const styles = new Set(ctx.source.items.map((i) => i.styleCode));
  const customers = new Map(ctx.source.customers.map((c) => [c.toUpperCase(), c] as const));
  const orderPatch = new Map<string, { customer?: string | null; deliveryDate?: string | null; status?: string | null }>();
  const typePatch = new Map<string, string | null>();
  for (const [key, raw] of Object.entries(fields)) {
    const i = key.indexOf(":");
    if (i < 0) return "invalid-supplement";
    const kind = key.slice(0, i);
    const id = key.slice(i + 1);
    const value = raw;
    if (kind === "customer" || kind === "date" || kind === "status") {
      if (!orderNos.has(id)) return "invalid-supplement";
      const patch = orderPatch.get(id) ?? {};
      if (kind === "customer") {
        if (value === "") patch.customer = null;
        else {
          const canon = customers.get(value.toUpperCase());
          if (canon === undefined) return "invalid-supplement";
          patch.customer = canon;
        }
      } else if (kind === "date") {
        if (value === "") patch.deliveryDate = null;
        else if (parseIsoDate(value) === null) return "invalid-supplement";
        else patch.deliveryDate = value;
      } else {
        if (value === "") patch.status = null;
        else if (!STATUS.has(value)) return "invalid-supplement";
        else patch.status = value;
      }
      orderPatch.set(id, patch);
    } else if (kind === "type") {
      if (!styles.has(id)) return "invalid-supplement";
      if (value === "") typePatch.set(id, null);
      else if (checkTextValue(value) !== null || value.length > 15) return "invalid-supplement";
      else typePatch.set(id, value);
    } else return "invalid-supplement";
  }
  updateExchange(ctx.dir, ctx.label, (s) => {
    const orders = { ...s.supplement.orders };
    for (const [id, p] of orderPatch) {
      const prev = orders[id] ?? { customer: null, deliveryDate: null, status: null };
      orders[id] = { customer: p.customer !== undefined ? p.customer : prev.customer, deliveryDate: p.deliveryDate !== undefined ? p.deliveryDate : prev.deliveryDate, status: p.status !== undefined ? p.status : prev.status };
    }
    const productTypes = { ...s.supplement.productTypes };
    for (const [id, t] of typePatch) {
      if (t === null) delete productTypes[id];
      else productTypes[id] = { ...(productTypes[id]?.workContent ? { workContent: productTypes[id].workContent } : {}), code: t };
    }
    return { ...s, supplement: { orders, productTypes } };
  });
  return "supplement-saved";
}

function saveOptions(ctx: FormContext, fields: Readonly<Record<string, string>>, selected: readonly string[]): FormOutcome {
  const delimiter = fields.delimiter;
  const dateFormat = fields.dateFormat;
  const headerStyle = fields.headerStyle;
  if (delimiter !== "tab" && delimiter !== "csv") return "invalid-options";
  if (!(DATE_FORMATS as readonly string[]).includes(dateFormat)) return "invalid-options";
  if (headerStyle !== "standard" && headerStyle !== "compliant") return "invalid-options";
  const known = new Set(ctx.source.orders.map((o) => o.orderNo));
  if (selected.length > LIMITS.maxExportRows || selected.some((x) => !known.has(x))) return "invalid-options";
  const sel = [...new Set(selected)].sort();
  updateExchange(ctx.dir, ctx.label, (s) => ({ ...s, options: { delimiter, dateFormat: dateFormat as DateFormat, headerStyle, selectedOrders: sel.length === 0 ? null : sel } }));
  return "options-saved";
}

function stagePending(ctx: FormContext, text: string, kind: SourceKind): FormOutcome {
  const parsed = parseReturnFile(text);
  if (parsed.fileErrors.length > 0 || text === "") return "return-rejected";
  const fileHash = sha256Text(text);
  updateExchange(ctx.dir, ctx.label, (s) => ({ ...s, pending: { fileHash, text, sourceKind: kind, createdAt: ctx.now.toISOString() } }));
  return "return-previewed";
}

function applyPending(ctx: FormContext, hash: string): FormOutcome {
  let outcome: FormOutcome = "no-pending";
  updateExchange(ctx.dir, ctx.label, (s: ExchangeState) => {
    if (!s.pending || s.pending.fileHash !== hash) return s;
    const parsed = parseReturnFile(s.pending.text);
    const plan = planReturn(parsed, orderRefs(ctx.source), s.returns, { now: ctx.now, fileHash: s.pending.fileHash });
    if (plan.fileErrors.length > 0) {
      outcome = "return-rejected";
      return { ...s, pending: null };
    }
    const next = applyPlan(s.returns, plan, { appliedAt: ctx.now.toISOString(), fileHash: s.pending.fileHash, sourceKind: s.pending.sourceKind });
    outcome = next === s.returns ? "return-nothing-to-apply" : "return-applied";
    return { ...s, returns: next, pending: null };
  });
  return outcome;
}

export function applyExchangeForm(ctx: FormContext, input: FormInput): FormOutcome {
  switch (input.action) {
    case "supplement-save":
      return saveSupplement(ctx, input.fields ?? {});
    case "options-save":
      return saveOptions(ctx, input.fields ?? {}, input.selected ?? []);
    case "return-sample": {
      const text = buildSampleReturn(orderRefs(ctx.source), ctx.now);
      return stagePending(ctx, text, "synthetic-sample");
    }
    case "return-upload":
      return stagePending(ctx, input.text ?? "", "upload");
    case "return-apply":
      return applyPending(ctx, input.fields?.hash ?? "");
    case "return-discard":
      updateExchange(ctx.dir, ctx.label, (s) => ({ ...s, pending: null }));
      return "return-discarded";
    case "returns-clear":
      updateExchange(ctx.dir, ctx.label, (s) => ({ ...s, returns: { orders: {}, history: [] }, pending: null }));
      return "returns-cleared";
    default:
      return "invalid";
  }
}
