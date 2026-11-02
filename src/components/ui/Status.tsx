import type { BadgeTone } from "@/components/ui/Badge";

/**
 * The one domain-status indicator for NewQuip (claim, variation, invoice, approval and scope states). Badge stays the generic pill for the rest of the
 * Toolbox; Status exists because those states carry money and consequence, so every tone is checked to at least 4.5:1 against its own tint (the Badge
 * tokens measured 3.1 to 3.8:1 for success, warning and info) and no meaning rests on colour alone: each tone has its own mark ahead of the text,
 * and the text always says what the state is. Presentation only; callers decide the tone from their own domain logic.
 */
const TONE: Record<BadgeTone, { cls: string; mark: string }> = {
  neutral: { cls: "bg-slate-100 text-slate-700", mark: "•" },
  primary: { cls: "bg-indigo-50 text-indigo-800", mark: "•" },
  success: { cls: "bg-emerald-50 text-emerald-800", mark: "✓" },
  warning: { cls: "bg-amber-50 text-amber-900", mark: "!" },
  danger: { cls: "bg-red-50 text-red-800", mark: "×" },
  info: { cls: "bg-sky-50 text-sky-800", mark: "i" },
};

export function Status({ tone = "neutral", children }: { tone?: BadgeTone; children: React.ReactNode }) {
  const t = TONE[tone];
  return (
    <span className={`inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-semibold ${t.cls}`} data-tone={tone}>
      <span aria-hidden className="w-2.5 shrink-0 text-center text-xs leading-none">{t.mark}</span>
      {children}
    </span>
  );
}

/** BASE or VARIATION: the one way a scope is identified wherever amounts of both appear. */
export function ScopeTag({ scope }: { scope: "BASE" | "VARIATION" | string }) {
  return scope === "VARIATION" ? <Status tone="primary">Variation</Status> : <Status tone="neutral">Base</Status>;
}

/** Codes whose sentence-cased form reads as machine output; the business wording is stated, not derived. */
const WORDING: Record<string, string> = {
  FAILED_CONFIRMED_NO_WRITE: "Failed, nothing written",
  FAILED_UNCERTAIN: "Outcome uncertain",
  CANCELLED_BEFORE_WRITE: "Cancelled",
  CIN7_PENDING: "Awaiting Cin7 result",
};

/** Sentence-case wording for a stored status or state code, e.g. READY_FOR_APPROVAL -> "Ready for approval", CIN7_CREATED -> "Cin7 created". */
export function statusText(code: string): string {
  if (Object.hasOwn(WORDING, code)) return WORDING[code];
  const s = code.replace(/_/g, " ").toLowerCase().replace(/\bcin7\b/g, "Cin7").replace(/\bvat\b/g, "VAT");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
