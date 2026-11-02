import { guardRequest } from "@/rwtsa-demo/state/host-guard";
import { applyPlannerForm } from "@/rwtsa-demo/state/planner-form";
import { getDemoState } from "./state";
import { stateDir } from "./exclusions";
import { safeReturnTo } from "./exclusion-route";

/**
 * POST /api/planner: records or reverses a planner decision in the local state file, then redirects back to Scenario A.
 * Same-origin only (defence in depth behind the proxy). It never creates or authorises a purchase order anywhere and never touches
 * the workbook. The redirect target is always this app's Scenario A page.
 */
function redirect(returnTo: string, done: string): Response {
  const [path, query = ""] = returnTo.split("?", 2);
  const params = new URLSearchParams(query);
  params.set("done", done);
  return new Response(null, { status: 303, headers: { Location: `${path}?${params.toString()}#planner`, "Cache-Control": "no-store" } });
}

export async function handlePlannerPost(request: Request): Promise<Response> {
  if (!guardRequest("POST", request.headers).ok) return new Response("Cross-origin request refused.", { status: 403 });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response("Bad request.", { status: 400 });
  }
  const str = (k: string): string | null => {
    const v = form.get(k);
    return typeof v === "string" ? v : null;
  };
  const returnTo = safeReturnTo(str("returnTo"));
  const state = await getDemoState();
  if (state.kind !== "validated" || state.dataset === null) return redirect(returnTo, "planner-invalid");
  const outcome = applyPlannerForm(stateDir(), state.summary.sourceLabel, state.dataset, {
    action: str("action"),
    sku: str("sku"),
    value: str("value"),
    reason: str("reason") ?? str("note"),
    replacement: str("replacement"),
    effectiveFrom: str("effectiveFrom"),
    expires: str("expires"),
    untilRemoved: str("untilRemoved") === "1",
    quantity: str("quantity"),
    calculated: str("calculated"),
    capacity: str("capacity"),
    leadTime: str("leadTime"),
    completionWeek: str("completionWeek"),
  });
  return redirect(returnTo, outcome);
}
