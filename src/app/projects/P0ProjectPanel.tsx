"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { P0_DEFAULT_CONTRACT_RANDS, P0_DEFAULT_SCHEDULE, P0_MAX_PRODUCTS } from "@/lib/projects/p0-project";
import type { StockedProduct } from "@/lib/projects/p0-project-store";
import { createP0ProjectAction, getP0PrepStatusAction, searchP0ProductsAction } from "./cin7-actions";

// PREPARE A DISPOSABLE P0 PROJECT: a SEPARATE project built from existing Cin7 SKUs you pick (with free stock at the location), a small test
// contract and a milestone schedule that are independent of the products' values. Toolbox rows only - nothing is created in Cin7, and no
// existing quotation or project is touched. Shown only to managers of the NewQuip organisation.
type Chosen = { sku: string; name: string; quantity: string };

export function P0ProjectPanel() {
  const router = useRouter();
  const [status, setStatus] = useState<{ enabled: boolean; isManager: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const [customer, setCustomer] = useState("");
  const [location, setLocation] = useState("MSTR");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<StockedProduct[] | null>(null);
  const [chosen, setChosen] = useState<Chosen[]>([]);
  const [contract, setContract] = useState(P0_DEFAULT_CONTRACT_RANDS);
  const [schedule, setSchedule] = useState(P0_DEFAULT_SCHEDULE.map((s) => ({ ...s })));
  const [msg, setMsg] = useState<{ tone: "danger" | "success" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { getP0PrepStatusAction().then((r) => setStatus(r.ok && r.data ? r.data : null)); }, []);
  if (!status || !status.enabled || !status.isManager) return null;

  const total = Math.round(schedule.reduce((n, s) => n + (Number(s.percent) || 0), 0) * 100) / 100;
  const ready = customer.trim() && chosen.length > 0 && chosen.every((c) => Number.isInteger(Number(c.quantity)) && Number(c.quantity) > 0) && Number(contract) > 0 && total === 100;

  async function search() {
    setBusy(true); setMsg(null);
    const r = await searchP0ProductsAction(location, query);
    setBusy(false);
    if (!r.ok) { setFound(null); return setMsg({ tone: "danger", text: r.error ?? "Search failed" }); }
    setFound(r.data ?? []);
  }
  async function create() {
    setBusy(true); setMsg(null);
    const r = await createP0ProjectAction({ customerName: customer, location, contractRands: contract, schedule, products: chosen.map((c) => ({ sku: c.sku, name: c.name, quantity: Number(c.quantity) })) });
    setBusy(false);
    if (!r.ok || !r.data) return setMsg({ tone: "danger", text: r.error ?? "Could not create the project" });
    setMsg({ tone: "success", text: `Created ${r.data.reference}. Opening it…` });
    router.push(`/projects/${r.data.projectId}`);
  }

  return (
    <Panel className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PanelTitle>Prepare a disposable P0 project</PanelTitle>
        <Button variant="secondary" size="sm" onClick={() => setOpen(!open)}>{open ? "Close" : "Open"}</Button>
      </div>
      <p className="mt-1 text-sm text-slate-500">A separate acceptance-test project from existing Cin7 products with free stock. Toolbox only: it creates nothing in Cin7 and changes no existing quotation or project.</p>
      {open && (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <Input label="Disposable Cin7 customer (exact name)" value={customer} onChange={(e) => setCustomer(e.target.value)} />
            <Input label="Cin7 location" value={location} onChange={(e) => setLocation(e.target.value)} />
            <Input label="Test contract value (R ex VAT)" value={contract} onChange={(e) => setContract(e.target.value)} />
          </div>
          <div>
            <p className="text-sm font-medium text-slate-800">Milestone schedule (independent of product values; must total 100%)</p>
            <div className="mt-2 grid gap-2 md:grid-cols-3">
              {schedule.map((s, i) => (
                <div key={i} className="flex items-end gap-2">
                  <Input label="Stage" value={s.name} onChange={(e) => setSchedule(schedule.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  <Input label="%" value={s.percent} onChange={(e) => setSchedule(schedule.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)))} />
                </div>
              ))}
            </div>
            <p className={`mt-1 text-sm ${total === 100 ? "text-slate-600" : "font-semibold text-red-700"}`}>Total {total}%{total === 100 ? "" : " - must be exactly 100%"}</p>
          </div>
          <div>
            <p className="text-sm font-medium text-slate-800">Choose up to {P0_MAX_PRODUCTS} existing Cin7 products with free stock at {location || "the location"}</p>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <Input label="Search SKU or name (blank = most stock)" value={query} onChange={(e) => setQuery(e.target.value)} />
              <Button size="sm" variant="secondary" disabled={busy} onClick={search}>Search</Button>
            </div>
            {found && (
              found.length === 0 ? <p className="mt-2 text-sm text-slate-600">No products with free stock at &quot;{location}&quot; match.</p> : (
                <div className="mt-2 overflow-x-auto">
                  <Table>
                    <THead><TR><TH>SKU</TH><TH>Name</TH><TH align="right">Free stock</TH><TH>Cache</TH><TH>{" "}</TH></TR></THead>
                    <TBody>
                      {found.map((p) => (
                        <TR key={p.sku}>
                          <TD className="font-mono">{p.sku}</TD><TD>{p.name}</TD><TD align="right" className="tabular-nums">{p.available}</TD>
                          <TD className="text-xs text-slate-500">synced {new Date(p.syncedAt).toLocaleDateString()}</TD>
                          <TD><Button size="sm" variant="secondary" disabled={chosen.length >= P0_MAX_PRODUCTS || chosen.some((c) => c.sku === p.sku)} onClick={() => setChosen([...chosen, { sku: p.sku, name: p.name, quantity: "2" }])}>Select</Button></TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </div>
              )
            )}
            {chosen.length > 0 && (
              <div className="mt-3 space-y-2">
                {chosen.map((c, i) => (
                  <div key={c.sku} className="flex flex-wrap items-end gap-2">
                    <span className="w-48 font-mono text-sm">{c.sku}</span><span className="min-w-48 flex-1 text-sm text-slate-600">{c.name}</span>
                    <Input label="Quantity" value={c.quantity} onChange={(e) => setChosen(chosen.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
                    <Button size="sm" variant="secondary" onClick={() => setChosen(chosen.filter((_, j) => j !== i))}>Remove</Button>
                  </div>
                ))}
                <p className="text-xs text-slate-500">Products are carried at R0 (quantity only). Free stock is re-checked live in Cin7 when you create the project.</p>
              </div>
            )}
          </div>
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
          <Button disabled={busy || !ready} onClick={create}>Create disposable P0 project</Button>
        </div>
      )}
    </Panel>
  );
}
