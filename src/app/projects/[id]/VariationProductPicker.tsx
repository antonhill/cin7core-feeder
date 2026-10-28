"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import type { CatalogueProduct } from "@/lib/projects/catalogue-search";
import { searchVariationProductsAction } from "../variation-billing-actions";

// Searchable Cin7 product selector for a variation's physical scope. Search by SKU or description over the synced catalogue; picking a result fills
// the identifying details (the server re-reads them from the catalogue and refuses anything not in it). Stock is informational only: "?" = unknown,
// never zero, and an out-of-stock product can still be chosen. A variation with no products is a service-only variation.
export interface PickedProduct { sku: string; description: string; quantity: string }

export function VariationProductPicker({ picked, onChange, disabled }: { picked: PickedProduct[]; onChange: (p: PickedProduct[]) => void; disabled?: boolean }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CatalogueProduct[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const search = async () => {
    setBusy(true); setError(null);
    const r = await searchVariationProductsAction(query);
    if (r.ok && r.data) { setResults(r.data.products); setNote(r.data.detail); } else { setResults(null); setError(r.error ?? "Search failed."); }
    setBusy(false);
  };
  const add = (p: CatalogueProduct) => { if (!picked.some((x) => x.sku === p.sku)) onChange([...picked, { sku: p.sku, description: p.name, quantity: "1" }]); };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Input label="Search Cin7 products (SKU or description)" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !busy) void search(); }} />
        <Button size="sm" variant="secondary" disabled={busy || disabled || query.trim().length < 2} onClick={search}>{busy ? "Searching…" : "Search"}</Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {note && results && <p className="text-xs text-slate-500">{note}</p>}
      {results && results.length > 0 && (
        <ul className="max-h-56 divide-y divide-slate-100 overflow-y-auto rounded border border-slate-200 text-sm">
          {results.map((p) => (
            <li key={p.sku} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="font-mono">{p.sku}</span><span className="text-slate-700">{p.name}</span>
              <Badge tone={p.stocked ? "neutral" : "warning"}>{p.type}</Badge>
              {!p.active && <Badge tone="danger">inactive</Badge>}
              <span className="text-xs text-slate-500">stock {p.available === null ? "?" : p.available}</span>
              <Button size="sm" variant="secondary" className="ml-auto" disabled={disabled || !p.stocked || !p.active || picked.some((x) => x.sku === p.sku)} onClick={() => add(p)}>{picked.some((x) => x.sku === p.sku) ? "Added" : "Add"}</Button>
            </li>
          ))}
        </ul>
      )}
      {picked.length === 0 ? (
        <p className="text-xs text-slate-500">No products selected: this will be a service-only variation (no stock SKU is invented).</p>
      ) : (
        <ul className="space-y-2">
          {picked.map((p, i) => (
            <li key={p.sku} className="flex flex-wrap items-end gap-2">
              <div className="min-w-48"><div className="font-mono text-sm">{p.sku}</div><div className="text-xs text-slate-500">{p.description}</div></div>
              <Input label="Quantity" value={p.quantity} inputMode="decimal" onChange={(e) => onChange(picked.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
              <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onChange(picked.filter((_, j) => j !== i))}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
