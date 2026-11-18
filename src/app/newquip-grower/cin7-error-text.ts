// Plain wording for a Cin7 failure shown in the cost panel (pure). Cin7 can answer with a JSON body ({"Exception":"..."}) or a stack trace; neither is shown to a person. Presentation only: the action,
// its result and the error it returned are untouched.
const KEYS = ["Exception", "ExceptionMessage", "Message", "message", "error", "Error", "Description"];

function messageOf(raw: string): string | null {
  const t = raw.trim();
  const json = t.indexOf("{");
  if (json < 0) return null;
  try {
    const o = JSON.parse(t.slice(json)) as Record<string, unknown>;
    for (const k of KEYS) { const v = o?.[k]; if (typeof v === "string" && v.trim()) return v.trim(); }
    return "Cin7 did not accept the request";
  } catch { return null; }
}

/** `raw` unchanged when it is already a plain sentence; otherwise "Could not read costs from Cin7: <plain message>. Try again; nothing was changed." (never JSON, never a stack). */
export function friendlyCin7Error(raw: string): string {
  const stackLike = /\n\s+at\s+\S+|\bat\s+\S+\s+\(.*:\d+:\d+\)/.test(raw);
  const parsed = messageOf(raw);
  if (parsed == null && !stackLike) return raw;
  const first = (parsed ?? raw.split("\n")[0]).replace(/\s+/g, " ").replace(/\s*\{.*$/, "").trim().replace(/[.\s]+$/, "").slice(0, 200) || "Cin7 did not answer";
  return `Could not read costs from Cin7: ${first}. Try again; nothing was changed.`;
}
