// Browser helper: POST a multipart form to a SAME-ORIGIN NewQuip route and read its JSON answer. It is the only browser-side network call the evidence upload needs (a server action
// cannot carry files of this size). It never targets another origin and never talks to Cin7: the path must start with "/api/" and is checked here.
export async function postFormToOwnRoute(path: string, form: FormData): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
  if (!/^\/api\/[a-z0-9\-/]+$/i.test(path)) return { ok: false, error: "Invalid upload address." };
  const res = await fetch(path, { method: "POST", body: form, credentials: "same-origin" });
  try { return (await res.json()) as { ok: boolean; error?: string }; } catch { return { ok: false, error: res.status === 413 ? "The upload is too large." : "The upload failed." }; }
}
