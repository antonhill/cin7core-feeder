import Link from "next/link";
import { Spinner } from "@/app/Spinner";
import type { UseInstancePickerResult } from "@/hooks/useInstancePicker";

/**
 * Shared "which Cin7 instance" control — replaces the ~11 near-identical
 * copies of button+select boilerplate that used to live in every report/tool
 * page. Fetching and auto-select decisions live in useInstancePicker; this
 * component is presentation-only (no hooks of its own), same convention as
 * Spinner/ModuleHeader.
 */
export function InstancePicker({
  selectableInstances,
  isLoading,
  error,
  instanceId,
  onChange,
  isAutoSelected,
  reload,
}: UseInstancePickerResult & { onChange: (id: string) => void }) {
  if (isLoading && selectableInstances.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        <Spinner className="mr-1.5" />
        Loading instances…
      </p>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-red-600">
        {error}{" "}
        <button type="button" onClick={reload} className="font-medium underline hover:no-underline">
          Retry
        </button>
      </p>
    );
  }

  if (selectableInstances.length === 0) {
    return (
      <p className="text-sm text-slate-400">
        No active instances connected —{" "}
        <Link href="/settings/instances" className="font-medium text-indigo-600 hover:underline">
          visit Settings
        </Link>{" "}
        to connect one.
      </p>
    );
  }

  if (isAutoSelected) {
    const name = selectableInstances.find((inst) => inst.id === instanceId)?.name ?? "—";
    return (
      <p className="text-sm text-slate-500">
        Instance: <span className="font-medium text-slate-700">{name}</span>
      </p>
    );
  }

  return (
    <select
      value={instanceId ?? ""}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
    >
      <option value="">Choose an instance…</option>
      {selectableInstances.map((inst) => (
        <option key={inst.id} value={inst.id}>
          {inst.name}
        </option>
      ))}
    </select>
  );
}
