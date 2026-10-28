"use client";

import { useState } from "react";

// Small presentational inputs shared by the NewQuip quote editor. No business logic: values go up as numbers (or null when blank).

const parse = (t: string): number | null => {
  const s = t.trim().replace(/\s/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export function NumField({ label, value, onChange, unit, hint, placeholder, disabled }: {
  label: string; value: number | null | undefined; onChange: (v: number | null) => void; unit?: string; hint?: string; placeholder?: string; disabled?: boolean;
}) {
  const [text, setText] = useState(value == null ? "" : String(value));
  // Resync when the value changes from OUTSIDE (e.g. "Load sample inputs"); typing that parses to the same value keeps its text.
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (parse(text) !== (value ?? null)) setText(value == null ? "" : String(value));
  }
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-slate-700">{label}{unit ? <span className="ml-1 font-normal text-slate-400">({unit})</span> : null}</span>
      <input
        value={text} disabled={disabled} placeholder={placeholder} inputMode="decimal"
        onChange={(e) => { setText(e.target.value); onChange(parse(e.target.value)); }}
        className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm tabular-nums text-slate-900 disabled:bg-slate-50 disabled:text-slate-500"
      />
      {hint ? <span className="text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}

export function TextField({ label, value, onChange, hint, placeholder, disabled }: {
  label: string; value: string; onChange: (v: string) => void; hint?: string; placeholder?: string; disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-slate-700">{label}</span>
      <input value={value} disabled={disabled} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-900 disabled:bg-slate-50 disabled:text-slate-500" />
      {hint ? <span className="text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}

const ZAR = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" });
export const fmtZar = (n: number | null | undefined): string => (n == null || !Number.isFinite(n) ? "—" : ZAR.format(n).replace(/ /g, " "));
export const fmtCents = (c: number | null | undefined): string => (c == null ? "—" : fmtZar(c / 100));
