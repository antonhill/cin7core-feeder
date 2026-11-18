// BUDGET vs FINAL variance (INTERNAL, cost-bearing). Estimator / Manager with cost visibility only: a Rep is refused (403) and receives nothing. Read-only; nothing is stored or changed.
import { authoriseActor } from "@/app/newquip-grower/actor";
import { createServiceRoleClient } from "@/supabase/server";
import { loadBudgetVariance } from "@/lib/newquip-quotes/budget-variance-store";
import { supabaseStorage } from "@/lib/newquip-quotes/document-store";

export const dynamic = "force-dynamic";
const H = { "Cache-Control": "private, no-store", "Content-Type": "application/json" };

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  let actor;
  try { actor = await authoriseActor(); } catch { return new Response(JSON.stringify({ error: "Not authorised" }), { status: 401, headers: H }); }
  if (!actor.canSeeCost || !(actor.roles.has("estimator") || actor.roles.has("manager"))) return new Response(JSON.stringify({ error: "Not authorised" }), { status: 403, headers: H });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers: H });
  try {
    const db = createServiceRoleClient();
    return new Response(JSON.stringify(await loadBudgetVariance(db, actor.orgId, id, supabaseStorage(db))), { status: 200, headers: H });
  } catch (e) { return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unavailable" }), { status: 409, headers: H }); }
}
