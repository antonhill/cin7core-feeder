"use client";

import { useEffect, useId, useRef } from "react";
import { Button } from "./Button";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** Right-aligned action row below the body — e.g. Cancel/Confirm buttons. */
  footer?: React.ReactNode;
}

/**
 * The one modal implementation for the app — replaces the three independent
 * hand-rolled `role="dialog"` overlays the Phase 1 audit found (Cin7
 * Instances, Shipping Calendar, Production Tracking), built on the native
 * `<dialog>` element rather than a div-and-portal reimplementation: focus
 * management, Escape-to-close, and top-layer stacking come from the
 * platform instead of being re-derived. `.showModal()`/`.close()` stay the
 * single source of truth for open state; the `open` prop only tells this
 * component which way to drive them, and `onClose` (native `close` event)
 * is what reports every path back — Escape, backdrop click, or an explicit
 * close — through the same channel.
 */
export function Dialog({ open, onClose, title, children, footer }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  function handleBackdropClick(e: React.MouseEvent<HTMLDialogElement>) {
    const el = ref.current;
    if (!el || e.target !== el) return;
    const rect = el.getBoundingClientRect();
    const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (!inside) el.close();
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={handleBackdropClick}
      aria-labelledby={titleId}
      className="w-full max-w-lg rounded-lg border border-slate-200 bg-white p-0 shadow-lg backdrop:bg-transparent"
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
        <h2 id={titleId} className="text-base font-semibold text-slate-900">
          {title}
        </h2>
        <button
          type="button"
          onClick={() => ref.current?.close()}
          aria-label="Close"
          className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className="h-5 w-5" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <div className="px-5 py-4 text-sm text-slate-700">{children}</div>
      {footer && <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4">{footer}</div>}
    </dialog>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" for a destructive/irreversible action, "warning" for a step-up-gated or otherwise consequential one — never invents a new color role, just picks between the two the app already treats as "needs a second look" (Phase 1 direction, Section H). */
  tone?: "danger" | "warning";
  confirmLoading?: boolean;
}

/**
 * Built as part of the reskin's shared Dialog primitive, per direction
 * decision #3 — not wired onto any live action in this branch. Diagnostics'
 * two unconfirmed Cin7-write buttons are the named follow-up candidate for a
 * separate, behaviourally-tested change.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "danger",
  confirmLoading = false,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button variant={tone === "danger" ? "destructive" : "primary"} onClick={onConfirm} loading={confirmLoading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex gap-3">
        <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${tone === "danger" ? "bg-danger-subtle text-danger" : "bg-warning-subtle text-warning"}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden>
            <path d="M12 9v4M12 17h.01" />
            <path d="M10.3 3.9 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
        </span>
        <div>{description}</div>
      </div>
    </Dialog>
  );
}
