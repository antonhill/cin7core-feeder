// A visible, programmatically-linked explanation for a disabled control. Render it beside the control and point the control's aria-describedby at `id`.
// Renders nothing when there is no reason (the control is enabled). Text is slate-700 on white (well over 4.5:1) so it stays legible next to a muted disabled button.
export function DisabledReason({ id, children, testId }: { id: string; children: React.ReactNode; testId?: string }) {
  if (!children) return null;
  return <p id={id} data-testid={testId ?? id} className="text-xs text-slate-700">{children}</p>;
}
