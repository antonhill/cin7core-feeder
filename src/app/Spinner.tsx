/**
 * Small inline spinning indicator for buttons and other loading states — a
 * thin ring with a rounded-cap arc (the modern "Stripe/Linear"-style spinner)
 * rather than a solid pie-wedge. Uses currentColor so it automatically
 * matches whatever text color it sits next to (a filled indigo button, an
 * outlined slate one, red error text, etc.) without a color prop of its own.
 */
export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={`inline-block animate-spin align-[-0.125em] ${className}`}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeWidth="2.5" className="opacity-20" />
      <path
        d="M21.5 12c0-3.5-1.9-6.7-5-8.4"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
