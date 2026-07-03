import { createClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase client using the service role key — bypasses RLS.
 * Never import this from client components.
 */
export function createServiceRoleClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
