"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ModuleHeader } from "@/app/ModuleHeader";
import { QUOTES_MODULE } from "@/app/module-nav";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { getCompanyProfileAction, saveCompanyProfileAction, type ProfileView } from "../document-actions";
import { PROFILE_LABELS, emptyProfile, type CompanyProfile } from "@/lib/newquip-quotes/company-profile";

// NewQuip's company details and quotation terms, printed on every customer quotation. Nothing is pre-filled by the application: a customer quotation cannot be issued
// or sent until every mandatory field is supplied. Each save is a new version; earlier versions (and the documents issued with them) are never changed.
const TEXT_FIELDS: Array<[keyof CompanyProfile, boolean]> = [["paymentTerms", true], ["deliveryInstallationConditions", true], ["termsAndConditions", true], ["acceptanceInstructions", true]];
const LINE_FIELDS: Array<keyof CompanyProfile> = ["brandName", "legalName", "registrationNumber", "vatNumber", "phone", "email", "website"];
const inputCls = "h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm";

export default function CompanyProfilePage() {
  const [view, setView] = useState<ProfileView | null>(null);
  const [p, setP] = useState<CompanyProfile>(emptyProfile());
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void getCompanyProfileAction().then((r) => { if (!live) return; if (r.ok && r.data) { setView(r.data); if (r.data.profile) setP(r.data.profile); } else setErr(r.error ?? "Could not load."); });
    return () => { live = false; };
  }, []);
  const set = <K extends keyof CompanyProfile>(k: K, v: CompanyProfile[K]) => setP((x) => ({ ...x, [k]: v }));
  const save = async () => {
    setBusy(true); setErr(null); setOk(null);
    const r = await saveCompanyProfileAction(p);
    setBusy(false);
    if (r.ok && r.data) { setView(r.data); setOk(`Saved as version ${r.data.version}.`); } else setErr(r.error ?? "Could not save.");
  };
  return (
    <main className="mx-auto max-w-4xl space-y-4 p-4">
      <ModuleHeader module={QUOTES_MODULE}>Company details and quotation terms</ModuleHeader>
      <Link href="/newquip-grower" className="text-sm text-indigo-700 hover:underline">Back to quotes</Link>
      {err && <Alert tone="danger">{err}</Alert>}
      {ok && <Alert tone="success">{ok}</Alert>}
      {view && !view.available && <Alert tone="info">This becomes available once the database update for customer quotations (migration 0115) has been applied.</Alert>}
      {view?.available && view.missing.length > 0 && <Alert tone="warning">Customer quotations cannot be issued until these are supplied: {view.missing.join(", ")}.</Alert>}
      {view?.available && (
        <Panel>
          <PanelTitle>{view.version ? `Current version ${view.version}` : "No details saved yet"}</PanelTitle>
          <fieldset disabled={!view.canEdit} className="mt-4 space-y-4 border-0 p-0">
            <div className="grid gap-4 md:grid-cols-2">
              {LINE_FIELDS.map((k) => (
                <label key={k} className="flex flex-col gap-1 text-sm"><span className="font-medium text-slate-700">{PROFILE_LABELS[k]}</span>
                  <input className={inputCls} value={String(p[k] ?? "")} onChange={(e) => set(k, e.target.value as never)} /></label>
              ))}
              <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-slate-700">{PROFILE_LABELS.validityDays}</span>
                <input className={inputCls} inputMode="numeric" value={p.validityDays ? String(p.validityDays) : ""} onChange={(e) => set("validityDays", Number(e.target.value.replace(/\D/g, "")))} /></label>
            </div>
            <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-slate-700">{PROFILE_LABELS.addressLines} (one line per row, at least two)</span>
              <textarea className="min-h-20 rounded-md border border-slate-300 p-2 text-sm" value={p.addressLines.join("\n")} onChange={(e) => set("addressLines", e.target.value.split("\n"))} /></label>
            {TEXT_FIELDS.map(([k]) => (
              <label key={k} className="flex flex-col gap-1 text-sm"><span className="font-medium text-slate-700">{PROFILE_LABELS[k]}</span>
                <textarea className="min-h-28 rounded-md border border-slate-300 p-2 text-sm" value={String(p[k] ?? "")} onChange={(e) => set(k, e.target.value as never)} /></label>
            ))}
            {view.canEdit ? <Button type="button" onClick={() => void save()} loading={busy}>Save as a new version</Button> : <p className="text-sm text-slate-500">Only a Manager can change these details.</p>}
          </fieldset>
        </Panel>
      )}
    </main>
  );
}
