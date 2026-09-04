import { useId } from "react";

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "id"> {
  id?: string;
  label: string;
  error?: string;
  helperText?: string;
  hideLabel?: boolean;
}

export function Select({ id, label, error, helperText, hideLabel, required, className = "", children, ...props }: SelectProps) {
  const autoId = useId();
  const selectId = id ?? autoId;
  const errorId = error ? `${selectId}-error` : undefined;
  const helperId = !error && helperText ? `${selectId}-helper` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={selectId} className={hideLabel ? "sr-only" : "text-sm font-medium text-slate-700"}>
        {label}
        {required && <span className="text-danger"> *</span>}
      </label>
      <div className="relative">
        <select
          id={selectId}
          required={required}
          aria-invalid={!!error || undefined}
          aria-describedby={errorId ?? helperId}
          className={`h-9 w-full appearance-none rounded-md border bg-white px-3 pr-8 text-sm text-slate-900 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400 ${
            error ? "border-danger-border" : "border-slate-300"
          } ${className}`}
          {...props}
        >
          {children}
        </select>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
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
