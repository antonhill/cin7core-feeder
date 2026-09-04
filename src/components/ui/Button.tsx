import { Spinner } from "@/app/Spinner";

export type ButtonVariant = "primary" | "secondary" | "destructive" | "warning" | "ghost" | "link";
export type ButtonSize = "sm" | "md";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "border border-transparent bg-primary text-white shadow-sm hover:bg-primary-hover",
  secondary: "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-400",
  destructive: "border border-transparent bg-danger text-white shadow-sm hover:bg-danger-hover",
  /** A genuinely consequential action that isn't destructive/irreversible in the `destructive` sense — e.g. a live external-system write. Solid fill, not a tint, so it reads as assertive rather than merely decorative. */
  warning: "border border-transparent bg-warning text-white shadow-sm hover:opacity-90",
  ghost: "border border-transparent text-slate-600 hover:bg-slate-100",
  link: "border border-transparent text-primary underline-offset-2 hover:underline p-0! h-auto!",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 rounded-md px-2.5 text-xs font-medium",
  md: "h-9 gap-2 rounded-md px-3 text-sm font-medium",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

/**
 * The one button implementation for the app — replaces the 17+ hand-written
 * variants the Phase 1 audit found (no two pages agreed on radius, padding,
 * or text size for the same semantic role). Focus visibility comes from the
 * app-wide `:focus-visible` rule in globals.css; this never sets
 * `outline-none`.
 */
export function Button({ variant = "primary", size = "md", loading = false, disabled, className = "", children, ...props }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
      {...props}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}
