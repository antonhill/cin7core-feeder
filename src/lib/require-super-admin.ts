import { createSessionClient } from "@/supabase/server-session";
import { createServiceRoleClient } from "@/supabase/server";

/**
 * Throws unless the current session belongs to a super admin (Spark staff
 * managing every client org) — checked via the service-role client since
 * super_admins has no RLS policies exposing it to session-scoped clients.
 */
export async function requireSuperAdmin(): Promise<{ userId: string }> {
  const sessionClient = await createSessionClient();
  const {
    data: { user },
  } = await sessionClient.auth.getUser();
  if (!user) throw new Error("Not signed in.");

  const db = createServiceRoleClient();
  const { data, error } = await db.from("super_admins").select("user_id").eq("user_id", user.id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Not authorized.");

  return { userId: user.id };
}
