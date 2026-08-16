"use client";

import { useEffect, useState, useTransition } from "react";
import {
  getShipByNotificationSettingsAction,
  saveShipByNotificationSettingsAction,
  listShipByNotificationRepsAction,
  listKnownSalesRepsAction,
  saveShipByNotificationRepAction,
  deleteShipByNotificationRepAction,
  getBomAlertSettingsAction,
  saveBomAlertSettingsAction,
  type ShipByNotificationSettings,
  type RepMapping,
  type BomAlertSettings,
} from "./actions";
import { ModuleHeader } from "@/app/ModuleHeader";
import { NOTIFICATIONS_MODULE } from "@/app/module-nav";
import { Spinner } from "@/app/Spinner";

function ccEmailsToText(emails: string[]): string {
  return emails.join("\n");
}

function textToCcEmails(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((e) => e.trim()).filter(Boolean))];
}

export default function NotificationsSettingsPage() {
  const [settings, setSettings] = useState<ShipByNotificationSettings | null>(null);
  const [ccText, setCcText] = useState("");
  const [debounceMinutes, setDebounceMinutes] = useState(15);
  const [enabled, setEnabled] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [isSavingSettings, startSaveSettingsTransition] = useTransition();
  const [savedOk, setSavedOk] = useState(false);

  const [reps, setReps] = useState<RepMapping[] | null>(null);
  const [knownRepNames, setKnownRepNames] = useState<string[]>([]);
  const [newRepName, setNewRepName] = useState("");
  const [newRepEmail, setNewRepEmail] = useState("");
  const [repsError, setRepsError] = useState<string | null>(null);
  const [isSavingRep, startSaveRepTransition] = useTransition();
  const [pendingDeleteRep, setPendingDeleteRep] = useState<string | null>(null);

  const [bomSettings, setBomSettings] = useState<BomAlertSettings | null>(null);
  const [bomEnabled, setBomEnabled] = useState(false);
  const [warehouseManagerEmail, setWarehouseManagerEmail] = useState("");
  const [bomSettingsError, setBomSettingsError] = useState<string | null>(null);
  const [isSavingBomSettings, startSaveBomSettingsTransition] = useTransition();
  const [bomSavedOk, setBomSavedOk] = useState(false);

  useEffect(() => {
    getShipByNotificationSettingsAction().then((result) => {
      if (!result.ok || !result.data) {
        setSettingsError(result.error ?? "Unknown error");
        return;
      }
      setSettings(result.data);
      setEnabled(result.data.enabled);
      setCcText(ccEmailsToText(result.data.ccEmails));
      setDebounceMinutes(result.data.debounceMinutes);
    });
    listShipByNotificationRepsAction().then((result) => {
      if (result.ok) setReps(result.data ?? []);
      else setRepsError(result.error ?? "Unknown error");
    });
    listKnownSalesRepsAction().then((result) => {
      if (result.ok) setKnownRepNames(result.data ?? []);
    });
    getBomAlertSettingsAction().then((result) => {
      if (!result.ok || !result.data) {
        setBomSettingsError(result.error ?? "Unknown error");
        return;
      }
      setBomSettings(result.data);
      setBomEnabled(result.data.enabled);
      setWarehouseManagerEmail(result.data.warehouseManagerEmail);
    });
  }, []);

  const dirty =
    settings !== null &&
    (enabled !== settings.enabled ||
      debounceMinutes !== settings.debounceMinutes ||
      ccText !== ccEmailsToText(settings.ccEmails));

  function handleSaveSettings() {
    setSettingsError(null);
    setSavedOk(false);
    startSaveSettingsTransition(async () => {
      const next: ShipByNotificationSettings = { enabled, ccEmails: textToCcEmails(ccText), debounceMinutes };
      const result = await saveShipByNotificationSettingsAction(next);
      if (!result.ok) {
        setSettingsError(result.error ?? "Unknown error");
        return;
      }
      setSettings(next);
      setSavedOk(true);
    });
  }

  function handleAddRep() {
    if (!newRepName.trim() || !newRepEmail.trim()) return;
    setRepsError(null);
    startSaveRepTransition(async () => {
      const result = await saveShipByNotificationRepAction(newRepName.trim(), newRepEmail.trim());
      if (!result.ok) {
        setRepsError(result.error ?? "Unknown error");
        return;
      }
      setReps((prev) => {
        const withoutExisting = (prev ?? []).filter((r) => r.repName !== newRepName.trim());
        return [...withoutExisting, { repName: newRepName.trim(), email: newRepEmail.trim() }].sort((a, b) => a.repName.localeCompare(b.repName));
      });
      setNewRepName("");
      setNewRepEmail("");
    });
  }

  function handleDeleteRep(repName: string) {
    setRepsError(null);
    setPendingDeleteRep(repName);
    startSaveRepTransition(async () => {
      const result = await deleteShipByNotificationRepAction(repName);
      setPendingDeleteRep(null);
      if (!result.ok) {
        setRepsError(result.error ?? "Unknown error");
        return;
      }
      setReps((prev) => (prev ?? []).filter((r) => r.repName !== repName));
    });
  }

  const unmappedRepNames = knownRepNames.filter((name) => !(reps ?? []).some((r) => r.repName === name));

  const bomDirty =
    bomSettings !== null && (bomEnabled !== bomSettings.enabled || warehouseManagerEmail !== bomSettings.warehouseManagerEmail);

  function handleSaveBomSettings() {
    setBomSettingsError(null);
    setBomSavedOk(false);
    startSaveBomSettingsTransition(async () => {
      const next: BomAlertSettings = { enabled: bomEnabled, warehouseManagerEmail: warehouseManagerEmail.trim() };
      const result = await saveBomAlertSettingsAction(next);
      if (!result.ok) {
        setBomSettingsError(result.error ?? "Unknown error");
        return;
      }
      setBomSettings(next);
      setBomSavedOk(true);
    });
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <ModuleHeader module={NOTIFICATIONS_MODULE}>
        When a Ship By date changes via the Toolbox (either calendar&rsquo;s drag or Move to), email the order&rsquo;s
        sales rep plus this CC list. Off by default — a deliverability test against your real mail ingress should
        happen before turning this on.
      </ModuleHeader>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="font-medium text-slate-900">Notification settings</p>

        {settings === null ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-slate-400">
            <Spinner /> Loading…
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-4">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
              Send Ship By change emails for this org
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-slate-700">CC list (one email per line)</span>
              <textarea
                value={ccText}
                onChange={(e) => setCcText(e.target.value)}
                rows={4}
                placeholder="procurement@example.com"
                className="w-full max-w-md rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-slate-700">Debounce window (minutes)</span>
              <span className="text-xs text-slate-400">
                Multiple date changes to the same order within this window collapse into one email carrying the final date.
              </span>
              <input
                type="number"
                min={0}
                value={debounceMinutes}
                onChange={(e) => setDebounceMinutes(Math.max(0, Number(e.target.value) || 0))}
                className="w-24 rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </label>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleSaveSettings}
                disabled={isSavingSettings || !dirty}
                className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {isSavingSettings && <Spinner className="mr-1.5" />}
                {isSavingSettings ? "Saving…" : "Save"}
              </button>
              {savedOk && !dirty && <span className="text-sm text-emerald-600">Saved.</span>}
            </div>
            {settingsError && <p className="text-sm text-rose-600">{settingsError}</p>}
          </div>
        )}
      </section>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="font-medium text-slate-900">Sales rep → email mapping</p>
        <p className="mt-1 text-sm text-slate-500">
          Cin7&rsquo;s own sales rep field isn&rsquo;t always an email address — map each rep name to where their
          notifications should go.
        </p>

        {reps === null ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-slate-400">
            <Spinner /> Loading…
          </div>
        ) : (
          <>
            <table className="mt-4 w-full max-w-xl text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-1.5 pr-4">Rep name (from Cin7)</th>
                  <th className="py-1.5 pr-4">Email</th>
                  <th className="py-1.5" />
                </tr>
              </thead>
              <tbody>
                {reps.map((rep) => (
                  <tr key={rep.repName} className="border-b border-slate-100">
                    <td className="py-1.5 pr-4">{rep.repName}</td>
                    <td className="py-1.5 pr-4">{rep.email}</td>
                    <td className="py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => handleDeleteRep(rep.repName)}
                        disabled={isSavingRep}
                        className="text-xs font-medium text-rose-600 hover:underline disabled:opacity-50"
                      >
                        {pendingDeleteRep === rep.repName ? <Spinner className="h-3 w-3" /> : "Remove"}
                      </button>
                    </td>
                  </tr>
                ))}
                {reps.length === 0 && (
                  <tr>
                    <td colSpan={3} className="py-2 text-slate-400">
                      No mappings yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            <div className="mt-4 flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                Rep name
                <input
                  type="text"
                  list="known-sales-reps"
                  value={newRepName}
                  onChange={(e) => setNewRepName(e.target.value)}
                  placeholder="e.g. Wayne Roberts"
                  className="w-52 rounded border border-slate-300 px-2 py-1 text-sm"
                />
                <datalist id="known-sales-reps">
                  {unmappedRepNames.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                Email
                <input
                  type="email"
                  value={newRepEmail}
                  onChange={(e) => setNewRepEmail(e.target.value)}
                  placeholder="rep@example.com"
                  className="w-52 rounded border border-slate-300 px-2 py-1 text-sm"
                />
              </label>
              <button
                type="button"
                onClick={handleAddRep}
                disabled={isSavingRep || !newRepName.trim() || !newRepEmail.trim()}
                className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                Add mapping
              </button>
            </div>
            {repsError && <p className="mt-2 text-sm text-rose-600">{repsError}</p>}
          </>
        )}
      </section>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="font-medium text-slate-900">BOM alert</p>
        <p className="mt-1 text-sm text-slate-500">
          When an order enters Authorised status and includes at least one assembly/BOM product, email your Warehouse
          Manager so assembly happens before picking — Cin7&rsquo;s own Pick Available flow doesn&rsquo;t print BOM
          lines. One alert per order.
        </p>

        {bomSettings === null ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-slate-400">
            <Spinner /> Loading…
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-4">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={bomEnabled}
                onChange={(e) => setBomEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300"
              />
              Send BOM alert emails for this org
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-slate-700">Warehouse Manager email</span>
              <input
                type="email"
                value={warehouseManagerEmail}
                onChange={(e) => setWarehouseManagerEmail(e.target.value)}
                placeholder="warehouse@example.com"
                className="w-full max-w-md rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </label>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleSaveBomSettings}
                disabled={isSavingBomSettings || !bomDirty}
                className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {isSavingBomSettings && <Spinner className="mr-1.5" />}
                {isSavingBomSettings ? "Saving…" : "Save"}
              </button>
              {bomSavedOk && !bomDirty && <span className="text-sm text-emerald-600">Saved.</span>}
            </div>
            {bomSettingsError && <p className="text-sm text-rose-600">{bomSettingsError}</p>}
          </div>
        )}
      </section>
    </main>
  );
}
