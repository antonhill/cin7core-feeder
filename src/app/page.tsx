import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-xl font-semibold">Cin7 Core Feeder</h1>
      <p className="mt-2 text-sm text-gray-500">
        Master Product Hub — import products and Assembly BOMs once, keep every connected Cin7
        Core instance in sync.
      </p>

      <div className="mt-8 flex flex-col gap-4">
        <Link href="/import" className="rounded border p-4 hover:border-black">
          <p className="font-medium">Import &amp; Sync</p>
          <p className="mt-1 text-sm text-gray-500">
            Upload products/Assembly BOM/Production BOM CSVs, push to Cin7 instances, or download a
            template to edit and reimport.
          </p>
        </Link>

        <Link href="/settings/instances" className="rounded border p-4 hover:border-black">
          <p className="font-medium">Cin7 Instances</p>
          <p className="mt-1 text-sm text-gray-500">
            Connect, edit, or remove the Cin7 Core instances this organization syncs to.
          </p>
        </Link>
      </div>
    </main>
  );
}
