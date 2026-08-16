"use client";

import { useMemo } from "react";
import { ORDER_FULFILLMENT_EXPORT_COLUMNS, DEFAULT_ORDER_FULFILLMENT_EXPORT_COLUMN_KEYS } from "@/reports/order-fulfillment-export-columns";

/**
 * P5.5 (LBL brief): column-picker for Order Fulfillment's "Export to Excel"
 * — same modal-overlay pattern as this page's own Batch Pick List modal.
 * `selectedKeys` is the page's live selection (checking a box takes effect
 * on the very next export immediately); `onSave` persists it as the user's
 * default via a server action, separate from just closing the picker.
 */
export function ExportColumnPicker({
  selectedKeys,
  onToggle,
  onReset,
  onSave,
  isSaving,
  saveError,
  onClose,
}: {
  selectedKeys: Set<string>;
  onToggle: (key: string) => void;
  onReset: () => void;
  onSave: () => void;
  isSaving: boolean;
  saveError: string | null;
  onClose: () => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, typeof ORDER_FULFILLMENT_EXPORT_COLUMNS>();
    for (const col of ORDER_FULFILLMENT_EXPORT_COLUMNS) {
      const existing = map.get(col.group);
      if (existing) existing.push(col);
      else map.set(col.group, [col]);
    }
    return map;
  }, []);

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50" onClick={onClose}>
      <div className="mx-auto my-8 max-w-3xl rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Export columns</h2>
            <p className="mt-1 text-sm text-slate-500">
              Choose which columns Export to Excel includes. &ldquo;Save as my default&rdquo; remembers this for you, on this
              org, next time you visit.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Close
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {[...groups.entries()].map(([group, cols]) => (
            <div key={group} className="rounded-lg border border-slate-200 p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{group}</p>
              <div className="flex flex-col gap-1.5">
                {cols.map((col) => (
                  <label key={col.key} className="flex items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" checked={selectedKeys.has(col.key)} onChange={() => onToggle(col.key)} className="h-4 w-4" />
                    {col.label}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>

        <p className="mt-4 text-xs text-slate-400">{selectedKeys.size} of {ORDER_FULFILLMENT_EXPORT_COLUMNS.length} columns selected.</p>
        {saveError && <p className="mt-2 text-sm text-red-600">{saveError}</p>}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
          <button type="button" onClick={onReset} className="text-sm font-medium text-indigo-600 hover:underline">
            Reset to default ({DEFAULT_ORDER_FULFILLMENT_EXPORT_COLUMN_KEYS.length} columns)
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={isSaving}
            className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {isSaving ? "Saving…" : "Save as my default"}
          </button>
        </div>
      </div>
    </div>
  );
}
