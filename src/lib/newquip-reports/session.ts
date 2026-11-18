import "server-only";
// The ONE place the Reports routes obtain the database client and the authorised viewer. `authoriseActor` re-establishes the NewQuip organisation, module access and functional roles
// on every request (nothing is taken from the URL or the client), and the viewer carries only the organisation id the actor was authorised for.
import { createServiceRoleClient } from "@/supabase/server";
import { authoriseActor } from "@/app/newquip-grower/actor";
import type { ReportViewer } from "./service";

export async function reportSession(): Promise<{ db: ReturnType<typeof createServiceRoleClient>; viewer: ReportViewer }> {
  const a = await authoriseActor();
  return { db: createServiceRoleClient(), viewer: { orgId: a.orgId, email: a.email, roles: a.roles, canSeeCost: a.canSeeCost } };
}
