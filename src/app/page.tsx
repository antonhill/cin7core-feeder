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
    href: "/migrate",
    title: "Migrate",
    description: "Pull every Product, Assembly BOM, Customer, and Supplier live from one connected instance, then push the pulled data into another.",
  },
  {
    href: "/reports",
    title: "Reports",
    description: "Revenue, COGS, profit, and margin% per product sold, across every invoiced sale pulled from your connected Cin7 instances.",
  },
  {
    href: "/audit",
    title: "Data Audit",
    description: "Scan a connected instance's products for consistency and accuracy gaps — missing Brand, no sales price, incomplete inventory setup, missing GL accounts, near-duplicate categories — and bulk-fix them.",
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
      <h1 className="text-4xl font-bold tracking-tight text-slate-900">Cin7 Core Toolbox</h1>
      <p className="mt-3 max-w-2xl text-lg text-slate-500">Do amazing things that you cannot do in Cin7 Core.</p>

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
