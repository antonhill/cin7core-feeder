import { ModuleHeader } from "@/app/ModuleHeader";
import { QUOTES_MODULE } from "@/app/module-nav";

// Placeholder landing for the Quotation + Margin module. The data layer (schema, margin engine,
// draft CRUD server actions) is in place; the interactive quote builder lands in the next phase.
// This page exists now so the registered module's nav tab and home tile resolve to a real route
// instead of a 404.
export default function QuotesPage() {
  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <ModuleHeader module={QUOTES_MODULE}>
        Build a customer quote with the commercial impact of every line in view — selling price,
        discount, cost, gross profit and margin&nbsp;% per line, plus a weighted overall margin — then
        create it in Cin7 Core, which stays the system of record.
      </ModuleHeader>

      <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm text-slate-600">
          The quote builder is being rolled out in stages. The margin calculations, storage, and
          draft save/load are already in place; the interactive builder screen is coming next.
        </p>
      </section>
    </main>
  );
}
