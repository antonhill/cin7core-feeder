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
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Checkbox";
import { Alert } from "@/components/ui/Alert";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/Table";
import { Panel, PanelTitle } from "@/components/ui/Panel";

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

      <Panel className="mt-6">
        <PanelTitle>Notification settings</PanelTitle>

        {settings === null ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> Loading…
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-4">
            <Checkbox
              label="Send Ship By change emails for this org"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-slate-700">CC list (one email per line)</span>
              <textarea
                value={ccText}
                onChange={(e) => setCcText(e.target.value)}
                rows={4}
                placeholder="procurement@example.com"
                className="w-full max-w-md rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
              />
            </label>

            <Input
              type="number"
              min={0}
              label="Debounce window (minutes)"
              helperText="Multiple date changes to the same order within this window collapse into one email carrying the final date."
              value={debounceMinutes}
              onChange={(e) => setDebounceMinutes(Math.max(0, Number(e.target.value) || 0))}
              className="w-24"
            />

            <div className="flex items-center gap-3">
              <Button onClick={handleSaveSettings} disabled={!dirty} loading={isSavingSettings}>
                {isSavingSettings ? "Saving…" : "Save"}
              </Button>
              {savedOk && !dirty && <span className="text-sm text-success">Saved.</span>}
            </div>
            {settingsError && <Alert tone="danger">{settingsError}</Alert>}
          </div>
        )}
      </Panel>

      <Panel className="mt-6">
        <PanelTitle>Sales rep → email mapping</PanelTitle>
        <p className="mt-1 text-sm text-slate-500">
          Cin7&rsquo;s own sales rep field isn&rsquo;t always an email address — map each rep name to where their
          notifications should go.
        </p>

        {reps === null ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> Loading…
          </div>
        ) : (
          <>
            {reps.length === 0 ? (
              <p className="mt-4 text-sm text-slate-500">No mappings yet.</p>
            ) : (
              <div className="mt-4 max-w-xl">
                <Table>
                  <THead>
                    <tr>
                      <TH>Rep name (from Cin7)</TH>
                      <TH>Email</TH>
                      <TH align="right"></TH>
                    </tr>
                  </THead>
                  <TBody>
                    {reps.map((rep) => (
                      <TR key={rep.repName}>
                        <TD>{rep.repName}</TD>
                        <TD>{rep.email}</TD>
                        <TD align="right">
                          <Button
                            variant="link"
                            onClick={() => handleDeleteRep(rep.repName)}
                            disabled={isSavingRep}
                            loading={pendingDeleteRep === rep.repName}
                            className="text-danger"
                          >
                            Remove
                          </Button>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-end gap-3">
              <div>
                <Input
                  type="text"
                  list="known-sales-reps"
                  label="Rep name"
                  value={newRepName}
                  onChange={(e) => setNewRepName(e.target.value)}
                  placeholder="e.g. Wayne Roberts"
                  className="w-52"
                />
                <datalist id="known-sales-reps">
                  {unmappedRepNames.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </div>
              <Input
                type="email"
                label="Email"
                value={newRepEmail}
                onChange={(e) => setNewRepEmail(e.target.value)}
                placeholder="rep@example.com"
                className="w-52"
              />
              <Button
                onClick={handleAddRep}
                disabled={isSavingRep || !newRepName.trim() || !newRepEmail.trim()}
              >
                Add mapping
              </Button>
            </div>
            {repsError && (
              <div className="mt-2">
                <Alert tone="danger">{repsError}</Alert>
              </div>
            )}
          </>
        )}
      </Panel>

      <Panel className="mt-6">
        <PanelTitle>BOM alert</PanelTitle>
        <p className="mt-1 text-sm text-slate-500">
          When an order enters Authorised status and includes at least one assembly/BOM product, email your Warehouse
          Manager so assembly happens before picking — Cin7&rsquo;s own Pick Available flow doesn&rsquo;t print BOM
          lines. One alert per order.
        </p>

        {bomSettings === null ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> Loading…
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-4">
            <Checkbox
              label="Send BOM alert emails for this org"
              checked={bomEnabled}
              onChange={(e) => setBomEnabled(e.target.checked)}
            />

            <Input
              type="email"
              label="Warehouse Manager email"
              value={warehouseManagerEmail}
              onChange={(e) => setWarehouseManagerEmail(e.target.value)}
              placeholder="warehouse@example.com"
              className="max-w-md"
            />

            <div className="flex items-center gap-3">
              <Button onClick={handleSaveBomSettings} disabled={!bomDirty} loading={isSavingBomSettings}>
                {isSavingBomSettings ? "Saving…" : "Save"}
              </Button>
              {bomSavedOk && !bomDirty && <span className="text-sm text-success">Saved.</span>}
            </div>
            {bomSettingsError && <Alert tone="danger">{bomSettingsError}</Alert>}
          </div>
        )}
      </Panel>
    </main>
  );
}
