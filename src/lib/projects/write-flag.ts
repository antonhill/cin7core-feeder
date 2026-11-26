// The single, pure decision for "are Cin7 writes enabled on THIS deployment", plus the Supabase-project check P0 and the writers share.
// Used by every Cin7-writing Server Action.
//
//  * OFF unless NEWQUIP_CIN7_WRITES_ENABLED is exactly the string "true" (any other value, including "TRUE", "1", "yes", is OFF).
//  * ON ONLY on (a) a Vercel PREVIEW deployment (VERCEL_ENV === "preview"), or (b) the dedicated NewQuip UAT deployment: VERCEL_ENV === "production" AND
//    CIN7_CREDENTIAL_STORE === "uat" (that deployment reads and writes ONLY the separate UAT credential column, which exists for the NewQuip POC test organisation alone).
//    Any other Production deployment (no CIN7_CREDENTIAL_STORE=uat), a local run (`next dev`/`next start`), a test runner or an unset/unknown value are
//    ALWAYS OFF whatever the variable says. Added 2026-11-26 on the owner's explicit authorisation to run the connected Advanced Sale test on the UAT organisation.
//  * ALWAYS OFF unless the deployment is wired to the required Supabase project (below). A Preview that inherited the wrong database
//    cannot write to Cin7 even if the flag is on. Fails closed: an unreadable or missing URL is a mismatch.

/** The hosted Supabase project ("cin7toolbox") that holds the NewQuip POC organisation. */
export const NEWQUIP_REQUIRED_SUPABASE_REF = "pnzwjqjovxxdikxtfngq";

/** The project ref in a `https://<ref>.supabase.co` URL, or null when the value is not that shape. Never returns any other part of the URL. */
export function supabaseProjectRef(url: string | undefined): string | null {
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec((url ?? "").trim());
  return m ? m[1] : null;
}

export interface SupabaseWiring { ok: boolean; serverRef: string | null; publicRef: string | null; detail: string }

/** Both the server URL and the public URL must point at the required project. */
export function supabaseWiring(env: Record<string, string | undefined>): SupabaseWiring {
  const serverRef = supabaseProjectRef(env.SUPABASE_URL);
  const publicRef = supabaseProjectRef(env.NEXT_PUBLIC_SUPABASE_URL);
  const ok = serverRef === NEWQUIP_REQUIRED_SUPABASE_REF && publicRef === NEWQUIP_REQUIRED_SUPABASE_REF;
  const show = (r: string | null) => (r === null ? "missing or unreadable" : r === NEWQUIP_REQUIRED_SUPABASE_REF ? "required project" : `a different project (${r})`);
  return { ok, serverRef, publicRef, detail: `SUPABASE_URL: ${show(serverRef)}; NEXT_PUBLIC_SUPABASE_URL: ${show(publicRef)}` };
}

export function cin7WritesEnabled(env: Record<string, string | undefined>): boolean {
  const preview = env.VERCEL_ENV === "preview";
  const uatDeployment = env.VERCEL_ENV === "production" && env.CIN7_CREDENTIAL_STORE === "uat"; // both required; one flag set by mistake is not enough
  if (!preview && !uatDeployment) return false;     // every other Production, local and unknown environment never writes
  if (!supabaseWiring(env).ok) return false;
  return env.NEWQUIP_CIN7_WRITES_ENABLED === "true";
}
