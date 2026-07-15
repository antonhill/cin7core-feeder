import type { InstancePickerItem } from "@/actions/instances";

/**
 * Shared "which Cin7 instance(s)" checkbox list — replaces the near-identical
 * copies across Migrate/Import's push-target pickers and the 6 report pages'
 * view-filter pickers. Pure presentation, no hooks — same convention as
 * InstancePicker.tsx. Whether inactive instances ever appear is entirely up
 * to what the caller passes in: Migrate/Import already pass an active-only
 * list, so the "(inactive)" label never shows there; report pages pass the
 * full list, so it does.
 */
export function InstanceMultiPicker({
  instances,
  selectedIds,
  onToggle,
  onSelectAll,
  onClear,
  emptyMessage = "No instances connected.",
  wrap = false,
}: {
  instances: InstancePickerItem[];
  selectedIds: string[];
  onToggle: (id: string) => void;
  onSelectAll?: () => void;
  onClear?: () => void;
  emptyMessage?: string;
  wrap?: boolean;
}) {
  if (instances.length === 0) {
    return <p className="text-sm text-slate-400">{emptyMessage}</p>;
  }

  return (
    <div className={wrap ? "flex flex-wrap gap-x-4 gap-y-1.5" : "flex flex-col gap-1.5"}>
      {instances.map((inst) => (
        <label key={inst.id} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={selectedIds.includes(inst.id)}
            onChange={() => onToggle(inst.id)}
            className="h-4 w-4"
          />
          {inst.name} {!inst.active && <span className="text-slate-400">(inactive)</span>}
        </label>
      ))}
      {(onSelectAll || onClear) && (
        <div className="mt-1 flex gap-3 text-sm text-indigo-600">
          {onSelectAll && (
            <button type="button" onClick={onSelectAll} className="hover:underline">
              Select all
            </button>
          )}
          {onClear && (
            <button type="button" onClick={onClear} className="hover:underline">
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}
