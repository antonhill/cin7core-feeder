"use client";

import { useEffect, useState, useTransition } from "react";
import { getUatCredentialStatus, saveUatCin7Key, testUatCin7Connection, type UatCredentialStatus } from "./actions";

export default function UatCredentialsPage() {
  const [status, setStatus] = useState<UatCredentialStatus | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const refresh = () => start(async () => setStatus(await getUatCredentialStatus()));
  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main className="mx-auto max-w-xl p-6" data-testid="uat-credentials">
      <h1 className="text-xl font-semibold">NewQuip UAT: Cin7 Application Key</h1>
      <p className="mt-2 text-sm text-slate-600">UAT environment only. The key is stored separately from the Toolbox credential and is never displayed. Spark super-admins only (two-factor required).</p>
      {status && !status.ok && <p role="alert" className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800" data-testid="uat-error">{status.error}</p>}
      {status?.ok && (
        <>
          <p className="mt-4 text-sm" data-testid="uat-status">Instance <strong>{status.instanceName}</strong> (Account ID {status.accountId}): UAT key {status.configured ? "saved" : "not saved yet"}.</p>
          <form
            className="mt-4 space-y-3"
            onSubmit={(ev) => {
              ev.preventDefault();
              const form = ev.currentTarget;
              const value = String(new FormData(form).get("applicationKey") ?? "");
              start(async () => {
                const r = await saveUatCin7Key(value);
                setMessage({ ok: r.ok, text: r.message });
                if (r.ok) form.reset();
                setStatus(await getUatCredentialStatus());
              });
            }}
          >
            <label className="block text-sm font-medium" htmlFor="applicationKey">Cin7 Application Key</label>
            <input id="applicationKey" name="applicationKey" type="password" autoComplete="off" spellCheck={false} required className="w-full rounded border p-2" />
            <button type="submit" disabled={pending} className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">Save key</button>
          </form>
          <button type="button" disabled={pending || !status.configured} className="mt-4 rounded border px-4 py-2 text-sm disabled:opacity-50" data-testid="uat-test"
            onClick={() => start(async () => { const r = await testUatCin7Connection(); setMessage({ ok: r.ok, text: r.message }); })}>
            Test connection (read-only)
          </button>
        </>
      )}
      {message && <p role="status" className={`mt-4 text-sm ${message.ok ? "text-green-700" : "text-red-700"}`} data-testid="uat-message">{message.text}</p>}
    </main>
  );
}
