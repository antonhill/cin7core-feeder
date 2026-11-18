// BUDGET QUOTATION preview PDF. Authenticated, organisation-scoped, Rep / Estimator / Manager. Built from the SAVED draft; nothing is stored, recorded, issued or sent, so it can never be accepted or
// handed over. The PDF carries the provisional-pricing disclaimer on every page and no total while pricing is incomplete. Cost, SKU and margin never reach the model.
import { authoriseActor } from "@/app/newquip-grower/actor";
import { createServiceRoleClient } from "@/supabase/server";
import { previewBudgetPdf } from "@/lib/newquip-quotes/budget-quotation";

export const dynamic = "force-dynamic";
const H = { "Cache-Control": "private, no-store" };

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  let actor;
  try { actor = await authoriseActor(); } catch { return new Response("Not authorised", { status: 401, headers: H }); }
  if (!actor.roles.has("rep") && !actor.roles.has("estimator") && !actor.roles.has("manager")) return new Response("Not authorised", { status: 403, headers: H });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404, headers: H });
  try {
    const { bytes, prep } = await previewBudgetPdf(createServiceRoleClient(), actor.orgId, id, process.env);
    return new Response(Buffer.from(bytes), { status: 200, headers: { ...H, "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${prep.testMode ? "TEST-ONLY-" : ""}BUDGET-${prep.quoteRef}.pdf"`, "X-Content-Type-Options": "nosniff", "X-Budget-Draft-Ref": prep.model.quote.draftRef } });
  } catch (e) {
    return new Response(e instanceof Error ? e.message : "Preview unavailable", { status: 409, headers: H });
  }
}
