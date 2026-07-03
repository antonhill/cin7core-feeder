import Link from "next/link";

const CARDS = [
  {
    href: "/import",
    title: "Import & Sync",
    description: "Upload a Products, Assembly BOM, or Production BOM CSV, then push it to one or more connected Cin7 Core instances.",
  },
  {
    href: "/templates",
    title: "Templates",
    description: "Download a CSV to edit and reimport — either the hub's own canonical data, or a full-fidelity export pulled live from a chosen instance.",
  },
  {
    href: "/settings/instances",
    title: "Cin7 Instances",
    description: "Connect, edit, or remove the Cin7 Core instances this organization syncs to.",
  },
];

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <h1 className="text-4xl font-bold tracking-tight text-slate-900">Cin7 Core Feeder</h1>
      <p className="mt-3 max-w-2xl text-lg text-slate-500">
        Master Product Hub — import products and Assembly BOMs once, keep every connected Cin7 Core
        instance in sync.
      </p>

      <div className="mt-12 grid gap-6 sm:grid-cols-3">
        {CARDS.map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-300 hover:shadow-md"
          >
            <p className="text-lg font-semibold text-slate-900">{card.title}</p>
            <p className="mt-2 text-base leading-relaxed text-slate-500">{card.description}</p>
          </Link>
        ))}
      </div>
    </main>
  );
}
