/**
 * Drag-to-resize table columns — first built for Order Fulfillment's main
 * table. Uses a <colgroup> (not per-cell width styles) so table-layout:
 * fixed only needs the widths set in one place; every <th>/<td> in a
 * resizable table should still get its own `overflow-hidden` so oversized
 * content clips at the column boundary instead of bleeding into the next
 * column when a user drags a column narrower than its content.
 */

import { useCallback, useEffect, useRef, useState } from "react";

const MIN_COLUMN_WIDTH = 60;

export function useResizableColumns<TColumn extends string>(defaultWidths: Record<TColumn, number>) {
  const [widths, setWidths] = useState(defaultWidths);
  const dragRef = useRef<{ column: TColumn; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    function handleMouseMove(e: MouseEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const delta = e.clientX - drag.startX;
      setWidths((prev) => ({ ...prev, [drag.column]: Math.max(MIN_COLUMN_WIDTH, drag.startWidth + delta) }));
    }
    function handleMouseUp() {
      dragRef.current = null;
    }
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  const startResize = useCallback(
    (column: TColumn) => (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { column, startX: e.clientX, startWidth: widths[column] };
    },
    [widths]
  );

  return { widths, startResize };
}

/** One <col> per column, in the same order as the table's own <th>s — table-layout: fixed reads widths from here, not from individual header/body cells. */
export function ColGroup<TColumn extends string>({ columns, widths }: { columns: TColumn[]; widths: Record<TColumn, number> }) {
  return (
    <colgroup>
      {columns.map((c) => (
        <col key={c} style={{ width: widths[c] }} />
      ))}
    </colgroup>
  );
}

export function ResizableTh<TColumn extends string>({
  column,
  label,
  align = "left",
  onResizeStart,
}: {
  column: TColumn;
  label: string;
  align?: "left" | "right";
  onResizeStart: (column: TColumn) => (e: React.MouseEvent) => void;
}) {
  return (
    <th className={`relative overflow-hidden py-2 pr-4 ${align === "right" ? "text-right" : "text-left"}`}>
      <span className="block truncate">{label}</span>
      <div
        onMouseDown={onResizeStart(column)}
        className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none hover:bg-indigo-300 active:bg-indigo-400"
      />
    </th>
  );
}
