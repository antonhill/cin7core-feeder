/**
 * Minimal terminal prompter with a NO-ECHO secret prompt. Streams are injected so it is testable and so this module never touches
 * `process`. Secrets are read from the terminal itself (raw mode), never from command-line arguments or environment variables, and
 * are never written to the output stream.
 */
export interface PromptInput { on(e: "data", f: (d: Buffer | string) => void): unknown; off?(e: "data", f: (d: Buffer | string) => void): unknown; removeListener?(e: "data", f: (d: Buffer | string) => void): unknown; resume?(): unknown; pause?(): unknown; isTTY?: boolean; setRawMode?(on: boolean): unknown }
export interface PromptOutput { write(s: string): unknown }
export interface Prompter { ask(q: string): Promise<string>; askHidden(q: string): Promise<string>; confirm(q: string): Promise<boolean>; close(): void }

interface Pending { hidden: boolean; acc: string; resolve(v: string): void; reject(e: Error): void }

export function createPrompter(s: { input: PromptInput; output: PromptOutput; allowNonTty?: boolean }): Prompter {
  let buf = "";
  let pending: Pending | null = null;
  const onData = (d: Buffer | string) => { buf += String(d); drain(); };
  s.input.on("data", onData);
  s.input.resume?.();

  function finish(p: Pending, ok: boolean, v: string | Error): void {
    pending = null;
    if (p.hidden) s.input.setRawMode?.(false);
    if (ok) p.resolve(v as string); else p.reject(v as Error);
  }
  function drain(): void {
    while (pending && buf.length > 0) {
      const p = pending;
      const ch = buf[0];
      buf = buf.slice(1);
      if (ch === "\u0003" || ch === "\u0004") { s.output.write("\n"); finish(p, false, new Error("Setup cancelled.")); return; }
      if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && buf[0] === "\n") buf = buf.slice(1);
        if (p.hidden) s.output.write("\n"); // the terminal does not echo the Enter key in raw mode
        finish(p, true, p.acc);
        return;
      }
      if (ch === "\u007f" || ch === "\b") { p.acc = p.acc.slice(0, -1); continue; }
      p.acc += ch;
    }
  }
  function start(q: string, hidden: boolean): Promise<string> {
    if (pending) return Promise.reject(new Error("A prompt is already waiting for input."));
    if (hidden && !s.allowNonTty && !(s.input.isTTY && typeof s.input.setRawMode === "function")) return Promise.reject(new Error("Secrets can only be entered at an interactive terminal (no piped input)."));
    s.output.write(q);
    return new Promise<string>((resolve, reject) => {
      pending = { hidden, acc: "", resolve, reject };
      if (hidden) s.input.setRawMode?.(true);
      drain();
    });
  }
  return {
    ask: (q) => start(q, false),
    askHidden: (q) => start(q, true),
    confirm: async (q) => /^(y|yes)$/i.test((await start(q, false)).trim()),
    close: () => { (s.input.off ?? s.input.removeListener)?.call(s.input, "data", onData); s.input.pause?.(); },
  };
}
