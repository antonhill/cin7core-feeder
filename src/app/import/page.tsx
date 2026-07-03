"use client";

import { useActionState } from "react";
import { importCsvAction, type ImportActionState } from "./actions";

const INITIAL_STATE: ImportActionState = { status: "idle" };

const KINDS = [
  { value: "products", label: "Products (InventoryList)" },
  { value: "assembly_bom", label: "Assembly BOM" },
  { value: "production_bom", label: "Production BOM" },
];

export default function ImportPage() {
  const [state, formAction, isPending] = useActionState(importCsvAction, INITIAL_STATE);

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-xl font-semibold">Import Cin7 Core CSV</h1>
      <p className="mt-1 text-sm text-gray-500">
        Upload a products, assembly BOM, or production BOM export. Valid rows are committed
        immediately; invalid rows are skipped and listed below.
      </p>

      <form action={formAction} className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Organization ID
          <input
            name="orgId"
            required
            className="rounded border px-3 py-2 font-mono text-xs"
            placeholder="d776b8cc-4e6f-42bc-bbd1-3d910fd3aaef"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Import type
          <select name="kind" required className="rounded border px-3 py-2">
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          CSV file
          <input name="file" type="file" accept=".csv,text/csv" required className="rounded border px-3 py-2" />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Passphrase
          <input name="secret" type="password" required className="rounded border px-3 py-2" />
        </label>

        <button
          type="submit"
          disabled={isPending}
          className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          {isPending ? "Importing…" : "Import"}
        </button>
      </form>

      {state.status === "error" && (
        <p className="mt-6 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">{state.message}</p>
      )}

      {state.status === "success" && state.result && (
        <div className="mt-6 rounded border border-green-300 bg-green-50 p-4 text-sm">
          <p className="font-medium">
            Batch {state.result.batchId}: {state.result.rowCount} rows, {state.result.errorCount} invalid,{" "}
            {state.result.committed ? "committed" : "nothing to commit"}.
          </p>
          {state.result.commitSummary && (
            <pre className="mt-2 whitespace-pre-wrap text-xs">{JSON.stringify(state.result.commitSummary, null, 2)}</pre>
          )}
          {state.result.invalidRows.length > 0 && (
            <div className="mt-3">
              <p className="font-medium text-red-700">Invalid rows:</p>
              <ul className="mt-1 list-disc pl-5 text-xs text-red-700">
                {state.result.invalidRows.map((r) => (
                  <li key={r.rowNumber}>
                    Row {r.rowNumber}: {r.errors.join("; ")}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
