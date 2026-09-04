"use client";

import { useMemo } from "react";
import { ORDER_FULFILLMENT_EXPORT_COLUMNS, DEFAULT_ORDER_FULFILLMENT_EXPORT_COLUMN_KEYS } from "@/reports/order-fulfillment-export-columns";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Alert } from "@/components/ui/Alert";

/**
 * P5.5 (LBL brief): column-picker for Order Fulfillment's "Export to Excel".
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
    <Dialog
      open
      onClose={onClose}
      title="Export columns"
      footer={
        <>
          <Button variant="link" onClick={onReset}>
            Reset to default ({DEFAULT_ORDER_FULFILLMENT_EXPORT_COLUMN_KEYS.length} columns)
          </Button>
          <Button onClick={onSave} loading={isSaving}>
            Save as my default
          </Button>
        </>
      }
    >
      <p className="mb-4 text-sm text-slate-500">
        Choose which columns Export to Excel includes. &ldquo;Save as my default&rdquo; remembers this for you, on this org,
        next time you visit.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {[...groups.entries()].map(([group, cols]) => (
          <div key={group} className="rounded-md border border-slate-200 p-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{group}</p>
            <div className="flex flex-col gap-1.5">
              {cols.map((col) => (
                <Checkbox key={col.key} label={col.label} checked={selectedKeys.has(col.key)} onChange={() => onToggle(col.key)} />
              ))}
            </div>
          </div>
        ))}
      </div>

      <p className="mt-4 text-xs text-slate-400">
        {selectedKeys.size} of {ORDER_FULFILLMENT_EXPORT_COLUMNS.length} columns selected.
      </p>
      {saveError && (
        <div className="mt-2">
          <Alert tone="danger">{saveError}</Alert>
        </div>
      )}
    </Dialog>
  );
}
