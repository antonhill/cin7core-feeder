/**
 * The one "Level 1" operational surface — a white panel that visibly floats
 * above the cooler Level 0 workspace background (globals.css), via a real
 * two-layer shadow rather than the flatter `shadow-sm` this replaces. Not
 * every section needs to be a Panel — reach for it where content is a real
 * grouped unit (filters, a data table, a settings block), not as a default
 * wrapper for every div.
 */
export function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <section
      className={`rounded-lg border border-slate-200 bg-white p-6 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_10px_24px_-16px_rgba(15,23,42,0.18)] ${className}`}
    >
      {children}
    </section>
  );
}

/** A panel's own section label — functional (it names the group beneath it), not a decorative eyebrow over a separate heading. */
export function PanelTitle({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <p className={`text-xs font-semibold uppercase tracking-wide text-slate-500 ${className}`}>{children}</p>;
}
