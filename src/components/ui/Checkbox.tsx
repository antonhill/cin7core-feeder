import { useId } from "react";

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "id" | "type"> {
  id?: string;
  label: string;
  error?: string;
}

export function Checkbox({ id, label, error, className = "", ...props }: CheckboxProps) {
  const autoId = useId();
  const checkboxId = id ?? autoId;
  const errorId = error ? `${checkboxId}-error` : undefined;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={checkboxId} className="flex items-center gap-2 text-sm text-slate-700">
        <input
          id={checkboxId}
          type="checkbox"
          aria-invalid={!!error || undefined}
          aria-describedby={errorId}
          className={`h-4 w-4 rounded border-slate-300 text-primary ${className}`}
          {...props}
        />
        {label}
      </label>
      {error && (
        <p id={errorId} role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
