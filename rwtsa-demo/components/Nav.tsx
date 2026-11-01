import Link from "next/link";
import { SCENARIOS } from "@/rwtsa-demo/state/layers";

export function Nav() {
  const links = [
    { href: "/", label: "Overview" },
    ...SCENARIOS.map((s) => ({ href: `/${s.slug}`, label: `Scenario ${s.id}` })),
    { href: "/validation", label: "Validation" },
  ];
  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
        <span className="text-sm font-semibold text-slate-900">RWTSA demonstration (local)</span>
        <nav aria-label="Demonstration" className="flex flex-wrap gap-4 text-sm">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="text-primary hover:underline" prefetch={false}>
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
