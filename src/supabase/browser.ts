"use client";

import { createBrowserClient } from "@supabase/ssr";

/** Session-aware Supabase client for client components — used only for auth (magic link sign-in), never for data queries. */
export function createBrowserSupabaseClient() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}
