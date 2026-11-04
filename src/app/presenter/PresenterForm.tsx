"use client";

import { useActionState } from "react";
import { presenterSignInAction, type PresenterResult } from "./actions";

export function PresenterForm() {
  const [state, action, pending] = useActionState<PresenterResult | null, FormData>(presenterSignInAction, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-sm font-medium">
        Access key
        <input name="key" type="password" autoComplete="off" required autoFocus className="rounded border border-slate-300 px-3 py-2" />
      </label>
      <button type="submit" disabled={pending} className="rounded bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">{pending ? "Signing in…" : "Start demonstration"}</button>
      {state && <p role="alert" className="text-sm text-red-700">{state.error}</p>}
    </form>
  );
}
