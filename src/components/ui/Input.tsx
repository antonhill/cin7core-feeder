import { useId } from "react";

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "id"> {
  id?: string;
  label: string;
  error?: string;
  helperText?: string;
  /** Visually hides the label (kept in the accessible name) for contexts — a compact filter bar, a table-embedded search box — where the surrounding layout already makes the field's purpose obvious. Never omit the label itself; this only changes whether it's drawn. */
  hideLabel?: boolean;
}

/**
 * The one text-input implementation for the app — wires `aria-invalid`/
 * `aria-describedby` to its error message automatically (the Phase 1 audit
 * found zero of either anywhere in the app) rather than leaving each page to
 * remember to do it. Focus visibility comes from the app-wide
 * `:focus-visible` rule in globals.css.
 */
export function Input({ id, label, error, helperText, hideLabel, required, className = "", ...props }: InputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const errorId = error ? `${inputId}-error` : undefined;
  const helperId = !error && helperText ? `${inputId}-helper` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className={hideLabel ? "sr-only" : "text-sm font-medium text-slate-700"}>
        {label}
        {required && <span className="text-danger"> *</span>}
      </label>
      <input
        id={inputId}
        required={required}
        aria-invalid={!!error || undefined}
        aria-describedby={errorId ?? helperId}
        className={`h-9 rounded-md border bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400 ${
          error ? "border-danger-border" : "border-slate-300"
        } ${className}`}
        {...props}
      />
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : helperText ? (
        <p id={helperId} className="text-xs text-slate-500">
          {helperText}
        </p>
      ) : null}
    </div>
  );
}
