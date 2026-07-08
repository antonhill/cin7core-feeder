/**
 * Small inline spinning indicator for buttons and other loading states —
 * uses currentColor so it automatically matches whatever text color it sits
 * next to (a filled indigo button, an outlined slate one, red error text,
 * etc.) without a color prop of its own.
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
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4Z" />
    </svg>
  );
}
