"use client";

import { useId, useState } from "react";
import { formatZar, formatZarCents } from "@/lib/format-money";

// Small presentational inputs shared by the NewQuip quote editor. No business logic: values go up as numbers (or null when blank).

const parse = (t: string): number | null => {
  const s = t.trim().replace(/\s/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Optional inline validation: `error` is shown directly under the field (role "alert" is NOT used: the page decides when to show it); `ariaLabel` names a field whose visible label is empty. */
export function NumField({ label, value, onChange, unit, hint, placeholder, disabled, error, ariaLabel, onBlur }: {
  label: string; value: number | null | undefined; onChange: (v: number | null) => void; unit?: string; hint?: string; placeholder?: string; disabled?: boolean; error?: string; ariaLabel?: string; onBlur?: () => void;
}) {
  const errId = useId();
  const [text, setText] = useState(value == null ? "" : String(value));
  // Resync when the value changes from OUTSIDE (e.g. "Load sample inputs"); typing that parses to the same value keeps its text.
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (parse(text) !== (value ?? null)) setText(value == null ? "" : String(value));
  }
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-slate-700">{label}{unit ? <span className="ml-1 font-normal text-slate-600">({unit})</span> : null}</span>
      <input
        value={text} disabled={disabled} placeholder={placeholder} inputMode="decimal" aria-label={ariaLabel} aria-invalid={error ? true : undefined} aria-describedby={error ? errId : undefined} onBlur={onBlur}
        onChange={(e) => { setText(e.target.value); onChange(parse(e.target.value)); }}
        className={`h-9 min-h-11 rounded-md border bg-white px-3 text-sm tabular-nums text-slate-900 disabled:bg-slate-50 disabled:text-slate-600 ${error ? "border-red-600" : "border-slate-300"}`}
      />
      {error ? <span id={errId} className="text-xs font-medium text-red-700" data-testid="field-error">{error}</span> : null}
      {hint ? <span className="text-xs text-slate-600">{hint}</span> : null}
    </label>
  );
}

export function TextField({ label, value, onChange, hint, placeholder, disabled, error, ariaLabel, onBlur }: {
  label: string; value: string; onChange: (v: string) => void; hint?: string; placeholder?: string; disabled?: boolean; error?: string; ariaLabel?: string; onBlur?: () => void;
}) {
  const errId = useId();
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-slate-700">{label}</span>
      <input value={value} disabled={disabled} placeholder={placeholder} aria-label={ariaLabel} aria-invalid={error ? true : undefined} aria-describedby={error ? errId : undefined} onBlur={onBlur} onChange={(e) => onChange(e.target.value)}
        className={`h-9 min-h-11 rounded-md border bg-white px-3 text-sm text-slate-900 disabled:bg-slate-50 disabled:text-slate-600 ${error ? "border-red-600" : "border-slate-300"}`} />
      {error ? <span id={errId} className="text-xs font-medium text-red-700" data-testid="field-error">{error}</span> : null}
      {hint ? <span className="text-xs text-slate-600">{hint}</span> : null}
    </label>
  );
}

export const fmtZar = (n: number | null | undefined): string => formatZar(n);
export const fmtCents = (c: number | null | undefined): string => formatZarCents(c);
