"use client";

import { PendingNotice } from "@/components/ui/action-feedback";
import { OP } from "@/components/ui/operation-labels";
import { useId, useRef, useState } from "react";
import { DisabledReason } from "@/components/ApprovalDisabledReason";
import { Alert } from "@/components/ui/Alert";
import { Status } from "@/components/ui/Status";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import type { CatalogueProduct } from "@/lib/projects/catalogue-search";
import { searchCin7CatalogueForMappingAction } from "../actions";

// Map an optional additional element to a Cin7 product: search the synced catalogue by SKU or description and choose. The choice is only stored in the
// draft; the server verifies on every Save that the SKU is an active product of this organisation's catalogue. Stock is informational and never blocks.
export function ProductMappingPicker({ label, value, onChange, disabled }: { label: string; value: string | undefined; onChange: (sku: string | null) => void; disabled?: boolean }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CatalogueProduct[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const uid = useId();
  const searchWhy = busy ? "Searching - please wait." : query.trim().length < 2 ? "Type at least 2 characters to search." : undefined;
  const inFlight = useRef(false); // a ref, not state: Enter + click in the same tick must search once
  const search = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(null);
    try {
      const r = await searchCin7CatalogueForMappingAction(query);
      if (r.ok && r.data) { setResults(r.data.products); setNote(r.data.detail); } else { setResults(null); setError(r.error ?? "The Cin7 product search failed. Nothing was changed; you can search again."); }
    } catch { setResults(null); setError("The Cin7 product search did not complete. Nothing was changed; you can search again."); }
    finally { inFlight.current = false; setBusy(false); }
  };
  return (
    <div className="w-full space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {value ? <Status tone="success">Mapped to {value}</Status> : <Status tone="warning">Product not chosen</Status>}
        {value && !disabled && <Button size="sm" variant="ghost" onClick={() => { onChange(null); }}>Clear</Button>}
      </div>
      {!disabled && (
        <div className="flex flex-wrap items-end gap-2">
          <Input label={`Search Cin7 for ${label} (SKU or description)`} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !busy) void search(); }} />
          <Button size="sm" variant="secondary" disabled={busy || query.trim().length < 2} aria-describedby={searchWhy ? `${uid}-search-why` : undefined} loading={busy} onClick={search}>Search</Button>
          <DisabledReason id={`${uid}-search-why`}>{searchWhy}</DisabledReason>
        </div>
      )}
      {busy && <PendingNotice label={OP.fetchCin7Product} />}
      {error && <Alert tone="danger">{error}</Alert>}
      {results && (
        <div className="rounded-md border border-slate-200">
          {results.length === 0 ? <p className="p-2 text-xs text-slate-600">{note ?? "No matching products."}</p> : (
            <ul className="max-h-56 divide-y divide-slate-100 overflow-auto text-xs">
              {results.map((p) => (
                <li key={p.sku} className="flex items-center justify-between gap-3 p-2">
                  <span><span className="font-mono font-medium">{p.sku}</span> {p.name}{!p.active && <span className="ml-1 text-amber-700">(inactive)</span>}<span className="ml-1 text-slate-600">{p.type}</span></span>
                  <Button size="sm" variant="secondary" disabled={!p.active} onClick={() => { onChange(p.sku); setResults(null); setQuery(""); }}>Choose</Button>
                </li>
              ))}
            </ul>
          )}
          {results.length > 0 && note && <p className="border-t border-slate-100 p-2 text-xs text-slate-600">{note}</p>}
        </div>
      )}
    </div>
  );
}
