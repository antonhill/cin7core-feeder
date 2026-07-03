import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Session-aware Supabase client for server components/actions — reads the
 * logged-in user's session from cookies and respects RLS as that user
 * (unlike server.ts's service-role client, which bypasses RLS entirely).
 * Used to look up "who is logged in" and "which org do they belong to",
 * not for the app's actual data mutations (those stay on the service-role
 * client, gated by the org-membership check derived from this session).
 */
export async function createSessionClient() {
  const cookieStore = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component that can't set cookies — fine as
          // long as middleware.ts is also refreshing the session.
        }
      },
    },
  });
}
